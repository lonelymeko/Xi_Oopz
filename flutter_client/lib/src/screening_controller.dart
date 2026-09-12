import 'dart:async';

import 'package:video_player/video_player.dart';

import 'socket_client.dart';
import 'types.dart';

/// 放映室控制器 —— 对接后端 screening.* 信令，驱动 video_player 做多人同步播放。
///
/// 角色：
/// - **控制者**（state.controllerUserId == 我）：本地播放/暂停/拖动会广播给所有人，
///   并定时发 tick 让观众对齐进度。
/// - **观众**：收到广播的 state 后把本地播放器同步到相同进度/播放态，进度条只读。
///
/// 与 Web 端一致：视频是「直链」（mp4 / m3u8 等），后端只同步播放状态，不转发视频流。
class ScreeningController {
  static const Duration _tickInterval = Duration(seconds: 5);
  static const double _driftThresholdSeconds = 1.5; // 进度偏差超过此值才纠偏

  final SocketClient socket;
  final OopzUser Function() getCurrentUser;
  final void Function() onChanged; // 状态/播放列表/观众/播放器变化时通知 UI 重建
  final void Function(String message) onError;

  ScreeningController({
    required this.socket,
    required this.getCurrentUser,
    required this.onChanged,
    required this.onError,
  });

  int? _channelId;
  ScreeningState? _state;
  List<ScreeningViewer> _viewers = const [];
  List<ScreeningPlaylistItem> _playlist = const [];

  VideoPlayerController? _video;
  String _loadedUrl = '';
  bool _initializingVideo = false;
  Timer? _tickTimer;
  String _lastEndedItemId = ''; // 防止同一集重复上报 ended

  // 观众端本地单调时钟锚点（见 _syncViewerToState）：收到 state 时锚定一次，
  // 之后用本地流逝时间外推目标进度，完全不掺服务端/本机墙钟之差。
  final Stopwatch _clock = Stopwatch()..start();
  DateTime? _anchorUpdatedAt;
  int _anchorAtMs = 0;
  double _anchorTime = 0;
  double _anchorRate = 1;

  // ---- 对外只读 getter（UI 用）----
  int? get channelId => _channelId;
  ScreeningState? get state => _state;
  List<ScreeningViewer> get viewers => _viewers;
  List<ScreeningPlaylistItem> get playlist => _playlist;
  VideoPlayerController? get video => _video;

  bool get isController {
    final s = _state;
    if (s == null) return false;
    return s.controllerUserId == getCurrentUser().id;
  }

  bool get videoReady => _video?.value.isInitialized ?? false;

  // ---- 加入 / 离开 ----

  void join(int channelId) {
    _channelId = channelId;
    socket.send('screening.join', {'channelId': channelId});
  }

  Future<void> leave() async {
    final id = _channelId;
    if (id != null) {
      socket.send('screening.leave', {'channelId': id});
    }
    _tickTimer?.cancel();
    _tickTimer = null;
    await _disposeVideo();
    _resetAnchor();
    _channelId = null;
    _state = null;
    _viewers = const [];
    _playlist = const [];
  }

  // ---- 收到服务端事件（由 home_page 分发进来）----

  Future<void> handleEvent(String type, Map<String, dynamic> payload) async {
    switch (type) {
      case 'screening.snapshot':
        final snap = ScreeningSnapshot.fromJson(payload);
        _viewers = snap.viewers;
        _playlist = snap.playlist;
        await _applyState(snap.state);
        break;
      case 'screening.playlist.updated':
        _playlist = (payload['playlist'] as List<dynamic>? ?? const [])
            .map((e) => ScreeningPlaylistItem.fromJson(e as Map<String, dynamic>))
            .toList();
        onChanged();
        break;
      case 'screening.controller.changed':
        // 控制者变更后一般紧跟 snapshot；这里只更新控制者 id 让 UI 即时反馈
        final next = (payload['controllerUserId'] as num?)?.toInt();
        final s = _state;
        if (next != null && s != null) {
          _state = _copyState(s, controllerUserId: next);
          onChanged();
        }
        break;
      case 'screening.play':
      case 'screening.pause':
      case 'screening.seek':
      case 'screening.tick':
      case 'screening.rate':
        // 这些事件的 payload 就是完整 state（见后端 broadcastToScreening(eventType, state)）
        await _applyState(ScreeningState.fromJson(payload));
        break;
      default:
        break;
    }
  }

  // ---- 把远端 state 同步到本地播放器 ----

  Future<void> _applyState(ScreeningState state) async {
    _state = state;
    onChanged();

    // 换视频源
    if (state.currentUrl != _loadedUrl) {
      await _loadVideo(state.currentUrl);
    }

    // 控制者不跟随远端（自己就是源）；观众才对齐
    if (!isController) {
      await _syncViewerToState(state);
    }
    _restartTickTimerIfNeeded();
  }

  DateTime? _parseUpdatedAt(String raw) {
    if (raw.isEmpty) return null;
    return DateTime.tryParse(raw)?.toUtc();
  }

  /// 只有服务端 updatedAt 前进（或没有时间戳）才重锚；同一 tick 的重复广播
  /// （如有人进出触发的 snapshot 复用旧 currentTime）不重锚，避免把观众拉回固定某一秒。
  bool _shouldReanchor(ScreeningState state) {
    final next = _parseUpdatedAt(state.updatedAt);
    if (next == null) return true;
    final prev = _anchorUpdatedAt;
    return prev == null || next.isAfter(prev);
  }

  void _resetAnchor() {
    _anchorUpdatedAt = null;
    _anchorAtMs = 0;
    _anchorTime = 0;
    _anchorRate = 1;
  }

  Future<void> _syncViewerToState(ScreeningState state) async {
    final v = _video;
    if (v == null || !v.value.isInitialized) return;

    if (_shouldReanchor(state)) {
      _anchorUpdatedAt = _parseUpdatedAt(state.updatedAt) ?? _anchorUpdatedAt;
      _anchorAtMs = _clock.elapsedMilliseconds;
      _anchorTime = state.currentTime;
      _anchorRate = state.playbackRate > 0 ? state.playbackRate : 1;
    }

    // 播放中：用本地单调时钟从锚点外推目标进度，完全不掺服务端/本机墙钟之差；
    // 暂停中：目标就是静态 currentTime。
    final double target;
    if (state.isPlaying) {
      final elapsedSec = (_clock.elapsedMilliseconds - _anchorAtMs) / 1000.0;
      target = _anchorTime + elapsedSec * _anchorRate;
    } else {
      target = state.currentTime;
    }

    // 只在有数据、非缓冲时纠偏，避免「buffering→seek→再 buffering」自持循环。
    final pos = v.value.position.inMilliseconds / 1000.0;
    if (!v.value.isBuffering &&
        (pos - target).abs() > _driftThresholdSeconds) {
      await v.seekTo(Duration(milliseconds: (target * 1000).round()));
    }

    // 播放态对齐
    if (state.isPlaying && !v.value.isPlaying) {
      await v.play();
    } else if (!state.isPlaying && v.value.isPlaying) {
      await v.pause();
    }
  }

  Future<void> _loadVideo(String url) async {
    await _disposeVideo();
    _resetAnchor();
    _lastEndedItemId = '';
    _loadedUrl = url;
    if (url.isEmpty) {
      onChanged();
      return;
    }
    _initializingVideo = true;
    onChanged();
    try {
      final controller = VideoPlayerController.networkUrl(Uri.parse(url));
      _video = controller;
      controller.addListener(_onVideoChanged);
      await controller.initialize();
      _initializingVideo = false;
      final s = _state;
      if (s != null && !isController) {
        await _syncViewerToState(s);
      }
      onChanged();
    } catch (e) {
      _initializingVideo = false;
      onError('视频加载失败：$e');
      onChanged();
    }
  }

  /// 控制者：视频播放结束自动切下一条。发 screening.item.ended，由后端推进播放列表
  /// 并广播新状态（与 Web 端 screening.tsx 的 handleEnded 一致）。
  void _onVideoChanged() {
    final v = _video;
    if (v == null || !v.value.isInitialized) return;
    if (!isController) return;
    final s = _state;
    if (s == null || s.currentItemId.isEmpty) return;
    if (!v.value.isCompleted) return;
    if (_lastEndedItemId == s.currentItemId) return;
    _lastEndedItemId = s.currentItemId;
    final id = _channelId;
    if (id == null) return;
    socket.send('screening.item.ended', {
      'channelId': id,
      'itemId': s.currentItemId,
      'currentTime': 0,
      'playbackRate': s.playbackRate,
    });
  }

  Future<void> _disposeVideo() async {
    final old = _video;
    _video = null;
    _loadedUrl = '';
    if (old != null) {
      old.removeListener(_onVideoChanged);
      await old.pause();
      await old.dispose();
    }
  }

  bool get isLoadingVideo => _initializingVideo;

  // ---- 控制者操作（发信令 + 本地生效）----

  double get _pos =>
      (_video?.value.position.inMilliseconds ?? 0) / 1000.0;
  String get _itemId => _state?.currentItemId ?? '';

  Future<void> play() async {
    await _video?.play();
    _send('screening.play');
    _restartTickTimerIfNeeded();
  }

  Future<void> pause() async {
    await _video?.pause();
    _send('screening.pause');
  }

  Future<void> seek(double seconds) async {
    await _video?.seekTo(Duration(milliseconds: (seconds * 1000).round()));
    _send('screening.seek', time: seconds);
  }

  /// 观众申请成为控制者：发一次 play/pause（后端会把发起者设为控制者）。
  void takeControl() {
    final playing = _state?.isPlaying ?? false;
    _send(playing ? 'screening.play' : 'screening.pause');
  }

  void replaceUrl(String url, String title) {
    final id = _channelId;
    if (id == null) return;
    socket.send('screening.url.replace',
        {'channelId': id, 'url': url, 'title': title});
  }

  void addUrl(String url, String title) {
    final id = _channelId;
    if (id == null) return;
    socket.send('screening.url.add',
        {'channelId': id, 'url': url, 'title': title});
  }

  void removeItem(String itemId) {
    final id = _channelId;
    if (id == null) return;
    socket.send('screening.url.remove', {'channelId': id, 'itemId': itemId});
  }

  void _send(String type, {double? time}) {
    final id = _channelId;
    if (id == null) return;
    socket.send(type, {
      'channelId': id,
      'itemId': _itemId,
      'currentTime': time ?? _pos,
      'playbackRate': _state?.playbackRate ?? 1.0,
    });
  }

  // 控制者播放时定时发 tick 让观众对齐
  void _restartTickTimerIfNeeded() {
    _tickTimer?.cancel();
    _tickTimer = null;
    if (isController && (_state?.isPlaying ?? false)) {
      _tickTimer = Timer.periodic(_tickInterval, (_) {
        if (isController && (_video?.value.isPlaying ?? false)) {
          _send('screening.tick');
        }
      });
    }
  }

  ScreeningState _copyState(ScreeningState s, {int? controllerUserId}) =>
      ScreeningState(
        channelId: s.channelId,
        controllerUserId: controllerUserId ?? s.controllerUserId,
        currentItemId: s.currentItemId,
        currentUrl: s.currentUrl,
        currentTitle: s.currentTitle,
        playbackState: s.playbackState,
        currentTime: s.currentTime,
        playbackRate: s.playbackRate,
        awaitingReady: s.awaitingReady,
        updatedAt: s.updatedAt,
      );

  Future<void> dispose() async {
    _tickTimer?.cancel();
    await _disposeVideo();
    _resetAnchor();
  }
}

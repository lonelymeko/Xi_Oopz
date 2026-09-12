import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'background_service.dart';
import 'socket_client.dart';
import 'types.dart';

/// RTC 联调日志开关。联调期打开，稳定后设 false 即可静默。
const bool kRtcVerbose = true;

void _rlog(String msg) {
  if (kRtcVerbose) {
    // ignore: avoid_print
    print('[RTC] $msg');
  }
}

/// 每个远端 peer 的连接包装，对标 rtc.ts 的 PeerWrapper。
class PeerWrapper {
  final OopzUser user;
  final RTCPeerConnection pc;
  final bool polite;
  bool makingOffer = false;
  bool ignoreOffer = false;
  bool isSettingRemoteAnswerPending = false;
  bool initialOfferOwner;
  final List<Map<String, dynamic>> pendingIceCandidates = [];
  final RTCRtpTransceiver audioTransceiver;
  final RTCRtpTransceiver displayAudioTransceiver;
  final RTCRtpTransceiver screenTransceiver;
  int reconnectAttempts = 0;
  Timer? reconnectTimer;
  bool reconnecting = false;
  final bool useRelayOnly;
  TransportType lastKnownTransport;
  bool tracksBound = false; // 桌面端只绑一次本地轨道，后续刷新会破坏 transceiver
  bool negotiatedOnce = false; // 桌面端只做一次协商，后续 in-place 重新协商会失败
  Timer? statsTimer;
  Timer? stableTimer;
  final List<Timer> outboundRehydrateTimers = [];
  final int createdAtMs;

  PeerWrapper({
    required this.user,
    required this.pc,
    required this.polite,
    required this.initialOfferOwner,
    required this.audioTransceiver,
    required this.displayAudioTransceiver,
    required this.screenTransceiver,
    required this.useRelayOnly,
    required this.lastKnownTransport,
    required this.createdAtMs,
  });
}

/// Flutter 版 RTCController，1:1 对标 frontend/src/rtc.ts 的机制：
/// - Mesh 全互联，id 小的一方为 initialOfferOwner（impolite），完美协商防 glare
/// - 三 transceiver：麦克风音频 / 屏幕共享音频 / 屏幕共享视频（与 Web 端 SDP 布局一致）
/// - 断线重连梯子：宽限期 → ICE restart（仅直连）→ TURN relay 局部重建（rtc.reset）
/// - 状态机加固：reset 对撞决胜 / 建连宽限期 / 重建预算+终态 / 通知去重
/// - media.sync_request 补流循环、重连后 outbound rehydrate(replaceTrack null→track)
///
/// 与 Web 端的移动端差异：
/// - 无 Web Audio 混音：麦克风轨直接挂 audioTransceiver；屏幕音频需 Android
///   AudioPlaybackCapture，flutter_webrtc 未实现，故手机端只共享画面不共享系统声音
///   （Web 端接收侧本就按第二条 audio transceiver 区分，协议不需要改）
/// - 屏幕共享发送：Android 走 MediaProjection（flutter_webrtc 的 getDisplayMedia），
///   复用已协商好的 screenTransceiver，共享时 replaceTrack + SendRecv 并重协商；
///   Android 14+ 依赖 manifest 里 foregroundServiceType 含 mediaProjection 的前台服务
class RTCController {
  static const int mediaReconnectDelayMs = 1500;
  static const int mediaReconnectMaxAttempts = 5;
  static const int peerDisconnectGraceMs = 5000;
  static const int peerReconnectDelayMs = 2000;
  static const int peerReconnectMaxAttempts = 4;
  static const int turnDisconnectGraceMs = 1000;
  static const int iceRestartTimeoutMs = 4000;
  static const int peerStatsIntervalMs = 1500;
  static const int iceGatheringEvalDelayMs = 800;
  static const int peerStableResetMs = 8000;
  static const List<int> outboundRehydrateDelaysMs = [300, 1200];
  static const int peerEstablishGraceMs = 8000;
  static const int establishReevalDelayMs = 2000;
  static const int resetGlareWindowMs = 3000;
  static const int politeRecreateExtraDelayMs = 1500;
  static const int maxPeerRebuilds = 3;
  static const int outageNoticeIntervalMs = 30000;

  /// 屏幕共享发送上限。Android 端 flutter_webrtc 的 getDisplayMedia 会忽略传入的
  /// 宽高与帧率，直接按屏幕真实分辨率以 DEFAULT_FPS 采集（见 GetUserMediaImpl
  /// getDisplayMedia：info.width/height 取自 display.getRealSize），所以分辨率与帧率
  /// 只能在发送端用 RTCRtpSender 参数压。手机屏幕常见 1080x2400，若不设上限会发热、
  /// 掉帧，Mesh 下还会按 N-1 份重复上传把上行打满。
  static const int screenShareMaxBitrateBps = 1500000;
  static const int screenShareMaxFramerate = 15;

  /// Android 14+ 是否强制整屏采集（关掉系统授权框里的「单个应用」选项）。
  /// 整屏更贴合“共享手机屏幕”的直觉；若要支持只共享某一个 App，改成 false 即可。
  static const bool screenShareFullScreenOnly = true;

  final SocketClient socket;
  final int? Function() getCurrentVoiceChannelId;
  final OopzUser? Function() getCurrentUser;
  final Map<int, PresenceMember> Function() getVoiceMembers;
  final List<Map<String, dynamic>> Function() getIceServers;
  final void Function(Map<int, RemoteMedia> media) onMediaChanged;
  final void Function(Map<int, PeerDiagnostics> diagnostics)
      onDiagnosticsChanged;
  final void Function(MediaStream? stream) onLocalAudioChanged;
  final void Function(bool sharing) onScreenSharingChanged;
  /// 是否正在"只共享系统音频"（无画面）状态变化。
  final void Function(bool sharing) onAudioOnlySharingChanged;
  final void Function(String kind, String title, String message) onNotice;
  /// 活跃说话者集合变化（用于成员列表"正在说话"高亮）。
  final void Function(Set<int> userIds) onSpeakingChanged;

  final Stopwatch _clock = Stopwatch()..start();

  MediaStream? _localAudioStream;
  MediaStream? _localScreenStream;
  String? _audioInputDeviceId; // 选中的麦克风设备 id；null = 系统默认
  String? _audioOutputDeviceId; // 选中的扬声器设备 id；null = ADM 默认
  bool _micEnabled = true;
  bool _screenSharing = false;
  bool _audioOnlySharing = false; // 只共享系统音频（无画面）
  bool _voiceSessionActive = false;

  final Map<int, PeerWrapper> _peers = {};
  final Map<int, Future<PeerWrapper>> _peerEnsureFutures = {};
  final Map<int, RemoteMedia> _remoteMedia = {};
  final Map<String, int> _mediaReconnectAttempts = {};
  final Map<String, Timer> _mediaReconnectTimers = {};
  final Map<int, Timer> _peerDisconnectTimers = {};
  final Map<int, int> _peerRebuildCounts = {};
  final Set<int> _failedPeers = {};
  final Map<int, int> _lastResetSentAt = {};
  final Map<int, int> _outageNoticeAt = {};
  final Map<int, PeerDiagnostics> _diagnostics = {};
  final Set<int> _speakingUsers = {};
  final Map<int, int> _speakingUntil = {}; // 说话高亮保持到期时间
  static const int speakingHoldMs = 1500;

  RTCController({
    required this.socket,
    required this.getCurrentVoiceChannelId,
    required this.getCurrentUser,
    required this.getVoiceMembers,
    required this.getIceServers,
    required this.onMediaChanged,
    required this.onDiagnosticsChanged,
    required this.onLocalAudioChanged,
    required this.onScreenSharingChanged,
    required this.onAudioOnlySharingChanged,
    required this.onNotice,
    required this.onSpeakingChanged,
  });

  int get _nowMs => _clock.elapsedMilliseconds;

  bool get micEnabled => _micEnabled;

  /// 当前是否正在向频道共享屏幕（发送端状态）。
  bool get screenSharing => _screenSharing;

  /// 本地屏幕采集流（屏幕共享时含视频；只共享音频时仅音频有用）。用于本地预览。
  MediaStream? get localScreenStream => _localScreenStream;

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  Future<void> joinVoice(int channelId) async {
    _voiceSessionActive = true;
    try {
      final stream = await _ensureAudio();
      _rlog('joinVoice ch=$channelId 麦克风轨道数=${stream.getAudioTracks().length}');
    } catch (e) {
      _rlog('joinVoice 麦克风采集失败: $e');
      onNotice('error', '麦克风不可用', '$e');
    }
    // Windows 上 flutter_webrtc 不会自动初始化 ADM 播放设备，不处理的话「听不到别人说话」。
    await _ensureDesktopAudioOutput();
    socket.send('channel.join', {'channelId': channelId});
  }

  /// Windows 桌面端修复「连麦听不到对方」：
  ///
  /// flutter_webrtc 1.5.2 只在 getUserMedia 时、且请求里带了能匹配到「播放设备」的
  /// deviceId 才会调用 SetPlayoutDevice；默认（无 deviceId）时永远不调用，导致 ADM
  /// 播放管线一直处于未初始化状态 —— 远端音频收到、解码，但从不渲染到扬声器。
  /// 这里主动 enumerate 输出设备并 selectAudioOutput(默认设备)，触发 SetPlayoutDevice，
  /// 把播放管线激活。必须在 getUserMedia 之后调用（否则设备列表为空）。
  /// 仅 Windows 生效（macOS/Linux 无此问题，避免副作用）。
  Future<void> _ensureDesktopAudioOutput() async {
    if (!Platform.isWindows) return;
    if (_audioOutputDeviceId == null) {
      final outputs = await listAudioOutputs();
      final preferred = _pickPreferred(outputs);
      if (preferred != null) {
        _audioOutputDeviceId = preferred.deviceId;
        _rlog('自动选择扬声器 -> ${preferred.label}');
      }
    }
    final id = _audioOutputDeviceId;
    if (id == null || id.isEmpty) {
      _rlog('selectAudioOutput 跳过（无可用输出设备）');
      return;
    }
    try {
      await Helper.selectAudioOutput(id);
      _rlog('selectAudioOutput -> $id');
    } catch (e) {
      _rlog('selectAudioOutput 失败（忽略）: $e');
    }
  }

  Future<void> leaveVoice() async {
    _voiceSessionActive = false;
    // 共享中直接离开频道时，先把屏幕共享收干净：停采集 + 摘轨 + 广播 screen.state:false。
    // 此时 getCurrentVoiceChannelId() 仍是当前频道，广播能带对 channelId；马上要关掉所有
    // peer，所以跳过重协商。
    if (_screenSharing) {
      await stopScreenShare(renegotiate: false);
    }
    if (_audioOnlySharing) {
      await stopAudioOnlyShare(renegotiate: false);
    }
    final channelId = getCurrentVoiceChannelId();
    if (channelId != null) {
      socket.send('channel.leave', {'channelId': channelId});
    }
    await _closeAllPeers();
    if (_speakingUsers.isNotEmpty) {
      _speakingUsers.clear();
      onSpeakingChanged(const <int>{});
    }
    await _stopTrackGroup(_localAudioStream);
    _localAudioStream = null;
    _peerEnsureFutures.clear();
    onLocalAudioChanged(null);
  }

  Future<void> toggleMic(bool enabled) async {
    _micEnabled = enabled;
    final stream = _localAudioStream;
    if (stream != null) {
      for (final track in stream.getAudioTracks()) {
        track.enabled = enabled;
      }
    }
    final channelId = getCurrentVoiceChannelId();
    if (channelId != null) {
      socket
          .send('voice.state', {'channelId': channelId, 'micEnabled': enabled});
    }
  }

  // ------------------------------------------------------------------
  // 屏幕共享（发送端）
  // ------------------------------------------------------------------

  /// 组装 getDisplayMedia 约束。
  /// - 桌面端（Windows/Linux）：先经 desktopCapturer 选一个屏幕/窗口源，再带 `audio:true`
  ///   采集系统声音（Windows 走 WASAPI loopback；flutter_webrtc 源码里 audio:true 会
  ///   创建 loopback 音频源）。没有音频设备时会自动降级为无音频。
  /// - macOS：整屏需先 requestCapturePermission，音频策略保守关闭（避免回归）。
  /// - 移动端：只共享画面（系统音频依赖 AudioPlaybackCapture，flutter_webrtc 未实现）。
  Future<Map<String, dynamic>> _buildDisplayMediaConstraints(
      {required bool shareAudio}) async {
    if (Platform.isAndroid || Platform.isIOS) {
      return {'video': true, 'audio': false};
    }
    final wantAudio =
        shareAudio && !Platform.isAndroid && !Platform.isIOS;
    try {
      final sources = await desktopCapturer.getSources(
        types: const [SourceType.Screen, SourceType.Window],
      );
      if (sources.isNotEmpty) {
        DesktopCapturerSource chosen = sources.first;
        for (final s in sources) {
          if (s.type == SourceType.Screen) {
            chosen = s;
            break;
          }
        }
        _rlog('getDisplayMedia 选源 id=${chosen.id} name=${chosen.name} '
            'audio=$wantAudio');
        return {
          'video': {
            'deviceId': {'exact': chosen.id},
            'mandatory': {'frameRate': 30},
          },
          'audio': wantAudio,
        };
      }
    } catch (e) {
      _rlog('desktopCapturer.getSources 失败（回退默认屏）: $e');
    }
    return {
      'video': {
        'deviceId': {'exact': '0'},
        'mandatory': {'frameRate': 30},
      },
      'audio': wantAudio,
    };
  }

  /// 发起屏幕共享，与 Web 端 rtc.ts 的 startScreenShare 对齐：
  /// 采集 → 挂到已协商好的 screenTransceiver 并切成 SendRecv → 广播 screen.state。
  /// 协议与 Web 端一致，Web/其它端无需改动即可观看。
  ///
  /// [shareAudio] 为 true 时一并共享系统音频（Windows 走 WASAPI loopback）。
  /// 返回 false 表示用户取消授权或采集失败（取消属于正常路径，调用方不必报错弹窗）。
  Future<bool> startScreenShare({bool? shareAudio}) async {
    if (_screenSharing) return true;
    if (!_voiceSessionActive) {
      onNotice('error', '无法共享屏幕', '请先进入语音频道');
      return false;
    }
    final wantAudio = shareAudio ?? Platform.isWindows;
    // 已在"只共享音频"时先停掉，避免同一路系统音频被采集两次。
    if (_audioOnlySharing) {
      await stopAudioOnlyShare(renegotiate: false);
    }
    try {
      // 顺序很关键（Android 14/API 34+）：
      // 1) 先请求屏幕采集授权。用户同意后系统才把 android:project_media 授予本应用；
      // 2) 拿到授权后才能让前台服务带上 mediaProjection 类型启动。若提前带，startForeground
      //    会因缺授权抛 SecurityException，前台服务起不来，连语音保活都会被拖垮；
      // 3) 最后 getDisplayMedia 内部调 getMediaProjection，此时前台服务已就绪。
      //
      // Android/macOS 传 fullScreenOnly 可强制整屏，避免用户只选到“单个应用”导致观众
      // 只看到一小块画面；拿到授权后 getDisplayMedia 会复用这次返回的投影令牌，不会再弹框。
      if (Platform.isAndroid || Platform.isMacOS) {
        final granted = await Helper.requestCapturePermission(
            fullScreenOnly: screenShareFullScreenOnly);
        if (!granted) {
          _rlog('startScreenShare 用户取消采集授权');
          return false;
        }
      }
      await BackgroundKeepAlive.startScreenShare();

      final stream = await navigator.mediaDevices
          .getDisplayMedia(await _buildDisplayMediaConstraints(shareAudio: wantAudio));
      final track = stream.getVideoTracks().firstOrNull;
      if (track == null) {
        await _stopTrackGroup(stream);
        onNotice('error', '屏幕共享失败', '没有取到屏幕视频轨道');
        return false;
      }

      _localScreenStream = stream;
      _screenSharing = true;
      // 用户在系统 UI 点“停止共享”、锁屏或切到禁止投屏的界面时 SDK 会结束轨道；
      // 必须回收到房间状态，否则房间一直显示“共享中”但实际没有画面。
      track.onEnded = () {
        unawaited(stopScreenShare());
      };

      await _renegotiateForScreenShare();
      _broadcastScreenState(true);
      onScreenSharingChanged(true);
      _rlog('startScreenShare 成功 轨道=${track.id}');
      return true;
    } catch (e) {
      _rlog('startScreenShare 失败: $e');
      _screenSharing = false;
      await _teardownLocalScreenStream();
      for (final wrapper in _peers.values.toList(growable: false)) {
        await _applyScreenTrackToPeer(wrapper, null);
        await _applyDisplayAudioTrackToPeer(wrapper, null);
      }
      // 采集/前台服务失败时把前台服务降级回纯语音保活，别把连麦一起带崩。
      await BackgroundKeepAlive.stopScreenShare();
      onScreenSharingChanged(false);
      onNotice('error', '屏幕共享失败', '$e');
      return false;
    }
  }

  /// 停止屏幕共享并回收房间状态。
  /// [notifyServer] 为 false 时只做本地回收；[renegotiate] 为 false 时跳过重协商
  /// （整体离开频道时用，反正马上要关掉所有 peer）。
  Future<void> stopScreenShare(
      {bool notifyServer = true, bool renegotiate = true}) async {
    final wasSharing = _screenSharing;
    _screenSharing = false;
    // 先摘 onEnded，避免 track.stop() 触发的结束回调再进一轮回收。
    final track = _localScreenStream?.getVideoTracks().firstOrNull;
    track?.onEnded = null;
    await _teardownLocalScreenStream();
    if (wasSharing) {
      if (renegotiate) {
        await _renegotiateForScreenShare();
      }
      if (notifyServer) {
        _broadcastScreenState(false);
      }
      // 结束共享后前台服务降级回纯语音保活（microphone|mediaPlayback），通知文案回到“正在连麦中”。
      await BackgroundKeepAlive.stopScreenShare();
      onScreenSharingChanged(false);
      _rlog('stopScreenShare 完成');
    }
  }

  bool get audioOnlySharing => _audioOnlySharing;

  /// 只共享系统音频（无画面）：getDisplayMedia 采到后立刻丢掉视频轨只留音轨，
  /// 挂到第二条 audio transceiver（displayAudio）并重协商。协议与 Web 端一致。
  Future<bool> startAudioOnlyShare() async {
    if (_audioOnlySharing) return true;
    if (!_voiceSessionActive) {
      onNotice('error', '无法共享音频', '请先进入语音频道');
      return false;
    }
    if (_screenSharing) {
      await stopScreenShare();
    }
    try {
      // 注意：千万不要停掉视频轨！flutter_webrtc Windows 上屏幕视频与 WASAPI loopback
      // 音频共用同一个 desktop capturer 生命周期，stop 视频轨会连带停掉 loopback
      //（表现就是"只共享音频没声音"）。这里保留视频轨但**不挂到任何 transceiver**，
      // 因而不发送画面；只把音频挂到 displayAudio 发出去。
      final stream = await navigator.mediaDevices.getDisplayMedia(
          await _buildDisplayMediaConstraints(shareAudio: true));
      final audioTrack = stream.getAudioTracks().firstOrNull;
      if (audioTrack == null) {
        await _stopTrackGroup(stream);
        onNotice('error', '共享音频失败', '未捕获到系统音频，请检查系统权限');
        return false;
      }
      audioTrack.onEnded = () {
        unawaited(stopAudioOnlyShare());
      };
      _localScreenStream = stream;
      _audioOnlySharing = true;
      await _renegotiateForScreenShare();
      onAudioOnlySharingChanged(true);
      _rlog('startAudioOnlyShare 成功');
      return true;
    } catch (e) {
      _rlog('startAudioOnlyShare 失败: $e');
      _audioOnlySharing = false;
      await _teardownLocalScreenStream();
      for (final wrapper in _peers.values.toList(growable: false)) {
        await _applyDisplayAudioTrackToPeer(wrapper, null);
      }
      onAudioOnlySharingChanged(false);
      onNotice('error', '共享音频失败', '$e');
      return false;
    }
  }

  Future<void> stopAudioOnlyShare({bool renegotiate = true}) async {
    final was = _audioOnlySharing;
    _audioOnlySharing = false;
    final track = _localScreenStream?.getAudioTracks().firstOrNull;
    track?.onEnded = null;
    await _teardownLocalScreenStream();
    if (was) {
      if (renegotiate) await _renegotiateForScreenShare();
      onAudioOnlySharingChanged(false);
      _rlog('stopAudioOnlyShare 完成');
    }
  }

  Future<void> _teardownLocalScreenStream() async {
    final stream = _localScreenStream;
    _localScreenStream = null;
    await _stopTrackGroup(stream);
  }

  /// 屏幕共享开关后：先把屏幕轨挂到每条 peer 上，再补一轮 offer 触发重协商。
  /// 只挂轨不发 offer 的话，观众那边的 SDP 仍是 recvonly，看不到画面。
  Future<void> _renegotiateForScreenShare() async {
    final videoTrack =
        _screenSharing ? _localScreenStream?.getVideoTracks().firstOrNull : null;
    final displayAudioTrack = (_screenSharing || _audioOnlySharing)
        ? _localScreenStream?.getAudioTracks().firstOrNull
        : null;
    for (final wrapper in _peers.values) {
      await _applyScreenTrackToPeer(wrapper, videoTrack);
      await _applyDisplayAudioTrackToPeer(wrapper, displayAudioTrack);
    }
    for (final wrapper in _peers.values) {
      await _sendOffer(wrapper, force: true);
    }
  }

  /// 把屏幕共享音频轨挂到第二条 audio transceiver（displayAudio）上并转 SendRecv；
  /// [track] 为 null 时摘轨回 RecvOnly。Web 端按第二条 audio 识别为共享音频，协议一致。
  Future<void> _applyDisplayAudioTrackToPeer(
      PeerWrapper wrapper, MediaStreamTrack? track) async {
    await _safeTransceiver('displayAudio.replaceTrack',
        () => wrapper.displayAudioTransceiver.sender.replaceTrack(track));
    await _safeTransceiver(
        'displayAudio.setDirection',
        () => wrapper.displayAudioTransceiver.setDirection(track != null
            ? TransceiverDirection.SendRecv
            : TransceiverDirection.RecvOnly));
  }

  Future<void> _applyScreenTrackToPeer(
      PeerWrapper wrapper, MediaStreamTrack? track) async {
    await _safeTransceiver('screen.replaceTrack',
        () => wrapper.screenTransceiver.sender.replaceTrack(track));
    await _safeTransceiver(
        'screen.setDirection',
        () => wrapper.screenTransceiver.setDirection(track != null
            ? TransceiverDirection.SendRecv
            : TransceiverDirection.RecvOnly));
    if (track != null) {
      await _applyScreenSendLimits(wrapper);
    }
  }

  /// 限制屏幕共享的发送码率与帧率（见 screenShareMaxBitrateBps 的说明）。
  /// 手机屏幕按真实分辨率采集，不设上限会发热掉帧并把上行打满。
  Future<void> _applyScreenSendLimits(PeerWrapper wrapper) async {
    try {
      final params = wrapper.screenTransceiver.sender.parameters;
      final encodings = params.encodings;
      if (encodings == null || encodings.isEmpty) return;
      for (final encoding in encodings) {
        encoding.maxBitrate = screenShareMaxBitrateBps;
        encoding.maxFramerate = screenShareMaxFramerate;
        encoding.active = true;
      }
      await wrapper.screenTransceiver.sender.setParameters(params);
    } catch (e) {
      _rlog('屏幕共享发送上限设置失败（忽略）: $e');
    }
  }

  void _broadcastScreenState(bool sharing) {
    final channelId = getCurrentVoiceChannelId();
    if (channelId == null) return;
    socket
        .send('screen.state', {'channelId': channelId, 'screenSharing': sharing});
  }

  /// 音频输出切换（仅 Android/iOS 支持）。
  ///
  /// 注意：Windows/Linux 桌面端 flutter_webrtc 未实现这两个原生方法，调用会触发插件内
  /// std::bad_variant_access → CRT invalid parameter handler → __fastfail(c0000409)，
  /// 直接把进程打崩（表现就是 joinVoice 后立刻「闪退」）。Dart 侧 try/catch 抓不到这种
  /// 原生崩溃，必须在调用前用平台判断挡住，桌面端直接跳过。
  ///
  /// [on] 为 false 时不强制听筒，而是交给 flutter_webrtc 的
  /// “优先蓝牙/有线耳机，否则扬声器”策略，避免蓝牙耳机连接后仍被外放抢占。
  Future<void> setSpeakerphone(bool on) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    try {
      if (on) {
        await Helper.setSpeakerphoneOn(true);
      } else {
        await Helper.setSpeakerphoneOnButPreferBluetooth();
      }
    } catch (e) {
      _rlog('setSpeakerphone 当前平台不支持（忽略）: $e');
    }
  }

  // ------------------------------------------------------------------
  // presence 驱动的 mesh 维护（对标 handlePresenceSnapshot 等）
  // ------------------------------------------------------------------

  Future<void> handlePresenceSnapshot(List<PresenceMember> members) async {
    if (!_voiceSessionActive) return;
    final selfId = getCurrentUser()?.id;
    final seen = <int>{};
    _rlog(
        'presence.snapshot self=$selfId 成员=${members.map((m) => m.user.id).toList()}');

    for (final member in members) {
      if (member.user.id == selfId) continue;
      seen.add(member.user.id);
      if (_failedPeers.contains(member.user.id)) continue;
      final shouldOffer = selfId != null && selfId < member.user.id;
      _rlog('ensurePeer peer=${member.user.id} 我发offer=$shouldOffer');
      await _ensurePeer(member.user, shouldOffer);
      _ensureMediaFlow(member.user.id, 'audio', 'presence.snapshot');
      _ensureMediaFlow(member.user.id, 'screen', 'presence.snapshot');
    }

    for (final userId in _peers.keys.toList()) {
      if (!seen.contains(userId)) {
        handleMemberLeft(userId);
      }
    }
  }

  Future<void> handleMemberJoined(PresenceMember member) async {
    if (!_voiceSessionActive) return;
    final selfId = getCurrentUser()?.id;
    if (member.user.id == selfId) return;
    // 对方重新进入频道视为新一轮连接，解除历史失败标记
    _failedPeers.remove(member.user.id);
    _peerRebuildCounts.remove(member.user.id);
    final shouldOffer = selfId != null && selfId < member.user.id;
    await _ensurePeer(member.user, shouldOffer);
    _ensureMediaFlow(member.user.id, 'audio', 'member.joined');
    _ensureMediaFlow(member.user.id, 'screen', 'member.joined');
  }

  void handleMemberLeft(int userId) {
    if (!_voiceSessionActive) return;
    _failedPeers.remove(userId);
    _peerRebuildCounts.remove(userId);
    _outageNoticeAt.remove(userId);
    if (_speakingUsers.remove(userId)) {
      onSpeakingChanged(Set.of(_speakingUsers));
    }
    _destroyPeer(userId);
  }

  void handleScreenState(int userId, bool screenSharing) {
    if (!_voiceSessionActive) return;
    if (!screenSharing) {
      _clearMediaReconnect(userId, 'screen');
      // 远端停止共享：立刻清掉画面。不能只等远端 track ended——网页端可能只是停止
      // 发送而不结束轨道，导致本端一直停在"投屏界面"。
      final media = _remoteMedia[userId];
      if (media != null &&
          (media.screenStream != null || media.displayAudioStream != null)) {
        media.screenStream = null;
        media.displayAudioStream = null;
        onMediaChanged(Map.of(_remoteMedia));
      }
      return;
    }
    _ensureMediaFlow(userId, 'screen', 'screen.state');
  }

  void handleVoiceState(int userId, bool micEnabled) {
    if (!_voiceSessionActive) return;
    if (!micEnabled) {
      _clearMediaReconnect(userId, 'audio');
      return;
    }
    _ensureMediaFlow(userId, 'audio', 'voice.state');
  }

  // ------------------------------------------------------------------
  // 信令处理（对标 handleSignal）
  // ------------------------------------------------------------------

  Future<void> handleSignal(String type, Map<String, dynamic> payload) async {
    if (!_voiceSessionActive) return;
    try {
      final sourceUserId = (payload['sourceUserId'] as num?)?.toInt();
      if (sourceUserId == null) return;
      final peerUser = _lookupUser(sourceUserId);
      if (peerUser == null) {
        _rlog('收到信令 $type 但找不到用户 $sourceUserId（忽略）');
        return;
      }
      _rlog('收到信令 $type from=$sourceUserId');

      if (type == 'rtc.reset') {
        // reset 对撞决胜：impolite 方（id 小）刚发过 reset 时忽略对方的 reset，
        // 自己的重建胜出；polite 方无条件服从。
        final selfIsImpolite = (getCurrentUser()?.id ?? 0) < peerUser.id;
        final sentAt = _lastResetSentAt[peerUser.id];
        if (selfIsImpolite &&
            sentAt != null &&
            _nowMs - sentAt < resetGlareWindowMs) {
          return;
        }
        await _recreatePeer(
          peerUser.id,
          payload['reason'] as String? ?? 'remote-reset',
          notifyRemote: false,
          relayOnly: payload['relayOnly'] as bool? ?? false,
        );
        return;
      }

      final wrapper = await _ensurePeer(peerUser, false);

      if (type == 'screen.sync_request' || type == 'media.sync_request') {
        // 观众看不到画面时会来补流：只有本端确实在共享时才重新挂轨并重协商；
        // 没有本地屏幕流时回一轮 offer 也帮不上忙，直接忽略。
        final kind = type == 'screen.sync_request'
            ? 'screen'
            : (payload['kind'] as String? ?? 'screen');
        if (kind == 'screen' && !_screenSharing) return;
        await _refreshLocalOutboundForNegotiation(wrapper);
        await _sendOffer(wrapper);
        return;
      }

      if (type == 'rtc.offer' && payload['sdp'] is String) {
        final signalingState = wrapper.pc.signalingState;
        final readyForOffer = !wrapper.makingOffer &&
            (_isStableOrNull(signalingState) ||
                wrapper.isSettingRemoteAnswerPending);
        final offerCollision = !readyForOffer;

        wrapper.ignoreOffer = !wrapper.polite && offerCollision;
        if (wrapper.ignoreOffer) return;

        if (offerCollision) {
          // flutter_webrtc 无 setRemoteDescription 隐式回滚，polite 方显式回滚本地 offer
          try {
            await wrapper.pc
                .setLocalDescription(RTCSessionDescription(null, 'rollback'));
          } catch (_) {
            await _recreatePeer(peerUser.id, 'rollback-failed',
                notifyRemote: true, relayOnly: wrapper.useRelayOnly);
            return;
          }
        }

        wrapper.isSettingRemoteAnswerPending = false;
        await wrapper.pc.setRemoteDescription(
            RTCSessionDescription(payload['sdp'] as String, 'offer'));
        await _refreshLocalOutboundForNegotiation(wrapper);
        await _flushPendingIceCandidates(wrapper);
        final answer = await wrapper.pc.createAnswer();
        await wrapper.pc.setLocalDescription(answer);
        _rlog('发送 answer -> peer=$sourceUserId');
        wrapper.negotiatedOnce = true;
        socket.send('rtc.answer', {
          'channelId': getCurrentVoiceChannelId(),
          'targetUserId': sourceUserId,
          'sdp': answer.sdp,
        });
        return;
      }

      if (type == 'rtc.answer' && payload['sdp'] is String) {
        if (wrapper.pc.signalingState !=
            RTCSignalingState.RTCSignalingStateHaveLocalOffer) {
          _rlog(
              '收到 answer 但 signalingState=${wrapper.pc.signalingState}（非 HaveLocalOffer，忽略）');
          return;
        }
        _rlog('应用 answer <- peer=$sourceUserId');
        wrapper.isSettingRemoteAnswerPending = true;
        await wrapper.pc.setRemoteDescription(
            RTCSessionDescription(payload['sdp'] as String, 'answer'));
        wrapper.isSettingRemoteAnswerPending = false;
        await _flushPendingIceCandidates(wrapper);
        return;
      }

      if (type == 'rtc.ice_candidate' && payload['candidate'] is String) {
        final candidate =
            jsonDecode(payload['candidate'] as String) as Map<String, dynamic>;
        final remoteDesc = await wrapper.pc.getRemoteDescription();
        if (remoteDesc == null) {
          wrapper.pendingIceCandidates.add(candidate);
          return;
        }
        await wrapper.pc.addCandidate(_toIceCandidate(candidate));
      }
    } catch (e, st) {
      // 与 web 端一致：单条信令失败不打断整体会话（但联调期打出来）
      _rlog('handleSignal($type) 异常: $e\n$st');
    }
  }

  /// macOS/桌面端 flutter_webrtc 刚建好 PeerConnection 时 signalingState 为 null
  /// （要等 onSignalingState 回调才有值）。初始 null 等价于 stable，一并放行。
  bool _isStableOrNull(RTCSignalingState? state) =>
      state == null || state == RTCSignalingState.RTCSignalingStateStable;

  RTCIceCandidate _toIceCandidate(Map<String, dynamic> json) => RTCIceCandidate(
        json['candidate'] as String?,
        json['sdpMid'] as String?,
        (json['sdpMLineIndex'] as num?)?.toInt(),
      );

  // ------------------------------------------------------------------
  // 本地音频
  // ------------------------------------------------------------------

  /// 音频采集约束。
  /// flutter_webrtc 约定：麦克风设备放 `optional[].sourceId`，而 `deviceId` 指的是
  /// **扬声器**（见 flutter_media_stream.cc GetUserAudio：sourceId→SetRecordingDevice，
  /// deviceId→SetPlayoutDevice）。这样一次 getUserMedia 就能同时绑定输入与输出。
  Map<String, dynamic> _audioConstraints() => {
        'echoCancellation': true,
        'noiseSuppression': true,
        'autoGainControl': true,
        if (_audioInputDeviceId != null && _audioInputDeviceId!.isNotEmpty)
          'optional': [
            {'sourceId': _audioInputDeviceId},
          ],
        if (Platform.isWindows &&
            _audioOutputDeviceId != null &&
            _audioOutputDeviceId!.isNotEmpty)
          'deviceId': _audioOutputDeviceId,
      };

  /// 虚拟音频设备标签特征（Windows 上这些端点通常不出声/不采集）。
  static const List<String> _virtualAudioHints = [
    'voicemeeter',
    'vb-audio',
    'cable',
    'steam',
    'broadcast',
    'nvidia',
    'virtual',
  ];

  /// 从设备列表里挑一个"看起来真实"的设备（避开虚拟声卡）；没有更优时退回第一个有名字的。
  static MediaDeviceInfo? _pickPreferred(List<MediaDeviceInfo> devices) {
    if (devices.isEmpty) return null;
    bool virtual(MediaDeviceInfo d) {
      final l = d.label.toLowerCase();
      return _virtualAudioHints.any(l.contains);
    }

    final named = devices.where((d) => d.label.isNotEmpty).toList();
    final real = named.where((d) => !virtual(d)).toList();
    if (real.isNotEmpty) return real.first;
    if (named.isNotEmpty) return named.first;
    return devices.first;
  }

  Future<MediaStream> _ensureAudio() async {
    final existing = _localAudioStream;
    if (existing != null) return existing;
    // 用户没选麦克风时，先挑一个真实设备：Windows 上 ADM 默认 index 0 往往是虚拟声卡，
    // 直接用默认会采到静音（表现为"别人听不到我"）。
    if (_audioInputDeviceId == null) {
      final inputs = await listAudioInputs();
      final preferred = _pickPreferred(inputs);
      if (preferred != null) {
        _audioInputDeviceId = preferred.deviceId;
        _rlog('自动选择麦克风 -> ${preferred.label}');
      }
    }
    if (Platform.isWindows && _audioOutputDeviceId == null) {
      final outputs = await listAudioOutputs();
      final preferred = _pickPreferred(outputs);
      if (preferred != null) {
        _audioOutputDeviceId = preferred.deviceId;
        _rlog('自动选择扬声器 -> ${preferred.label}');
      }
    }
    final stream = await navigator.mediaDevices.getUserMedia({
      'audio': _audioConstraints(),
      'video': false,
    });
    for (final track in stream.getAudioTracks()) {
      track.enabled = _micEnabled;
    }
    _localAudioStream = stream;
    onLocalAudioChanged(stream);
    return stream;
  }

  /// 桌面端在没进过语音时 ADM 尚未初始化，`enumerateDevices` 会返回空列表
  /// （表现：设备菜单只有一个"系统默认"）。这里用一次瞬时的 getUserMedia 触发
  /// ADM 初始化，拿到设备后立刻停掉轨道，不影响通话状态。
  Future<void> primeAudioDevices() async {
    if (_localAudioStream != null) return;
    if (Platform.isAndroid || Platform.isIOS) return;
    try {
      final stream = await navigator.mediaDevices.getUserMedia({
        'audio': true,
        'video': false,
      });
      await _stopTrackGroup(stream);
      _rlog('primeAudioDevices 完成（已初始化音频设备列表）');
    } catch (e) {
      _rlog('primeAudioDevices 失败: $e');
    }
  }

  /// 启动时就预热音频（对齐浏览器）：初始化 ADM、枚举并选定真实麦克风/扬声器。
  /// 不预热的话，首次进房时设备列表为空、"默认设备"往往是虚拟声卡，导致默认麦克风
  /// 不生效（必须手动切换设备才出声）。
  Future<void> warmupAudio() async {
    if (Platform.isAndroid || Platform.isIOS) return;
    try {
      await primeAudioDevices(); // 触发 ADM 初始化，设备列表才可用
      if (_audioInputDeviceId == null) {
        final inputs = await listAudioInputs();
        final preferred = _pickPreferred(inputs);
        if (preferred != null) {
          _audioInputDeviceId = preferred.deviceId;
          try {
            await Helper.selectAudioInput(preferred.deviceId);
          } catch (_) {}
          _rlog('warmup 选麦克风 -> ${preferred.label}');
        }
      }
      if (_audioOutputDeviceId == null) {
        final outputs = await listAudioOutputs();
        final preferred = _pickPreferred(outputs);
        if (preferred != null) {
          _audioOutputDeviceId = preferred.deviceId;
          try {
            await Helper.selectAudioOutput(preferred.deviceId);
          } catch (_) {}
          _rlog('warmup 选扬声器 -> ${preferred.label}');
        }
      }
    } catch (e) {
      _rlog('warmupAudio 失败: $e');
    }
  }

  /// 当前选中的麦克风 deviceId（null = 系统默认）。
  String? get audioInputDeviceId => _audioInputDeviceId;

  /// 枚举可用麦克风。需先 getUserMedia 过一次（否则设备列表可能为空/无 label）。
  Future<List<MediaDeviceInfo>> listAudioInputs() async {
    try {
      final devices = await navigator.mediaDevices.enumerateDevices();
      return devices.where((d) => d.kind == 'audioinput').toList();
    } catch (e) {
      _rlog('enumerateDevices(audioinput) 失败: $e');
      return const [];
    }
  }

  /// 当前选中的扬声器 deviceId（null = ADM 默认）。
  String? get audioOutputDeviceId => _audioOutputDeviceId;

  /// 枚举可用扬声器（Windows 桌面支持；移动端无 audiooutput）。
  Future<List<MediaDeviceInfo>> listAudioOutputs() async {
    try {
      final devices = await navigator.mediaDevices.enumerateDevices();
      return devices.where((d) => d.kind == 'audiooutput').toList();
    } catch (e) {
      _rlog('enumerateDevices(audiooutput) 失败: $e');
      return const [];
    }
  }

  /// 选择扬声器输出设备。连麦中立即切换；未连麦只记住，进房时生效。仅 Windows 有效。
  Future<void> setAudioOutput(String? deviceId) async {
    _audioOutputDeviceId = (deviceId == null || deviceId.isEmpty) ? null : deviceId;
    if (!Platform.isWindows || _audioOutputDeviceId == null) return;
    if (!_voiceSessionActive) return;
    try {
      await Helper.selectAudioOutput(_audioOutputDeviceId!);
      _rlog('setAudioOutput -> $_audioOutputDeviceId');
    } catch (e) {
      _rlog('setAudioOutput 失败: $e');
      onNotice('error', '切换扬声器失败', '$e');
    }
  }

  /// 选择麦克风。未连麦时只记住选择，下次 joinVoice 生效；连麦中则重新采集，
  /// 并对所有 peer 的 audio sender replaceTrack 换轨，不打断通话、不重新协商。
  Future<void> setMicrophone(String? deviceId) async {
    final next = (deviceId == null || deviceId.isEmpty) ? null : deviceId;
    if (_audioInputDeviceId == next) return;
    _audioInputDeviceId = next;
    if (!_voiceSessionActive) return;

    final old = _localAudioStream;
    try {
      final stream = await navigator.mediaDevices.getUserMedia({
        'audio': _audioConstraints(),
        'video': false,
      });
      final newTrack = stream.getAudioTracks().firstOrNull;
      if (newTrack == null) {
        await _stopTrackGroup(stream);
        onNotice('error', '切换麦克风失败', '没有取到音频轨道');
        return;
      }
      newTrack.enabled = _micEnabled;
      _localAudioStream = stream;
      onLocalAudioChanged(stream);
      for (final wrapper in _peers.values) {
        await _safeTransceiver('audio.replaceTrack(switchMic)',
            () => wrapper.audioTransceiver.sender.replaceTrack(newTrack));
      }
      if (old != null) await _stopTrackGroup(old);
      _rlog('setMicrophone -> ${_audioInputDeviceId ?? "默认"}');
    } catch (e) {
      _rlog('setMicrophone 失败: $e');
      onNotice('error', '切换麦克风失败', '$e');
    }
  }

  /// 桌面端（macOS/Windows/Linux）flutter_webrtc 首次协商后 transceiver 引用会失效，
  /// 反复重绑会破坏已协商好的发送管线并触发重连风暴，故桌面端本地轨道只绑一次。
  static final bool _isDesktop =
      Platform.isMacOS || Platform.isWindows || Platform.isLinux;

  Future<void> _refreshLocalOutboundForNegotiation(PeerWrapper wrapper) async {
    // 对标 web 端：offer/answer/recreate 前刷新 outbound，避免重连后单向无声。
    // 桌面端：轨道已在初次协商挂好且不能重绑，绑过一次后直接跳过。
    if (_isDesktop && wrapper.tracksBound) return;
    await _bindLocalTracks(wrapper);
    wrapper.tracksBound = true;
  }

  /// 单个 transceiver 操作容错：macOS 上重新协商后缓存的 transceiver 引用会失效，
  /// setDirection/replaceTrack 抛 "transceiver not found"。此处吞掉单次失败，
  /// 避免一次刷新失败中断整个 offer/answer 协商（轨道通常已在首次协商挂好）。
  Future<void> _safeTransceiver(
      String op, Future<void> Function() action) async {
    try {
      await action();
    } catch (e) {
      _rlog('transceiver 操作[$op]失败（忽略）: $e');
    }
  }

  Future<void> _bindLocalTracks(PeerWrapper wrapper,
      {bool forceReplace = false}) async {
    final audioTrack = _localAudioStream?.getAudioTracks().firstOrNull;
    _rlog(
        '_bindLocalTracks peer=${wrapper.user.id} audioTrack=${audioTrack != null} forceReplace=$forceReplace');

    if (forceReplace) {
      await _safeTransceiver('audio.replaceTrack(null)',
          () => wrapper.audioTransceiver.sender.replaceTrack(null));
      await _safeTransceiver('displayAudio.replaceTrack(null)',
          () => wrapper.displayAudioTransceiver.sender.replaceTrack(null));
      await _safeTransceiver('screen.replaceTrack(null)',
          () => wrapper.screenTransceiver.sender.replaceTrack(null));
    }

    await _safeTransceiver('audio.replaceTrack',
        () => wrapper.audioTransceiver.sender.replaceTrack(audioTrack));
    await _safeTransceiver(
        'audio.setDirection',
        () => wrapper.audioTransceiver.setDirection(audioTrack != null
            ? TransceiverDirection.SendRecv
            : TransceiverDirection.RecvOnly));

    // 屏幕共享音频：桌面端（Windows loopback）在共享时挂本地屏幕音频轨并 SendRecv；
    // 移动端没有屏幕音频，保持 recvonly。重连/重协商后同样要重挂。
    final displayAudioTrack = (_screenSharing || _audioOnlySharing)
        ? _localScreenStream?.getAudioTracks().firstOrNull
        : null;
    await _safeTransceiver('displayAudio.replaceTrack',
        () => wrapper.displayAudioTransceiver.sender.replaceTrack(displayAudioTrack));
    await _safeTransceiver(
        'displayAudio.setDirection',
        () => wrapper.displayAudioTransceiver.setDirection(displayAudioTrack != null
            ? TransceiverDirection.SendRecv
            : TransceiverDirection.RecvOnly));

    // 屏幕视频：正在共享时挂本地屏幕轨并转 SendRecv，否则摘轨回 RecvOnly。
    // 重连/重协商后必须重新挂一遍，否则共享者断线重连后观众就再也看不到画面。
    final screenTrack =
        _screenSharing ? _localScreenStream?.getVideoTracks().firstOrNull : null;
    await _safeTransceiver('screen.replaceTrack',
        () => wrapper.screenTransceiver.sender.replaceTrack(screenTrack));
    await _safeTransceiver(
        'screen.setDirection',
        () => wrapper.screenTransceiver.setDirection(screenTrack != null
            ? TransceiverDirection.SendRecv
            : TransceiverDirection.RecvOnly));
    if (screenTrack != null) {
      await _applyScreenSendLimits(wrapper);
    }
    _rlog(
        '_bindLocalTracks peer=${wrapper.user.id} 完成 screenTrack=${screenTrack != null}');
  }

  Future<void> _forceRefreshLocalOutboundAfterReconnect(
      PeerWrapper wrapper, bool renegotiate) async {
    if (!_voiceSessionActive || !_peers.containsKey(wrapper.user.id)) return;

    // TURN/ICE 重连后的强制发送端修复：replaceTrack(null→track) 重建发送管线，
    // 解决“连接恢复但 RTP 不发包”的单向无声（对标 web 端同名逻辑）
    await _bindLocalTracks(wrapper, forceReplace: true);

    final channelId = getCurrentVoiceChannelId();
    if (channelId != null) {
      socket.send(
          'voice.state', {'channelId': channelId, 'micEnabled': _micEnabled});
    }

    if (renegotiate &&
        wrapper.initialOfferOwner &&
        wrapper.pc.signalingState ==
            RTCSignalingState.RTCSignalingStateStable) {
      await _sendOffer(wrapper);
    }
  }

  void _scheduleOutboundRehydrateAfterReconnect(PeerWrapper wrapper) {
    // 桌面端 transceiver 重绑会失败并触发失败的重新协商（setLocalDescription 报
    // "recv parameters for m-section" 错），进而连接崩溃重连，故桌面端不做 rehydrate。
    if (_isDesktop) return;
    if (!_voiceSessionActive || !_peers.containsKey(wrapper.user.id)) return;
    _clearOutboundRehydrateTimers(wrapper);
    for (var i = 0; i < outboundRehydrateDelaysMs.length; i++) {
      final isLast = i == outboundRehydrateDelaysMs.length - 1;
      wrapper.outboundRehydrateTimers.add(
        Timer(Duration(milliseconds: outboundRehydrateDelaysMs[i]), () {
          _forceRefreshLocalOutboundAfterReconnect(wrapper, isLast);
        }),
      );
    }
  }

  void _clearOutboundRehydrateTimers(PeerWrapper wrapper) {
    for (final timer in wrapper.outboundRehydrateTimers) {
      timer.cancel();
    }
    wrapper.outboundRehydrateTimers.clear();
  }

  // ------------------------------------------------------------------
  // peer 创建与销毁
  // ------------------------------------------------------------------

  Future<PeerWrapper> _ensurePeer(OopzUser user, bool initialOfferOwner,
      {bool relayOnly = false}) async {
    final existing = _peers[user.id];
    if (existing != null) {
      if (relayOnly && !existing.useRelayOnly) {
        _destroyPeer(user.id);
      } else {
        final state = existing.pc.connectionState;
        if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
            state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
          _destroyPeer(user.id);
        } else {
          _clearPeerReconnect(existing);
          if (initialOfferOwner) {
            existing.initialOfferOwner = true;
            await _refreshLocalOutboundForNegotiation(existing);
          }
          return existing;
        }
      }
    }

    final pending = _peerEnsureFutures[user.id];
    if (pending != null) {
      final ensured = await pending;
      if (initialOfferOwner && !ensured.initialOfferOwner) {
        ensured.initialOfferOwner = true;
        await _refreshLocalOutboundForNegotiation(ensured);
        await _sendOffer(ensured);
      }
      return ensured;
    }

    final future = _createPeer(user, initialOfferOwner, relayOnly);
    _peerEnsureFutures[user.id] = future;
    try {
      return await future;
    } finally {
      if (identical(_peerEnsureFutures[user.id], future)) {
        _peerEnsureFutures.remove(user.id);
      }
    }
  }

  Future<PeerWrapper> _createPeer(
      OopzUser user, bool initialOfferOwner, bool relayOnly) async {
    final currentUser = getCurrentUser();
    if (currentUser == null) {
      throw StateError('missing current user');
    }

    _rlog(
        '_createPeer peer=${user.id} iceServers数=${(relayOnly ? _relayIceServers() : getIceServers()).length} 开始建 pc');
    final pc = await createPeerConnection({
      'iceServers': relayOnly ? _relayIceServers() : getIceServers(),
      'sdpSemantics': 'unified-plan',
      'bundlePolicy': 'max-bundle',
      'rtcpMuxPolicy': 'require',
      'iceTransportPolicy': relayOnly ? 'relay' : 'all',
    });
    _rlog('_createPeer peer=${user.id} pc 已建，开始 addTransceiver');

    // 麦克风 transceiver：建时直接挂轨道 + SendRecv 一步到位。
    // macOS flutter_webrtc 上「先建 RecvOnly 空轨、再 setDirection(SendRecv)」
    // 不能可靠开启发送（getStats 无 outbound-rtp audio），必须建时带轨道。
    final micTrack = _localAudioStream?.getAudioTracks().firstOrNull;
    _rlog('_createPeer peer=${user.id} micTrack=${micTrack != null}');
    final audioTransceiver = micTrack != null
        ? await pc.addTransceiver(
            track: micTrack,
            kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
            init:
                RTCRtpTransceiverInit(direction: TransceiverDirection.SendRecv),
          )
        : await pc.addTransceiver(
            kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
            init:
                RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
          );
    final displayAudioTransceiver = await pc.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
      init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
    );
    final screenTransceiver = await pc.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
      init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
    );

    final wrapper = PeerWrapper(
      user: user,
      pc: pc,
      polite: currentUser.id > user.id,
      initialOfferOwner: initialOfferOwner,
      audioTransceiver: audioTransceiver,
      displayAudioTransceiver: displayAudioTransceiver,
      screenTransceiver: screenTransceiver,
      useRelayOnly: relayOnly,
      lastKnownTransport:
          relayOnly ? TransportType.turn : TransportType.unknown,
      createdAtMs: _nowMs,
    );
    // 桌面端麦克风轨道已在 addTransceiver 时挂好，标记为已绑定，
    // 让后续 _refreshLocalOutboundForNegotiation 全部跳过（避免失效的 setDirection）。
    if (_isDesktop && micTrack != null) {
      wrapper.tracksBound = true;
    }

    pc.onIceCandidate = (RTCIceCandidate candidate) {
      if ((candidate.candidate ?? '').isEmpty) return;
      final c = candidate.candidate ?? '';
      final typ = c.contains('typ relay')
          ? 'relay(TURN)'
          : c.contains('typ srflx')
              ? 'srflx(STUN)'
              : c.contains('typ host')
                  ? 'host(局域网)'
                  : '其他';
      _rlog('本地ICE候选 peer=${user.id} 类型=$typ');
      socket.send('rtc.ice_candidate', {
        'channelId': getCurrentVoiceChannelId(),
        'targetUserId': user.id,
        'candidate': jsonEncode({
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        }),
      });
    };

    pc.onIceGatheringState = (RTCIceGatheringState state) {
      if (state == RTCIceGatheringState.RTCIceGatheringStateComplete) {
        Timer(const Duration(milliseconds: iceGatheringEvalDelayMs), () {
          _evaluatePeerConnectivity(user.id, 'ice-no-usable-candidate');
        });
      }
    };

    pc.onTrack = (RTCTrackEvent event) => _handleRemoteTrack(wrapper, event);

    pc.onIceConnectionState = (RTCIceConnectionState state) {
      _rlog('ICE状态 peer=${user.id} => $state');
      if (state == RTCIceConnectionState.RTCIceConnectionStateConnected ||
          state == RTCIceConnectionState.RTCIceConnectionStateCompleted) {
        _handlePeerConnected(wrapper);
        _scheduleOutboundRehydrateAfterReconnect(wrapper);
        return;
      }
      if (state == RTCIceConnectionState.RTCIceConnectionStateDisconnected) {
        _cancelStableReset(wrapper);
        _schedulePeerReconnect(
          user.id,
          _isTurnLink(wrapper) ? turnDisconnectGraceMs : peerReconnectDelayMs,
          'ice-disconnected',
        );
        return;
      }
      if (state == RTCIceConnectionState.RTCIceConnectionStateFailed) {
        _cancelStableReset(wrapper);
        _schedulePeerReconnect(user.id, 0, 'ice-failed');
      }
    };

    pc.onConnectionState = (RTCPeerConnectionState state) {
      _rlog('连接状态 peer=${user.id} => $state');
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _handlePeerConnected(wrapper);
        _scheduleOutboundRehydrateAfterReconnect(wrapper);
        return;
      }
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        _cancelStableReset(wrapper);
        _schedulePeerDisconnectCleanup(user.id);
        _ensureMediaFlow(user.id, 'audio', 'peer-disconnected');
        _ensureMediaFlow(user.id, 'screen', 'peer-disconnected');
        _schedulePeerReconnect(
          user.id,
          _isTurnLink(wrapper) ? turnDisconnectGraceMs : peerReconnectDelayMs,
          'peer-disconnected',
        );
        return;
      }
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _cancelStableReset(wrapper);
        _schedulePeerReconnect(user.id, 0, 'peer-failed');
      }
    };

    _peers[user.id] = wrapper;
    _rlog(
        '_createPeer peer=${user.id} transceiver就绪 initialOfferOwner=$initialOfferOwner');
    if (initialOfferOwner) {
      await _refreshLocalOutboundForNegotiation(wrapper);
      await _sendOffer(wrapper);
    }
    return wrapper;
  }

  bool _isTurnLink(PeerWrapper wrapper) =>
      wrapper.useRelayOnly || wrapper.lastKnownTransport == TransportType.turn;

  Future<void> _handleRemoteTrack(
      PeerWrapper wrapper, RTCTrackEvent event) async {
    final userId = wrapper.user.id;
    final media = _remoteMedia[userId] ?? RemoteMedia(user: wrapper.user);
    final track = event.track;
    _rlog(
        '远端轨道到达 peer=$userId kind=${track.kind} mid=${event.transceiver?.mid}');

    // 以 mid 区分第二条 audio transceiver（屏幕共享音频），与 web 端语义一致
    final isDisplayAudio = track.kind == 'audio' &&
        event.transceiver != null &&
        event.transceiver!.mid == wrapper.displayAudioTransceiver.mid;

    final stream = event.streams.isNotEmpty
        ? event.streams.first
        : await _wrapTrackInStream(userId, track);

    if (track.kind == 'audio') {
      if (isDisplayAudio) {
        media.displayAudioStream = stream;
        _clearMediaReconnect(userId, 'screen');
      } else {
        media.audioStream = stream;
        _clearMediaReconnect(userId, 'audio');
      }
    } else if (track.kind == 'video') {
      media.screenStream = stream;
      _clearMediaReconnect(userId, 'screen');
    }

    track.onEnded = () {
      final current = _remoteMedia[userId];
      if (current == null) return;
      if (track.kind == 'audio') {
        if (isDisplayAudio) {
          current.displayAudioStream = null;
          _ensureMediaFlow(userId, 'screen', 'remote-track-ended');
        } else {
          current.audioStream = null;
          _ensureMediaFlow(userId, 'audio', 'remote-track-ended');
        }
      } else {
        current.screenStream = null;
        _ensureMediaFlow(userId, 'screen', 'remote-track-ended');
      }
      onMediaChanged(Map.of(_remoteMedia));
    };

    track.onMute = () {
      if (track.kind == 'audio') {
        _ensureMediaFlow(
            userId, isDisplayAudio ? 'screen' : 'audio', 'remote-track-muted');
      } else {
        _ensureMediaFlow(userId, 'screen', 'remote-track-muted');
      }
    };

    _remoteMedia[userId] = media;
    onMediaChanged(Map.of(_remoteMedia));
  }

  Future<MediaStream?> _wrapTrackInStream(
      int userId, MediaStreamTrack track) async {
    try {
      final stream = await createLocalMediaStream(
          'remote-${track.kind}-$userId-${track.id}');
      await stream.addTrack(track);
      return stream;
    } catch (_) {
      // 移动端音频轨即便不进 MediaStream 也会自动播放；视频渲染才需要 stream
      return null;
    }
  }

  Future<void> _handlePeerConnected(PeerWrapper wrapper) async {
    _clearPeerReconnect(wrapper, resetAttempts: false);
    _clearPeerDisconnectTimer(wrapper.user.id);
    _scheduleStableReset(wrapper);
    _startPeerStats(wrapper);
    // sender.parameters 里的 encodings 是原生侧在 sender 创建时给的快照，
    // 协商完成前可能还是空的，这里连上后补设一次屏幕共享的发送上限。
    if (_screenSharing) {
      await _applyScreenSendLimits(wrapper);
    }
  }

  Future<void> _sendOffer(PeerWrapper wrapper, {bool force = false}) async {
    // 桌面端：初次协商完成后默认不再主动发 offer（in-place 重新协商在 macOS 上
    // setLocalDescription 会失败并引发重连风暴）。但屏幕共享的开关**必须**重协商，
    // 否则远端（网页）收不到共享轨；屏幕共享场景传 force=true 放行。
    if (!force && _isDesktop && wrapper.negotiatedOnce) {
      _rlog('_sendOffer peer=${wrapper.user.id} 跳过：桌面端已协商，不做 in-place 重新协商');
      return;
    }
    if (wrapper.makingOffer) {
      _rlog('_sendOffer peer=${wrapper.user.id} 跳过：makingOffer=true');
      return;
    }
    if (!_isStableOrNull(wrapper.pc.signalingState)) {
      _rlog(
          '_sendOffer peer=${wrapper.user.id} 跳过：signalingState=${wrapper.pc.signalingState}');
      return;
    }
    try {
      wrapper.makingOffer = true;
      _rlog('_sendOffer peer=${wrapper.user.id} 步骤1 刷新outbound');
      await _refreshLocalOutboundForNegotiation(wrapper);
      _rlog('_sendOffer peer=${wrapper.user.id} 步骤2 createOffer');
      final offer = await wrapper.pc.createOffer();
      _rlog('_sendOffer peer=${wrapper.user.id} 步骤3 setLocalDescription');
      await wrapper.pc.setLocalDescription(offer);
      _rlog('发送 offer -> peer=${wrapper.user.id}');
      wrapper.negotiatedOnce = true;
      socket.send('rtc.offer', {
        'channelId': getCurrentVoiceChannelId(),
        'targetUserId': wrapper.user.id,
        'sdp': offer.sdp,
      });
    } catch (e) {
      _rlog('_sendOffer peer=${wrapper.user.id} 异常: $e');
      onNotice('error', '实时通信异常', 'WebRTC 协商失败，请重进频道');
    } finally {
      wrapper.makingOffer = false;
    }
  }

  Future<void> _flushPendingIceCandidates(PeerWrapper wrapper) async {
    if (wrapper.pendingIceCandidates.isEmpty) return;
    final queued = List<Map<String, dynamic>>.of(wrapper.pendingIceCandidates);
    wrapper.pendingIceCandidates.clear();
    for (final candidate in queued) {
      try {
        await wrapper.pc.addCandidate(_toIceCandidate(candidate));
      } catch (_) {
        // 与 web 端一致：忽略 glare 场景下的过期 candidate
      }
    }
  }

  Future<void> _closeAllPeers() async {
    for (final timer in _mediaReconnectTimers.values) {
      timer.cancel();
    }
    _mediaReconnectTimers.clear();
    _mediaReconnectAttempts.clear();
    for (final timer in _peerDisconnectTimers.values) {
      timer.cancel();
    }
    _peerDisconnectTimers.clear();
    for (final wrapper in _peers.values) {
      _clearPeerReconnect(wrapper);
      _cancelStableReset(wrapper);
      _clearOutboundRehydrateTimers(wrapper);
      _stopPeerStats(wrapper);
      await wrapper.pc.close();
    }
    _peers.clear();
    _remoteMedia.clear();
    _peerRebuildCounts.clear();
    _failedPeers.clear();
    _lastResetSentAt.clear();
    _outageNoticeAt.clear();
    _diagnostics.clear();
    onMediaChanged(Map.of(_remoteMedia));
    onDiagnosticsChanged(Map.of(_diagnostics));
  }

  Future<void> _stopTrackGroup(MediaStream? stream) async {
    if (stream == null) return;
    for (final track in stream.getTracks()) {
      await track.stop();
    }
    await stream.dispose();
  }

  OopzUser? _lookupUser(int userId) => getVoiceMembers()[userId]?.user;

  // ------------------------------------------------------------------
  // media.sync_request 补流循环（对标 ensureMediaFlow / requestMediaSync）
  // ------------------------------------------------------------------

  void _ensureMediaFlow(int userId, String kind, String reason) {
    if (!_voiceSessionActive) return;
    if (getCurrentVoiceChannelId() == null) return;
    if (userId == getCurrentUser()?.id) return;
    if (_failedPeers.contains(userId)) return;
    final voiceMember = getVoiceMembers()[userId];
    if (voiceMember == null) return;
    if (kind == 'screen' && !voiceMember.screenSharing) return;
    final media = _remoteMedia[userId];
    final existingStream =
        kind == 'audio' ? media?.audioStream : media?.screenStream;
    if (existingStream != null) {
      _clearMediaReconnect(userId, kind);
      return;
    }
    _requestMediaSync(userId, kind, reason);
  }

  void _requestMediaSync(int userId, String kind, String reason) {
    final channelId = getCurrentVoiceChannelId();
    if (channelId == null) return;
    final voiceMember = getVoiceMembers()[userId];
    if (voiceMember == null ||
        (kind == 'screen' && !voiceMember.screenSharing)) {
      _clearMediaReconnect(userId, kind);
      return;
    }
    final key = '$userId:$kind';
    final attempt = (_mediaReconnectAttempts[key] ?? 0) + 1;
    if (attempt > mediaReconnectMaxAttempts) {
      _clearMediaReconnect(userId, kind);
      return;
    }
    _mediaReconnectAttempts[key] = attempt;
    _mediaReconnectTimers.remove(key)?.cancel();
    socket.send('media.sync_request', {
      'channelId': channelId,
      'targetUserId': userId,
      'kind': kind,
      'reason': reason,
      'attempt': attempt,
    });
    _mediaReconnectTimers[key] =
        Timer(const Duration(milliseconds: mediaReconnectDelayMs), () {
      _mediaReconnectTimers.remove(key);
      _requestMediaSync(userId, kind, 'retry');
    });
  }

  void _clearMediaReconnect(int userId, String kind) {
    final key = '$userId:$kind';
    _mediaReconnectTimers.remove(key)?.cancel();
    _mediaReconnectAttempts.remove(key);
  }

  // ------------------------------------------------------------------
  // 断线重连状态机（含 4 项加固，对标 web 端最新实现）
  // ------------------------------------------------------------------

  void _schedulePeerDisconnectCleanup(int userId) {
    if (_peerDisconnectTimers.containsKey(userId)) return;
    _peerDisconnectTimers[userId] =
        Timer(const Duration(milliseconds: peerDisconnectGraceMs), () {
      _peerDisconnectTimers.remove(userId);
      final wrapper = _peers[userId];
      if (wrapper == null) return;
      if (wrapper.pc.connectionState ==
          RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        handleMemberLeft(userId);
      }
    });
  }

  void _clearPeerDisconnectTimer(int userId) {
    _peerDisconnectTimers.remove(userId)?.cancel();
  }

  void _clearPeerReconnect(PeerWrapper wrapper, {bool resetAttempts = true}) {
    wrapper.reconnectTimer?.cancel();
    wrapper.reconnectTimer = null;
    if (resetAttempts) {
      wrapper.reconnectAttempts = 0;
    }
    wrapper.reconnecting = false;
  }

  void _scheduleStableReset(PeerWrapper wrapper) {
    _cancelStableReset(wrapper);
    wrapper.stableTimer =
        Timer(const Duration(milliseconds: peerStableResetMs), () {
      wrapper.stableTimer = null;
      final connectionState = wrapper.pc.connectionState;
      final iceState = wrapper.pc.iceConnectionState;
      if (connectionState ==
              RTCPeerConnectionState.RTCPeerConnectionStateConnected ||
          iceState == RTCIceConnectionState.RTCIceConnectionStateConnected ||
          iceState == RTCIceConnectionState.RTCIceConnectionStateCompleted) {
        wrapper.reconnectAttempts = 0;
        _peerRebuildCounts.remove(wrapper.user.id);
        _outageNoticeAt.remove(wrapper.user.id);
      }
    });
  }

  void _cancelStableReset(PeerWrapper wrapper) {
    wrapper.stableTimer?.cancel();
    wrapper.stableTimer = null;
  }

  bool _shouldNotifyOutage(int userId) {
    final last = _outageNoticeAt[userId];
    if (last != null && _nowMs - last < outageNoticeIntervalMs) {
      return false;
    }
    _outageNoticeAt[userId] = _nowMs;
    return true;
  }

  void _schedulePeerReconnect(int userId, int delayMs, String reason) {
    if (!_voiceSessionActive) return;
    if (_failedPeers.contains(userId)) return;
    final wrapper = _peers[userId];
    if (wrapper == null || wrapper.reconnecting) return;
    if (wrapper.reconnectTimer != null) return;

    final nextAttempt = wrapper.reconnectAttempts + 1;
    final turnFallback = _isTurnLink(wrapper) ||
        (nextAttempt >= 2 && _relayIceServers().isNotEmpty);
    // polite 方多等一拍：正常情况下 impolite 方的 rtc.reset 会先到，
    // 本地定时器随 recreate 被清掉，避免双方同时重建打架
    final effectiveDelayMs =
        wrapper.polite ? delayMs + politeRecreateExtraDelayMs : delayMs;
    wrapper.reconnectTimer =
        Timer(Duration(milliseconds: effectiveDelayMs), () {
      wrapper.reconnectTimer = null;
      _attemptPeerReconnect(userId, reason);
    });
    if (_shouldNotifyOutage(userId)) {
      onNotice(
        'info',
        '实时连接重连中',
        turnFallback
            ? '与 ${wrapper.user.displayName} 的连接不稳定，正在使用 TURN 中继重连'
            : '与 ${wrapper.user.displayName} 的连接出现波动，正在自动重连',
      );
    }
  }

  Future<void> _attemptPeerReconnect(int userId, String reason) async {
    if (!_voiceSessionActive) return;
    final wrapper = _peers[userId];
    if (wrapper == null || getCurrentVoiceChannelId() == null) return;
    if (wrapper.pc.connectionState ==
        RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
      return;
    }

    wrapper.reconnectAttempts += 1;
    wrapper.reconnecting = true;
    final attempt = wrapper.reconnectAttempts;
    final switchingToRelay = !wrapper.useRelayOnly &&
        wrapper.lastKnownTransport != TransportType.turn &&
        attempt >= 2 &&
        _relayIceServers().isNotEmpty;

    try {
      if (_isTurnLink(wrapper)) {
        // TURN/relay 断线不走 ICE restart 补丁，直接 rtc.reset 双方局部重建
        await _recreatePeer(userId, reason,
            notifyRemote: true, relayOnly: true);
        return;
      }

      if (!switchingToRelay &&
          wrapper.pc.signalingState ==
              RTCSignalingState.RTCSignalingStateStable &&
          !wrapper.makingOffer) {
        final offer = await wrapper.pc.createOffer({'iceRestart': true});
        await wrapper.pc.setLocalDescription(offer);
        socket.send('rtc.offer', {
          'channelId': getCurrentVoiceChannelId(),
          'targetUserId': wrapper.user.id,
          'sdp': offer.sdp,
        });
        wrapper.reconnecting = false;
        // 直连 ICE restart 留满超时窗口再判失败
        _schedulePeerReconnect(
            userId, iceRestartTimeoutMs, 'ice-restart-timeout');
        return;
      }

      final shouldUseRelayOnly = switchingToRelay || _isTurnLink(wrapper);
      await _recreatePeer(userId, reason,
          notifyRemote: true, relayOnly: shouldUseRelayOnly);
    } catch (_) {
      wrapper.reconnecting = false;
      if (attempt >= peerReconnectMaxAttempts) {
        await _recreatePeer(userId, 'reconnect-max-attempts',
            notifyRemote: true, relayOnly: _isTurnLink(wrapper));
        return;
      }
      _schedulePeerReconnect(userId, peerReconnectDelayMs, 'reconnect-retry');
    }
  }

  Future<void> _recreatePeer(int userId, String reason,
      {required bool notifyRemote, bool relayOnly = false}) async {
    if (!_voiceSessionActive) return;
    final wrapper = _peers[userId];
    final user = wrapper?.user ?? _lookupUser(userId);
    final currentUser = getCurrentUser();
    final channelId = getCurrentVoiceChannelId();
    if (user == null || currentUser == null || channelId == null) return;

    // 重建预算：稳定期(8s)清零；耗尽进终态停止循环重建
    final rebuildCount = (_peerRebuildCounts[userId] ?? 0) + 1;
    if (rebuildCount > maxPeerRebuilds) {
      _failedPeers.add(userId);
      _destroyPeer(userId);
      onNotice(
        'error',
        '重连失败',
        '与 ${user.displayName} 的连接多次重建失败，已停止自动重连，可尝试重新进入频道',
      );
      return;
    }
    _peerRebuildCounts[userId] = rebuildCount;

    _destroyPeer(userId);

    if (notifyRemote) {
      _lastResetSentAt[userId] = _nowMs;
      socket.send('rtc.reset', {
        'channelId': channelId,
        'targetUserId': userId,
        'reason': reason,
        'relayOnly': relayOnly,
      });
    }

    final shouldOffer = currentUser.id < user.id;
    if (relayOnly && _shouldNotifyOutage(userId)) {
      onNotice('info', '已切换 TURN 中继', '与 ${user.displayName} 的连接已改用 TURN 中继重建');
    }
    final nextWrapper =
        await _ensurePeer(user, shouldOffer, relayOnly: relayOnly);
    await _refreshLocalOutboundForNegotiation(nextWrapper);
    nextWrapper.reconnecting = false;
    nextWrapper.reconnectAttempts = relayOnly ? 1 : 0;
    if (relayOnly) {
      nextWrapper.lastKnownTransport = TransportType.turn;
    }
    if (shouldOffer) {
      await _sendOffer(nextWrapper);
    }
  }

  void _destroyPeer(int userId) {
    _peerEnsureFutures.remove(userId);
    final wrapper = _peers.remove(userId);
    if (wrapper == null) return;
    _clearPeerReconnect(wrapper);
    _cancelStableReset(wrapper);
    _clearOutboundRehydrateTimers(wrapper);
    _clearPeerDisconnectTimer(userId);
    _clearMediaReconnect(userId, 'audio');
    _clearMediaReconnect(userId, 'screen');
    _stopPeerStats(wrapper);
    wrapper.pc.close();
    _remoteMedia.remove(userId);
    _diagnostics.remove(userId);
    onMediaChanged(Map.of(_remoteMedia));
    onDiagnosticsChanged(Map.of(_diagnostics));
  }

  List<Map<String, dynamic>> _relayIceServers() {
    return getIceServers().where((server) {
      final urls = server['urls'];
      final list = urls is List ? urls : [urls];
      return list.any((url) =>
          url.toString().startsWith('turn:') ||
          url.toString().startsWith('turns:'));
    }).toList();
  }

  // ------------------------------------------------------------------
  // 连通性评估与统计（对标 evaluatePeerConnectivity / collectPeerStats）
  // ------------------------------------------------------------------

  Future<void> _evaluatePeerConnectivity(int userId, String reason) async {
    if (!_voiceSessionActive) return;
    final wrapper = _peers[userId];
    if (wrapper == null ||
        wrapper.reconnecting ||
        wrapper.reconnectTimer != null) {
      return;
    }
    if (getCurrentVoiceChannelId() == null) return;
    final connectionState = wrapper.pc.connectionState;
    final iceState = wrapper.pc.iceConnectionState;
    if (connectionState ==
            RTCPeerConnectionState.RTCPeerConnectionStateConnected ||
        iceState == RTCIceConnectionState.RTCIceConnectionStateConnected ||
        iceState == RTCIceConnectionState.RTCIceConnectionStateCompleted) {
      return;
    }

    try {
      final stats = await wrapper.pc.getStats();
      final hasUsablePair = stats.any((report) =>
          report.type == 'candidate-pair' &&
          (report.values['state'] == 'succeeded' ||
              report.values['nominated'] == true));
      if (hasUsablePair) return;

      // 建连宽限期：gathering 刚结束没有 succeeded pair 是正常现象，
      // 宽限期内只复查不重建，避免误杀还在握手中的连接
      final ageMs = _nowMs - wrapper.createdAtMs;
      if (ageMs < peerEstablishGraceMs) {
        Timer(const Duration(milliseconds: establishReevalDelayMs), () {
          _evaluatePeerConnectivity(userId, reason);
        });
        return;
      }
      _schedulePeerReconnect(userId, 0, reason);
    } catch (_) {
      // stats 采集失败不影响会话
    }
  }

  void _startPeerStats(PeerWrapper wrapper) {
    if (wrapper.statsTimer != null) return;
    _collectPeerStats(wrapper);
    wrapper.statsTimer = Timer.periodic(
      const Duration(milliseconds: peerStatsIntervalMs),
      (_) => _collectPeerStats(wrapper),
    );
  }

  void _stopPeerStats(PeerWrapper wrapper) {
    wrapper.statsTimer?.cancel();
    wrapper.statsTimer = null;
  }

  Future<void> _collectPeerStats(PeerWrapper wrapper) async {
    try {
      final stats = await wrapper.pc.getStats();
      // 出站音频诊断：确认麦克风 RTP 是否真的在发包（排查单向无声）
      double localMicLevel = 0;
      for (final report in stats) {
        if (report.type == 'outbound-rtp' && report.values['kind'] == 'audio') {
          _rlog(
              '出站音频 peer=${wrapper.user.id} bytesSent=${report.values['bytesSent']} packetsSent=${report.values['packetsSent']}');
        }
        if (report.type == 'media-source' && report.values['kind'] == 'audio') {
          final lv = report.values['audioLevel'];
          if (lv is num && lv.toDouble() > localMicLevel) {
            localMicLevel = lv.toDouble();
          }
          _rlog(
              '麦克风源 peer=${wrapper.user.id} audioLevel=${report.values['audioLevel']}');
        }
      }
      // 入站音频活动检测：用于放映室/成员列表「正在说话」高亮。
      // 取该 peer 全部 inbound-rtp audio 轨的最大 audioLevel（0~1）。
      double inboundLevel = 0;
      for (final report in stats) {
        if (report.type == 'inbound-rtp' &&
            report.values['kind'] == 'audio') {
          final lv = report.values['audioLevel'];
          if (lv is num && lv.toDouble() > inboundLevel) {
            inboundLevel = lv.toDouble();
          }
        }
      }
      // 说话高亮：检测到音频活动就点亮，并保持一小段时间，避免两次采样之间闪烁。
      if (inboundLevel > 0.02) {
        _speakingUntil[wrapper.user.id] = _nowMs + speakingHoldMs;
      }
      final heldSpeaking = (_speakingUntil[wrapper.user.id] ?? 0) > _nowMs;
      final wasSpeaking = _speakingUsers.contains(wrapper.user.id);
      if (heldSpeaking != wasSpeaking) {
        if (heldSpeaking) {
          _speakingUsers.add(wrapper.user.id);
        } else {
          _speakingUsers.remove(wrapper.user.id);
          _speakingUntil.remove(wrapper.user.id);
        }
        onSpeakingChanged(Set.of(_speakingUsers));
      }
      // 本端自己：用 outbound 的麦克风电平判断自己是否在说话。
      final selfId = getCurrentUser()?.id;
      if (selfId != null) {
        if (localMicLevel > 0.02) {
          _speakingUntil[selfId] = _nowMs + speakingHoldMs;
        }
        final heldSelf = (_speakingUntil[selfId] ?? 0) > _nowMs;
        final wasSelf = _speakingUsers.contains(selfId);
        if (heldSelf != wasSelf) {
          if (heldSelf) {
            _speakingUsers.add(selfId);
          } else {
            _speakingUsers.remove(selfId);
            _speakingUntil.remove(selfId);
          }
          onSpeakingChanged(Set.of(_speakingUsers));
        }
      }
      final reports = <String, StatsReport>{};
      String selectedPairId = '';
      for (final report in stats) {
        reports[report.id] = report;
        if (report.type == 'transport') {
          final pairId = report.values['selectedCandidatePairId'];
          if (pairId is String && pairId.isNotEmpty) {
            selectedPairId = pairId;
          }
        }
      }
      StatsReport? pair = reports[selectedPairId];
      if (pair == null) {
        for (final report in stats) {
          if (report.type == 'candidate-pair' &&
              (report.values['state'] == 'succeeded' ||
                  report.values['nominated'] == true)) {
            pair = report;
          }
        }
      }
      if (pair == null) return;

      final localCandidate = reports[pair.values['localCandidateId']];
      final remoteCandidate = reports[pair.values['remoteCandidateId']];
      final transport = _resolveTransportType(
        localCandidate?.values['candidateType'] as String?,
        remoteCandidate?.values['candidateType'] as String?,
      );
      if (transport != TransportType.unknown) {
        wrapper.lastKnownTransport = transport;
      }

      int? latencyMs;
      final rtt = pair.values['currentRoundTripTime'];
      if (rtt is num) {
        latencyMs = (rtt * 1000).round();
      }

      _diagnostics[wrapper.user.id] = PeerDiagnostics(
        userId: wrapper.user.id,
        latencyMs: latencyMs,
        transport: transport,
        retryCount: wrapper.reconnectAttempts,
        recoveryMode: wrapper.useRelayOnly
            ? RecoveryMode.relay
            : wrapper.reconnectAttempts > 0
                ? RecoveryMode.iceRestart
                : RecoveryMode.stable,
        updatedAt: DateTime.now(),
      );
      _rlog('诊断 peer=${wrapper.user.id} 链路=$transport rtt=${latencyMs}ms');
      onDiagnosticsChanged(Map.of(_diagnostics));
    } catch (_) {
      // 忽略单次统计失败
    }
  }

  TransportType _resolveTransportType(String? localType, String? remoteType) {
    if (localType == 'relay' || remoteType == 'relay') {
      return TransportType.turn;
    }
    if (localType == 'srflx' ||
        localType == 'prflx' ||
        remoteType == 'srflx' ||
        remoteType == 'prflx') {
      return TransportType.stun;
    }
    if (localType == 'host' || remoteType == 'host') return TransportType.lan;
    return TransportType.unknown;
  }
}

extension<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}

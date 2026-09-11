import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:floating/floating.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:window_manager/window_manager.dart';

import '../oopz_rtc.dart';
import '../src/skin.dart';
import '../widgets/channel_sidebar.dart';
import 'login_page.dart';
import '../widgets/screening_view.dart';
import '../widgets/voice_controls.dart';
import '../widgets/voice_room_view.dart';

/// 宽屏阈值：≥ 此宽度常驻侧边栏，否则用抽屉。
const double _kWideBreakpoint = 720;

class HomePage extends StatefulWidget {
  final String baseUrl;
  final AuthResponse auth;

  const HomePage({super.key, required this.baseUrl, required this.auth});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  late final OopzApiClient _api;
  BootstrapData? _bootstrap;
  SocketClient? _socket;
  RTCController? _rtc;
  ScreeningController? _screening;

  // 频道导航
  ChannelInfo? _viewingChannel; // 当前查看的频道
  int? _activeScreeningChannelId; // 已加入的放映室
  DomainPresence _domainPresence = DomainPresence.empty; // 侧边栏各频道成员
  Timer? _presenceDebounce;
  int? _currentDomainId; // 当前所在域
  List<DomainSummary> _domains = const []; // 可切换的域列表

  // 语音
  int? _currentVoiceChannelId; // 已连麦的语音频道
  int? _pendingJoinChannelId;
  final Map<int, PresenceMember> _voiceMembers = {};
  Map<int, PeerDiagnostics> _diagnostics = {};
  Set<int> _speakingUsers = <int>{};
  final Map<int, RTCVideoRenderer> _screenRenderers = {};
  RTCVideoRenderer? _localScreenRenderer; // 本端屏幕共享的本地预览
  int? _expandedShareUserId; // 正在全屏观看的共享者 id
  bool _micEnabled = true;
  bool _speakerOn = false; // false = 蓝牙/有线耳机优先，true = 强制扬声器
  bool _screenSharing = false; // 本端是否正在共享屏幕（发送端状态）
  bool _audioOnlySharing = false; // 本端是否正在"只共享系统音频"
  String? _micDeviceId; // 选中的麦克风设备 id（null = 系统默认）
  String _micLabel = '麦克风';
  String? _speakerDeviceId; // 选中的扬声器设备 id（null = ADM 默认）
  String _speakerLabel = '扬声器';
  bool _wsConnected = false;
  String? _error;

  final _scaffoldKey = GlobalKey<ScaffoldState>();
  final Floating? _floating = Platform.isAndroid ? Floating() : null; // 画中画
  bool _pipArmed = false; // 是否已挂「切后台自动进画中画」

  @override
  void initState() {
    super.initState();
    _api = OopzApiClient(baseUrl: widget.baseUrl);
    _init();
  }

  String get _wsBaseUrl => widget.baseUrl
      .replaceFirst('https://', 'wss://')
      .replaceFirst('http://', 'ws://');

  Future<void> _init({int? domainId}) async {
    try {
      final bootstrap =
          await _api.bootstrap(widget.auth.token, domainId: domainId);
      if (!mounted) return;
      setState(() {
        _bootstrap = bootstrap;
        _currentDomainId = bootstrap.domainId;
      });
      _fetchDomains();

      final socket = SocketClient(
        wsBaseUrl: _wsBaseUrl,
        token: widget.auth.token,
        domainId: bootstrap.domainId,
        onEvent: _handleSocketEvent,
        onStatus: (connected) {
          if (mounted) setState(() => _wsConnected = connected);
        },
      );
      _socket = socket;

      _rtc = RTCController(
        socket: socket,
        getCurrentVoiceChannelId: () => _currentVoiceChannelId,
        getCurrentUser: () => widget.auth.user,
        getVoiceMembers: () => _voiceMembers,
        getIceServers: () => bootstrap.iceServers,
        onMediaChanged: (media) async {
          await _syncScreenRenderers(media);
          if (mounted) setState(() {});
        },
        onDiagnosticsChanged: (diagnostics) {
          if (mounted) setState(() => _diagnostics = diagnostics);
        },
        onLocalAudioChanged: (_) {},
        onScreenSharingChanged: (sharing) {
          if (!mounted) return;
          setState(() => _screenSharing = sharing);
          unawaited(_syncLocalScreenRenderer());
          unawaited(_updateKeepAliveNotification());
        },
        onAudioOnlySharingChanged: (sharing) {
          if (!mounted) return;
          setState(() => _audioOnlySharing = sharing);
          unawaited(_updateKeepAliveNotification());
        },
        onNotice: (kind, title, message) => _notify('$title：$message'),
        onSpeakingChanged: (ids) {
          if (mounted) setState(() => _speakingUsers = ids);
        },
      );

      // 恢复上次选择的麦克风（未连麦时只记住选择，进语音频道时生效）。
      final savedMic = await SessionStore.loadMicDeviceId();
      _micDeviceId = savedMic;
      unawaited(_rtc!.setMicrophone(savedMic));
      // 恢复上次选择的扬声器（Windows 上 ADM 默认常是虚拟声卡，必须让用户显式选真实输出）。
      final savedSpeaker = await SessionStore.loadSpeakerDeviceId();
      _speakerDeviceId = savedSpeaker;
      unawaited(_rtc!.setAudioOutput(savedSpeaker));

      _screening = ScreeningController(
        socket: socket,
        getCurrentUser: () => widget.auth.user,
        onChanged: () {
          if (mounted) setState(() {});
          unawaited(_syncPipWithScreeningVideo());
          unawaited(_updateKeepAliveNotification());
        },
        onError: _notify,
      );

      socket.connect();
      _refreshDomainPresence();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  /// 拉取域级在场（侧边栏各频道成员）。事件驱动，做去抖避免频繁请求。
  Future<void> _refreshDomainPresence() async {
    final bootstrap = _bootstrap;
    if (bootstrap == null) return;
    try {
      final presence =
          await _api.domainPresence(widget.auth.token, bootstrap.domainId);
      if (mounted) setState(() => _domainPresence = presence);
    } catch (_) {
      // 侧边栏成员是锦上添花，失败不打断主流程
    }
  }

  void _scheduleDomainPresenceRefresh() {
    _presenceDebounce?.cancel();
    _presenceDebounce =
        Timer(const Duration(milliseconds: 600), _refreshDomainPresence);
  }

  Future<void> _fetchDomains() async {
    try {
      final domains = await _api.listDomains(widget.auth.token);
      if (mounted) setState(() => _domains = domains);
    } catch (_) {
      // 域列表失败不影响主流程
    }
  }

  /// 切换到另一个域：退出当前会话 → 拆掉旧 socket/控制器 → 用新 domainId 重新初始化。
  Future<void> _switchDomain(int domainId) async {
    if (domainId == _currentDomainId) return;
    await _leaveCurrentSession();
    _presenceDebounce?.cancel();
    _socket?.close();
    await _screening?.dispose();
    for (final r in _screenRenderers.values) {
      await r.dispose();
    }
    _screenRenderers.clear();
    setState(() {
      _bootstrap = null; // 显示加载态
      _viewingChannel = null;
      _voiceMembers.clear();
      _diagnostics = {};
      _domainPresence = DomainPresence.empty;
      _socket = null;
      _rtc = null;
      _screening = null;
    });
    await _init(domainId: domainId);
  }

  Future<void> _createDomainFlow() async {
    final nameController = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF1E1E1E),
        title: const Text('创建新域'),
        content: TextField(
          controller: nameController,
          autofocus: true,
          decoration: const InputDecoration(labelText: '域名称'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('创建')),
        ],
      ),
    );
    final name = nameController.text.trim();
    nameController.dispose();
    if (ok != true || name.isEmpty) return;
    try {
      final domain = await _api.createDomain(widget.auth.token, name: name);
      await _fetchDomains();
      await _switchDomain(domain.id); // 创建后自动进入新域
    } catch (e) {
      _notify('创建域失败：$e');
    }
  }

  void _showDomainSwitcher() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF1A1A1A),
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 4, 20, 8),
              child: Text('切换域',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final d in _domains)
                    ListTile(
                      leading: CircleAvatar(
                        backgroundColor: _parseColor(d.accentColor),
                        child: Text(
                          d.name.isNotEmpty ? d.name[0].toUpperCase() : '?',
                          style: const TextStyle(
                              color: Color(0xFF051017),
                              fontWeight: FontWeight.w700),
                        ),
                      ),
                      title: Text(d.name),
                      subtitle: d.description.isNotEmpty
                          ? Text(d.description,
                              maxLines: 1, overflow: TextOverflow.ellipsis)
                          : null,
                      trailing: d.id == _currentDomainId
                          ? const Icon(Icons.check, color: Color(0xFF6DE2D2))
                          : null,
                      onTap: () {
                        Navigator.pop(ctx);
                        _switchDomain(d.id);
                      },
                    ),
                ],
              ),
            ),
            const Divider(height: 1, color: Color(0xFF2A2A2A)),
            ListTile(
              leading: const Icon(Icons.add, color: Color(0xFF6DE2D2)),
              title: const Text('创建新域'),
              onTap: () {
                Navigator.pop(ctx);
                _createDomainFlow();
              },
            ),
          ],
        ),
      ),
    );
  }

  /// 点左下角头像：账号菜单（当前用户 + 退出登录）。
  void _showAccountMenu() {
    final me = widget.auth.user;
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF1A1A1A),
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: CircleAvatar(
                backgroundColor: _parseColor(me.avatarColor),
                child: Text(
                  me.displayName.isNotEmpty
                      ? me.displayName[0].toUpperCase()
                      : '?',
                  style: const TextStyle(
                      color: Color(0xFF051017), fontWeight: FontWeight.w700),
                ),
              ),
              title: Text(me.displayName),
              subtitle: me.handle.isNotEmpty ? Text('@${me.handle}') : null,
            ),
            const Divider(height: 1, color: Color(0xFF2A2A2A)),
            ListTile(
              leading: const Icon(Icons.palette_outlined,
                  color: Color(0xFF6DE2D2)),
              title: const Text('切换皮肤'),
              subtitle: const Text('纯色主题'),
              onTap: () {
                Navigator.pop(ctx);
                _showSkinPicker();
              },
            ),
            ListTile(
              leading: const Icon(Icons.open_in_new, color: Color(0xFF6DE2D2)),
              title: const Text('在 GitHub 查看项目'),
              subtitle: const Text('github.com/lonelymeko/Xi_Oopz'),
              onTap: () {
                Navigator.pop(ctx);
                _openGithub();
              },
            ),
            const Divider(height: 1, color: Color(0xFF2A2A2A)),
            ListTile(
              leading: Icon(Icons.logout,
                  color: Theme.of(context).colorScheme.error),
              title: const Text('退出登录'),
              onTap: () {
                Navigator.pop(ctx);
                _logout();
              },
            ),
          ],
        ),
      ),
    );
  }

  Color _parseColor(String hex) {
    try {
      return Color(int.parse('ff${hex.replaceFirst('#', '')}', radix: 16));
    } catch (_) {
      return const Color(0xFF6DE2D2);
    }
  }

  /// 退出登录：断开会话 + 清除本地登录态 + 回到登录页。
  Future<void> _logout() async {
    await _leaveCurrentSession();
    _socket?.close();
    await SessionStore.clear();
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const LoginPage()),
    );
  }

  void _notify(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  // ---- 桌面无边框窗口：拖动 + 最小化/最大化/关闭 ----

  bool get _isDesktop =>
      Platform.isWindows || Platform.isLinux || Platform.isMacOS;

  Future<void> _startWindowDrag() async {
    if (_isDesktop) await windowManager.startDragging();
  }

  Future<void> _toggleMaximize() async {
    if (!_isDesktop) return;
    if (await windowManager.isMaximized()) {
      await windowManager.unmaximize();
    } else {
      await windowManager.maximize();
    }
  }

  List<Widget> _windowControls() {
    if (!_isDesktop) return const [];
    return [
      _winBtn(Icons.remove, '最小化', () => windowManager.minimize()),
      _winBtn(Icons.crop_square, '最大化 / 还原', _toggleMaximize),
      _winBtn(Icons.close, '关闭', () => windowManager.close()),
    ];
  }

  Widget _winBtn(IconData icon, String tip, VoidCallback onTap) => IconButton(
        icon: Icon(icon, size: 16),
        tooltip: tip,
        color: Colors.white70,
        splashRadius: 18,
        onPressed: onTap,
      );

  // ---- 皮肤 / GitHub ----

  Future<void> _showSkinPicker() async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppSkin.preset.surface,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('切换皮肤',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              const SizedBox(height: 2),
              const Text('暂时只支持纯色',
                  style: TextStyle(fontSize: 12, color: Colors.white54)),
              const SizedBox(height: 16),
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  for (final p in AppSkin.presets)
                    GestureDetector(
                      onTap: () async {
                        await AppSkin.select(p.id);
                        if (ctx.mounted) Navigator.pop(ctx);
                      },
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            width: 46,
                            height: 46,
                            decoration: BoxDecoration(
                              color: p.base,
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: AppSkin.currentId.value == p.id
                                    ? p.accent
                                    : Colors.white24,
                                width:
                                    AppSkin.currentId.value == p.id ? 3 : 1,
                              ),
                            ),
                            child: Center(
                              child: Container(
                                width: 18,
                                height: 18,
                                decoration: BoxDecoration(
                                  color: p.accent,
                                  shape: BoxShape.circle,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(p.name,
                              style: const TextStyle(
                                  fontSize: 11, color: Colors.white70)),
                        ],
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
    if (mounted) setState(() {});
  }

  Future<void> _openGithub() async {
    final uri = Uri.parse('https://github.com/lonelymeko/Xi_Oopz');
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (e) {
      _notify('打开浏览器失败：$e');
    }
  }

  /// 维护本端屏幕共享的本地预览渲染器（远端预览走 _screenRenderers）。
  Future<void> _syncLocalScreenRenderer() async {
    final stream = _rtc?.localScreenStream;
    if (_screenSharing && stream != null) {
      var renderer = _localScreenRenderer;
      if (renderer == null) {
        renderer = RTCVideoRenderer();
        await renderer.initialize();
        _localScreenRenderer = renderer;
      }
      renderer.srcObject = stream;
      if (mounted) setState(() {});
    } else if (_localScreenRenderer != null) {
      final renderer = _localScreenRenderer;
      _localScreenRenderer = null;
      await renderer?.dispose();
      if (mounted) setState(() {});
    }
  }

  Future<void> _syncScreenRenderers(Map<int, RemoteMedia> media) async {
    for (final entry in media.entries) {
      final stream = entry.value.screenStream;
      if (stream == null) continue;
      var renderer = _screenRenderers[entry.key];
      if (renderer == null) {
        renderer = RTCVideoRenderer();
        await renderer.initialize();
        _screenRenderers[entry.key] = renderer;
      }
      renderer.srcObject = stream;
    }
    for (final userId in _screenRenderers.keys.toList()) {
      if (media[userId]?.screenStream == null) {
        await _screenRenderers.remove(userId)?.dispose();
      }
    }
    // 正在全屏观看的共享如果已结束（渲染器被移除）→ 自动退出投屏界面。
    final expanded = _expandedShareUserId;
    if (expanded != null && _screenRenderers[expanded] == null) {
      _expandedShareUserId = null;
    }
  }

  void _handleSocketEvent(String type, Map<String, dynamic> payload) {
    switch (type) {
      case 'ready':
        // WS 重连后恢复语音和放映室在场
        final vc = _currentVoiceChannelId;
        if (vc != null && _pendingJoinChannelId != vc) {
          _socket?.send('channel.join', {'channelId': vc});
        }
        final sc = _activeScreeningChannelId;
        if (sc != null) _socket?.send('screening.join', {'channelId': sc});
        break;
      case 'presence.snapshot':
        final channelId = (payload['channelId'] as num?)?.toInt();
        final members = (payload['members'] as List<dynamic>? ?? const [])
            .map((m) => PresenceMember.fromJson(m as Map<String, dynamic>))
            .toList();
        setState(() {
          _currentVoiceChannelId = channelId;
          _pendingJoinChannelId = null;
          _voiceMembers
            ..clear()
            ..addEntries(members.map((m) => MapEntry(m.user.id, m)));
        });
        _rtc?.handlePresenceSnapshot(members);
        _scheduleDomainPresenceRefresh();
        unawaited(_updateKeepAliveNotification());
        break;
      case 'member.joined':
        final member = PresenceMember.fromJson(payload);
        setState(() => _voiceMembers[member.user.id] = member);
        _rtc?.handleMemberJoined(member);
        _scheduleDomainPresenceRefresh();
        unawaited(_updateKeepAliveNotification());
        break;
      case 'member.left':
        final userId =
            ((payload['user'] as Map<String, dynamic>?)?['id'] as num?)
                    ?.toInt() ??
                (payload['userId'] as num?)?.toInt();
        if (userId != null) {
          setState(() => _voiceMembers.remove(userId));
          _rtc?.handleMemberLeft(userId);
        }
        _scheduleDomainPresenceRefresh();
        unawaited(_updateKeepAliveNotification());
        break;
      case 'voice.state':
        final userId = (payload['userId'] as num?)?.toInt();
        final micEnabled = payload['micEnabled'] as bool? ?? true;
        if (userId != null) {
          final m = _voiceMembers[userId];
          if (m != null) {
            setState(() => _voiceMembers[userId] = PresenceMember(
                  user: m.user,
                  micEnabled: micEnabled,
                  screenSharing: m.screenSharing,
                ));
          }
          _rtc?.handleVoiceState(userId, micEnabled);
        }
        break;
      case 'screen.state':
        final userId = (payload['userId'] as num?)?.toInt();
        final screenSharing = payload['screenSharing'] as bool? ?? false;
        if (userId != null) {
          final m = _voiceMembers[userId];
          if (m != null) {
            setState(() => _voiceMembers[userId] = PresenceMember(
                  user: m.user,
                  micEnabled: m.micEnabled,
                  screenSharing: screenSharing,
                ));
          }
          _rtc?.handleScreenState(userId, screenSharing);
        }
        break;
      case 'rtc.offer':
      case 'rtc.answer':
      case 'rtc.ice_candidate':
      case 'rtc.reset':
      case 'media.sync_request':
      case 'screen.sync_request':
        _rtc?.handleSignal(type, payload);
        break;
      case 'screening.snapshot':
      case 'screening.playlist.updated':
      case 'screening.controller.changed':
      case 'screening.play':
      case 'screening.pause':
      case 'screening.seek':
      case 'screening.tick':
      case 'screening.rate':
        _screening?.handleEvent(type, payload);
        if (type == 'screening.snapshot') _scheduleDomainPresenceRefresh();
        break;
      default:
        break;
    }
  }

  // ---- 频道选择 ----

  Future<void> _selectChannel(ChannelInfo channel) async {
    setState(() => _viewingChannel = channel);
    _scaffoldKey.currentState?.closeDrawer();

    // 切到任何别的频道，都退出当前放映室（放映室不像语音那样后台保持）
    if (_activeScreeningChannelId != null &&
        _activeScreeningChannelId != channel.id) {
      await _leaveScreening();
      await _leaveVoice();
    }

    switch (channel.type) {
      case 'voice':
        if (_currentVoiceChannelId != channel.id) {
          await _leaveVoice();
          await _joinVoice(channel);
        }
        break;
      case 'screening':
        // 放映室 = 视频同步(screening.join) + 连麦(joinVoice 同一个 channelId)
        if (_activeScreeningChannelId != channel.id) {
          if (_currentVoiceChannelId != channel.id) await _leaveVoice();
          _joinScreening(channel);
          await _joinVoice(channel);
        }
        break;
      default:
        // 文字频道：保持当前语音连麦（Discord 风格），只切视图
        break;
    }
  }

  /// 底部「离开」：若在放映室则连视频带连麦一起退，否则只退语音。
  Future<void> _leaveCurrentSession() async {
    if (_activeScreeningChannelId != null) {
      await _leaveScreening();
    }
    await _leaveVoice();
  }

  Future<void> _joinVoice(ChannelInfo channel) async {
    _pendingJoinChannelId = channel.id;
    setState(() => _currentVoiceChannelId = channel.id);
    await _rtc?.joinVoice(channel.id);
    await _rtc?.setSpeakerphone(_speakerOn);
    // joinVoice 内部可能自动挑了"真实"麦克风/扬声器（避开虚拟声卡），同步到 UI 勾选态/标签。
    if (mounted) {
      setState(() {
        _micDeviceId = _rtc?.audioInputDeviceId;
        _speakerDeviceId = _rtc?.audioOutputDeviceId;
      });
    }
    unawaited(_refreshMicLabel());
    unawaited(_refreshSpeakerLabel());
    await _updateKeepAliveNotification();
  }

  Future<void> _leaveVoice() async {
    if (_currentVoiceChannelId == null) return;
    await _rtc?.leaveVoice();
    await BackgroundKeepAlive.stop();
    setState(() {
      _currentVoiceChannelId = null;
      _pendingJoinChannelId = null;
      _voiceMembers.clear();
      _diagnostics = {};
      _screenSharing = false;
    });
  }

  void _joinScreening(ChannelInfo channel) {
    setState(() => _activeScreeningChannelId = channel.id);
    _screening?.join(channel.id);
    unawaited(_syncPipWithScreeningVideo());
  }

  Future<void> _leaveScreening() async {
    if (_activeScreeningChannelId == null) return;
    await _screening?.leave();
    await _disarmPip();
    setState(() => _activeScreeningChannelId = null);
  }

  ChannelInfo? _channelById(int? channelId) {
    if (channelId == null) return null;
    final channels = _bootstrap?.channels;
    if (channels == null) return null;
    for (final channel in channels) {
      if (channel.id == channelId) return channel;
    }
    return null;
  }

  int _roomMemberCount(int channelId) {
    final screening = _screening;
    final viewerCount = _activeScreeningChannelId == channelId
        ? (screening?.viewers.length ?? 0)
        : 0;
    final voiceCount = _voiceMembers.length;
    final presenceCount = _domainPresence.membersByChannel[channelId]?.length ??
        _domainPresence.onlineCounts[channelId] ??
        0;
    final knownCount = [
      viewerCount,
      voiceCount,
      presenceCount,
    ].fold<int>(0, (max, count) => count > max ? count : max);
    return knownCount == 0 ? 1 : knownCount;
  }

  Future<void> _updateKeepAliveNotification() async {
    final channelId = _currentVoiceChannelId;
    if (channelId == null) return;
    final channel = _channelById(channelId);
    final inScreening =
        _activeScreeningChannelId == channelId || channel?.type == 'screening';
    final channelKind = inScreening ? '视频频道' : '语音频道';
    final channelName = channel?.name ?? '频道';
    final count = _roomMemberCount(channelId);
    // 共享屏幕时优先提示共享状态，通知文案与实际状态一致；前台服务类型由原生侧
    // 按 screenSharing 动态决定（仅在授权后带 mediaProjection）。
    final text = _screenSharing
        ? '正在共享屏幕 · 在$channelKind中 · 房间 $count 人'
        : '正在连麦中 · 在$channelKind中 · 房间 $count 人';
    await BackgroundKeepAlive.start(
      title: 'Oopz · $channelName',
      text: text,
      screenSharing: _screenSharing,
    );
  }

  Future<void> _syncPipWithScreeningVideo() async {
    final screening = _screening;
    final shouldArm =
        _activeScreeningChannelId != null && (screening?.videoReady ?? false);
    if (shouldArm) {
      await _armPip();
    } else {
      await _disarmPip();
    }
  }

  /// Android：仅当放映室已有可播放视频时挂载「离开 App 自动进画中画」。
  Future<void> _armPip() async {
    final floating = _floating;
    if (floating == null || _pipArmed) return;
    try {
      if (await floating.isPipAvailable) {
        await floating.enable(const OnLeavePiP(aspectRatio: Rational(16, 9)));
        _pipArmed = true;
      }
    } catch (_) {
      // PiP 不可用则忽略（老系统/未授权）
    }
  }

  Future<void> _disarmPip() async {
    final floating = _floating;
    if (floating == null || !_pipArmed) return;
    _pipArmed = false;
    try {
      await floating.cancelOnLeavePiP();
    } catch (_) {}
  }

  @override
  void dispose() {
    _presenceDebounce?.cancel();
    _floating?.cancelOnLeavePiP();
    BackgroundKeepAlive.stop();
    _rtc?.leaveVoice();
    _screening?.dispose();
    _socket?.close();
    for (final r in _screenRenderers.values) {
      r.dispose();
    }
    _localScreenRenderer?.dispose();
    super.dispose();
  }

  // ---- 构建 ----

  @override
  Widget build(BuildContext context) {
    if (_error != null) return _errorScaffold();
    final bootstrap = _bootstrap;
    if (bootstrap == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final sidebar = ChannelSidebar(
      domainName: bootstrap.domainName,
      me: widget.auth.user,
      channels: bootstrap.channels,
      viewingChannelId: _viewingChannel?.id,
      joinedVoiceChannelId: _currentVoiceChannelId,
      membersByChannel: _domainPresence.membersByChannel,
      onlineCounts: _domainPresence.onlineCounts,
      speakingUserIds: _speakingUsers,
      onSelect: _selectChannel,
      onDomainTap: _showDomainSwitcher,
      onMeTap: _showAccountMenu,
    );

    final page = LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= _kWideBreakpoint;
        if (wide) {
          return Scaffold(
            body: Row(
              children: [
                sidebar,
                const VerticalDivider(width: 1, color: Color(0xFF0F0F0F)),
                Expanded(
                  child: Column(
                    children: [
                      _header(showMenu: false),
                      Expanded(child: _content()),
                      if (_currentVoiceChannelId != null) _voiceBar(),
                    ],
                  ),
                ),
              ],
            ),
          );
        }
        return Scaffold(
          key: _scaffoldKey,
          drawer: Drawer(width: 240, child: sidebar),
          appBar: _appBar(),
          body: _content(),
          bottomNavigationBar:
              _currentVoiceChannelId != null ? _voiceBar() : null,
        );
      },
    );

    // 全屏观看共享：以叠加层渲染，共享消失时 _expandedShareUserId 会被清空自动退出。
    final expandedId = _expandedShareUserId;
    final expandedRenderer = expandedId == null
        ? null
        : (expandedId == widget.auth.user.id
            ? _localScreenRenderer
            : _screenRenderers[expandedId]);
    if (expandedRenderer != null) {
      final name = _voiceMembers[expandedId]?.user.displayName ?? '成员';
      return Stack(
        children: [
          page,
          Positioned.fill(
            child: ShareFullscreen(
              renderer: expandedRenderer,
              presenterName: name,
              onClose: () => setState(() => _expandedShareUserId = null),
            ),
          ),
        ],
      );
    }

    final floating = _floating;
    final screening = _screening;
    if (floating == null || screening == null) {
      return page;
    }
    return PiPSwitcher(
      floating: floating,
      duration: Duration.zero,
      childWhenEnabled: ScreeningPipVideoView(controller: screening),
      childWhenDisabled: page,
    );
  }

  Widget _errorScaffold() => Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline,
                    color: Colors.redAccent, size: 48),
                const SizedBox(height: 16),
                Text(_error!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Colors.white70)),
                const SizedBox(height: 16),
                FilledButton(
                  // token 可能已失效：清除登录态后回登录页
                  onPressed: _logout,
                  child: const Text('返回登录'),
                ),
              ],
            ),
          ),
        ),
      );

  String get _title => _viewingChannel?.name ?? _bootstrap?.domainName ?? '';

  PreferredSizeWidget _appBar() => AppBar(
        title: Text(_title),
        actions: [_wsIndicator()],
      );

  // 宽屏用自定义 header（因为放在 Column 里，不能用 Scaffold.appBar）
  // 桌面端：整条可拖动，右侧带最小化/最大化/关闭。
  Widget _header({required bool showMenu}) {
    final skin = AppSkin.preset;
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanStart: (_) => _startWindowDrag(),
      onDoubleTap: _toggleMaximize,
      child: Container(
        height: 56,
        padding: EdgeInsets.only(left: 16, right: _isDesktop ? 4 : 16),
        decoration: BoxDecoration(
          color: skin.base,
          border: Border(bottom: BorderSide(color: skin.line)),
        ),
        child: Row(
          children: [
            if (_viewingChannel != null)
              Icon(_channelIcon(_viewingChannel!.type),
                  size: 18, color: Colors.white54),
            if (_viewingChannel != null) const SizedBox(width: 8),
            Text(_title,
                style:
                    const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            const Spacer(),
            _wsIndicator(),
            ..._windowControls(),
          ],
        ),
      ),
    );
  }

  IconData _channelIcon(String type) => switch (type) {
        'voice' => Icons.graphic_eq,
        'screening' => Icons.movie_outlined,
        _ => Icons.tag,
      };

  Widget _wsIndicator() => Padding(
        padding: const EdgeInsets.only(right: 16),
        child: Center(
          child: Row(
            children: [
              Icon(Icons.circle,
                  size: 8,
                  color: _wsConnected
                      ? const Color(0xFF74D24D)
                      : Theme.of(context).colorScheme.error),
              const SizedBox(width: 6),
              Text(_wsConnected ? '在线' : '重连中',
                  style: const TextStyle(fontSize: 12, color: Colors.white70)),
            ],
          ),
        ),
      );

  /// 根据当前查看的频道类型路由内容。
  Widget _content() {
    final channel = _viewingChannel;
    if (channel == null) {
      return const _Welcome();
    }
    switch (channel.type) {
      case 'voice':
        if (_currentVoiceChannelId == channel.id) {
          return VoiceRoomView(
            currentUserId: widget.auth.user.id,
            members: _voiceMembers.values.toList(),
            diagnostics: _diagnostics,
            screenRenderers: {
              ..._screenRenderers,
              if (_screenSharing && _localScreenRenderer != null)
                widget.auth.user.id: _localScreenRenderer!,
            },
            speakingUserIds: _speakingUsers,
            onOpenShare: (userId) =>
                setState(() => _expandedShareUserId = userId),
          );
        }
        return _JoinPrompt(
          label: '加入 ${channel.name}',
          icon: Icons.graphic_eq,
          onJoin: () => _joinVoice(channel),
        );
      case 'screening':
        final screening = _screening;
        if (screening == null) {
          return const Center(child: CircularProgressIndicator());
        }
        return ScreeningView(
          controller: screening,
          currentUserId: widget.auth.user.id,
        );
      default:
        return const _TextChannelPlaceholder();
    }
  }

  Widget _voiceBar() => VoiceControls(
        micEnabled: _micEnabled,
        speakerOn: _speakerOn,
        screenSharing: _screenSharing,
        audioOnlySharing: _audioOnlySharing,
        micLabel: _micLabel,
        speakerLabel: _speakerLabel,
        micDeviceId: _micDeviceId,
        speakerDeviceId: _speakerDeviceId,
        loadMics: _loadMicItems,
        loadSpeakers: _loadSpeakerItems,
        onSelectMic: (id) async {
          await _rtc?.setMicrophone(id);
          await SessionStore.saveMicDeviceId(id);
          if (!mounted) return;
          setState(() => _micDeviceId = id);
          await _refreshMicLabel();
        },
        onSelectSpeaker: (id) async {
          await _rtc?.setAudioOutput(id);
          await SessionStore.saveSpeakerDeviceId(id);
          if (!mounted) return;
          setState(() => _speakerDeviceId = id);
          await _refreshSpeakerLabel();
        },
        onToggleMic: () async {
          final next = !_micEnabled;
          await _rtc?.toggleMic(next);
          setState(() => _micEnabled = next);
        },
        onToggleSpeaker: () async {
          final next = !_speakerOn;
          await _rtc?.setSpeakerphone(next);
          setState(() => _speakerOn = next);
        },
        onToggleAudioOnlyShare: _toggleAudioOnlyShare,
        onToggleScreenShare: _toggleScreenShare,
        onLeave: _leaveCurrentSession,
      );

  Future<List<DeviceMenuItem>> _loadMicItems() async {
    var devices = await _rtc?.listAudioInputs() ?? const [];
    if (devices.isEmpty) {
      await _rtc?.primeAudioDevices();
      devices = await _rtc?.listAudioInputs() ?? const [];
    }
    return [
      const DeviceMenuItem(id: '', label: '系统默认'),
      ...devices
          .map((d) => DeviceMenuItem(id: d.deviceId, label: _deviceLabel(d))),
    ];
  }

  Future<List<DeviceMenuItem>> _loadSpeakerItems() async {
    var devices = await _rtc?.listAudioOutputs() ?? const [];
    if (devices.isEmpty) {
      await _rtc?.primeAudioDevices();
      devices = await _rtc?.listAudioOutputs() ?? const [];
    }
    return [
      const DeviceMenuItem(id: '', label: 'ADM 默认'),
      ...devices
          .map((d) => DeviceMenuItem(id: d.deviceId, label: _deviceLabel(d))),
    ];
  }

  /// 刷新麦克风按钮上的设备名（需 getUserMedia 过一次设备 label 才可用）。
  Future<void> _refreshMicLabel() async {
    final rtc = _rtc;
    if (rtc == null) return;
    final devices = await rtc.listAudioInputs();
    if (!mounted) return;
    String label = '麦克风';
    if (_micDeviceId != null) {
      final match = devices.where((d) => d.deviceId == _micDeviceId).toList();
      label = match.isNotEmpty && match.first.label.isNotEmpty
          ? _shortLabel(match.first.label)
          : '已选麦克风';
    } else if (devices.isNotEmpty && devices.first.label.isNotEmpty) {
      label = _shortLabel(devices.first.label);
    }
    setState(() => _micLabel = label);
  }

  static String _shortLabel(String raw) =>
      raw.length <= 10 ? raw : '${raw.substring(0, 9)}…';

  static String _deviceLabel(MediaDeviceInfo d) => d.label.isNotEmpty
      ? d.label
      : (d.deviceId.length <= 8 ? d.deviceId : d.deviceId.substring(0, 8));

  /// 刷新扬声器按钮上的设备名。
  Future<void> _refreshSpeakerLabel() async {
    final rtc = _rtc;
    if (rtc == null) return;
    final devices = await rtc.listAudioOutputs();
    if (!mounted) return;
    String label = '扬声器';
    if (_speakerDeviceId != null) {
      final match = devices.where((d) => d.deviceId == _speakerDeviceId).toList();
      label = match.isNotEmpty && match.first.label.isNotEmpty
          ? _shortLabel(match.first.label)
          : '已选扬声器';
    }
    setState(() => _speakerLabel = label);
  }

  /// 桌面端开始屏幕共享前询问是否一并共享系统音频。返回 null = 用户取消。
  Future<bool?> _askShareAudio() {
    return showModalBottomSheet<bool>(
      context: context,
      backgroundColor: const Color(0xFF1A1A1A),
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 4, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('开始屏幕共享',
                    style:
                        TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              ),
            ),
            ListTile(
              leading:
                  const Icon(Icons.volume_up, color: Color(0xFF6DE2D2)),
              title: const Text('共享画面 + 系统音频'),
              subtitle: const Text('把电脑声音也分享给频道成员'),
              onTap: () => Navigator.pop(ctx, true),
            ),
            ListTile(
              leading:
                  const Icon(Icons.screen_share, color: Color(0xFF6DE2D2)),
              title: const Text('只共享画面'),
              subtitle: const Text('不采集系统音频'),
              onTap: () => Navigator.pop(ctx, false),
            ),
          ],
        ),
      ),
    );
  }

  /// 切换"只共享系统音频"（无画面）。
  Future<void> _toggleAudioOnlyShare() async {
    final rtc = _rtc;
    if (rtc == null) return;
    if (_currentVoiceChannelId == null) {
      _notify('请先进入语音频道再共享音频');
      return;
    }
    if (rtc.audioOnlySharing) {
      await rtc.stopAudioOnlyShare();
      await _updateKeepAliveNotification();
      return;
    }
    if (rtc.screenSharing) {
      await rtc.stopScreenShare();
    }
    final started = await rtc.startAudioOnlyShare();
    if (started) {
      _notify('已开始共享系统音频');
    }
    await _updateKeepAliveNotification();
  }

  /// 切换屏幕共享。授权框被取消时 startScreenShare 返回 false，属正常路径不弹错误。
  Future<void> _toggleScreenShare() async {
    final rtc = _rtc;
    if (rtc == null) return;
    if (_currentVoiceChannelId == null) {
      _notify('请先进入语音频道再共享屏幕');
      return;
    }
    // 与 Web 端一致：放映室连麦是同步观影用的，不支持叠加屏幕共享
    if (_activeScreeningChannelId != null &&
        _activeScreeningChannelId == _currentVoiceChannelId) {
      _notify('放映室连麦暂不支持屏幕共享');
      return;
    }
    if (rtc.screenSharing) {
      await rtc.stopScreenShare();
      await _updateKeepAliveNotification();
      return;
    }
    // 桌面端先问是否带系统音频；取消则不开始。
    bool shareAudio = false;
    if (!Platform.isAndroid && !Platform.isIOS) {
      final choice = await _askShareAudio();
      if (choice == null || !mounted) return;
      shareAudio = choice;
    }
    final started = await rtc.startScreenShare(shareAudio: shareAudio);
    if (started) {
      _notify(shareAudio ? '已开始共享屏幕（含系统音频）' : '已开始共享屏幕');
    }
    await _updateKeepAliveNotification();
  }
}

class _Welcome extends StatelessWidget {
  const _Welcome();
  @override
  Widget build(BuildContext context) => const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.forum_outlined, size: 56, color: Colors.white24),
            SizedBox(height: 16),
            Text('从左侧选择一个频道',
                style: TextStyle(color: Colors.white38, fontSize: 15)),
          ],
        ),
      );
}

class _TextChannelPlaceholder extends StatelessWidget {
  const _TextChannelPlaceholder();
  @override
  Widget build(BuildContext context) => const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.chat_bubble_outline, size: 48, color: Colors.white24),
            SizedBox(height: 12),
            Text('文字频道即将上线', style: TextStyle(color: Colors.white38)),
          ],
        ),
      );
}

class _JoinPrompt extends StatelessWidget {
  final String label;
  final IconData icon;
  final VoidCallback onJoin;
  const _JoinPrompt(
      {required this.label, required this.icon, required this.onJoin});
  @override
  Widget build(BuildContext context) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 48, color: const Color(0xFF6DE2D2)),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onJoin,
              icon: const Icon(Icons.login),
              label: Text(label),
            ),
          ],
        ),
      );
}

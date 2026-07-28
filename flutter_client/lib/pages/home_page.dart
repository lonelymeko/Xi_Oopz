import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:floating/floating.dart';

import '../oopz_rtc.dart';
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
  final Map<int, RTCVideoRenderer> _screenRenderers = {};
  bool _micEnabled = true;
  bool _speakerOn = false; // false = 蓝牙/有线耳机优先，true = 强制扬声器
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
        onNotice: (kind, title, message) => _notify('$title：$message'),
      );

      _screening = ScreeningController(
        socket: socket,
        getCurrentUser: () => widget.auth.user,
        onChanged: () {
          if (mounted) setState(() {});
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
        break;
      case 'member.joined':
        final member = PresenceMember.fromJson(payload);
        setState(() => _voiceMembers[member.user.id] = member);
        _rtc?.handleMemberJoined(member);
        _scheduleDomainPresenceRefresh();
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
    // Android：拉起前台服务，切后台/息屏不杀语音
    await BackgroundKeepAlive.start(
      title: 'Oopz · ${channel.name}',
      text: '语音连麦进行中',
    );
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
    });
  }

  void _joinScreening(ChannelInfo channel) {
    setState(() => _activeScreeningChannelId = channel.id);
    _screening?.join(channel.id);
    _armPip(); // 放映室：挂「切后台自动进画中画」
  }

  Future<void> _leaveScreening() async {
    if (_activeScreeningChannelId == null) return;
    await _screening?.leave();
    await _disarmPip();
    setState(() => _activeScreeningChannelId = null);
  }

  /// Android：进入放映室时挂载「离开 App 自动进画中画」，视频在后台小窗继续播。
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
      onSelect: _selectChannel,
      onDomainTap: _showDomainSwitcher,
      onMeTap: _showAccountMenu,
    );

    return LayoutBuilder(
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
  Widget _header({required bool showMenu}) => Container(
        height: 56,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: const BoxDecoration(
          color: Color(0xFF121212),
          border: Border(bottom: BorderSide(color: Color(0xFF0F0F0F))),
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
          ],
        ),
      );

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
            screenRenderers: _screenRenderers,
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
        onLeave: _leaveCurrentSession,
      );
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

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'oopz_rtc.dart';

void main() {
  runApp(const OopzApp());
}

class OopzApp extends StatelessWidget {
  const OopzApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Oopz Live',
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF121212),
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF6DE2D2),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: const LoginPage(),
    );
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _serverController =
      TextEditingController(text: 'http://192.168.1.10:8080');
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _login() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final baseUrl = _serverController.text.trim().replaceAll(RegExp(r'/+$'), '');
      final api = OopzApiClient(baseUrl: baseUrl);
      final auth = await api.login(
        _emailController.text.trim(),
        _passwordController.text,
      );
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => VoiceRoomPage(baseUrl: baseUrl, auth: auth),
      ));
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Oopz Live 登录')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          children: [
            TextField(
              controller: _serverController,
              decoration: const InputDecoration(labelText: '服务器地址'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _emailController,
              decoration: const InputDecoration(labelText: '邮箱'),
              keyboardType: TextInputType.emailAddress,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _passwordController,
              decoration: const InputDecoration(labelText: '密码'),
              obscureText: true,
            ),
            const SizedBox(height: 24),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(_error!,
                    style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ),
            FilledButton(
              onPressed: _busy ? null : _login,
              child: Text(_busy ? '登录中…' : '登录'),
            ),
          ],
        ),
      ),
    );
  }
}

class VoiceRoomPage extends StatefulWidget {
  final String baseUrl;
  final AuthResponse auth;

  const VoiceRoomPage({super.key, required this.baseUrl, required this.auth});

  @override
  State<VoiceRoomPage> createState() => _VoiceRoomPageState();
}

class _VoiceRoomPageState extends State<VoiceRoomPage> {
  late final OopzApiClient _api;
  BootstrapData? _bootstrap;
  SocketClient? _socket;
  RTCController? _rtc;

  int? _currentVoiceChannelId;
  int? _pendingJoinChannelId;
  final Map<int, PresenceMember> _voiceMembers = {};
  Map<int, PeerDiagnostics> _diagnostics = {};
  final Map<int, RTCVideoRenderer> _screenRenderers = {};
  bool _micEnabled = true;
  bool _speakerOn = true;
  bool _wsConnected = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _api = OopzApiClient(baseUrl: widget.baseUrl);
    _init();
  }

  String get _wsBaseUrl => widget.baseUrl
      .replaceFirst('https://', 'wss://')
      .replaceFirst('http://', 'ws://');

  Future<void> _init() async {
    try {
      final bootstrap = await _api.bootstrap(widget.auth.token);
      setState(() => _bootstrap = bootstrap);

      final socket = SocketClient(
        wsBaseUrl: _wsBaseUrl,
        token: widget.auth.token,
        domainId: bootstrap.domainId,
        onEvent: _handleSocketEvent,
        onStatus: (connected) => setState(() => _wsConnected = connected),
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
        onNotice: (kind, title, message) {
          if (!mounted) return;
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('$title：$message')),
          );
        },
      );

      socket.connect();
    } catch (e) {
      setState(() => _error = e.toString());
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
  }

  void _handleSocketEvent(String type, Map<String, dynamic> payload) {
    switch (type) {
      case 'ready':
        // WS 重连后自动补 channel.join，恢复语音在场（对标 web 端）
        final channelId = _currentVoiceChannelId;
        if (channelId != null && _pendingJoinChannelId != channelId) {
          _socket?.send('channel.join', {'channelId': channelId});
        }
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
        break;
      case 'member.joined':
        final member = PresenceMember.fromJson(payload);
        setState(() => _voiceMembers[member.user.id] = member);
        _rtc?.handleMemberJoined(member);
        break;
      case 'member.left':
        final userId = ((payload['user'] as Map<String, dynamic>?)?['id'] as num?)
                ?.toInt() ??
            (payload['userId'] as num?)?.toInt();
        if (userId != null) {
          setState(() => _voiceMembers.remove(userId));
          _rtc?.handleMemberLeft(userId);
        }
        break;
      case 'voice.state':
        final userId = (payload['userId'] as num?)?.toInt();
        final micEnabled = payload['micEnabled'] as bool? ?? true;
        if (userId != null) {
          final member = _voiceMembers[userId];
          if (member != null) {
            setState(() => _voiceMembers[userId] = PresenceMember(
                  user: member.user,
                  micEnabled: micEnabled,
                  screenSharing: member.screenSharing,
                ));
          }
          _rtc?.handleVoiceState(userId, micEnabled);
        }
        break;
      case 'screen.state':
        final userId = (payload['userId'] as num?)?.toInt();
        final screenSharing = payload['screenSharing'] as bool? ?? false;
        if (userId != null) {
          final member = _voiceMembers[userId];
          if (member != null) {
            setState(() => _voiceMembers[userId] = PresenceMember(
                  user: member.user,
                  micEnabled: member.micEnabled,
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
      default:
        break;
    }
  }

  Future<void> _joinVoice(ChannelInfo channel) async {
    _pendingJoinChannelId = channel.id;
    setState(() => _currentVoiceChannelId = channel.id);
    await _rtc?.joinVoice(channel.id);
    await _rtc?.setSpeakerphone(_speakerOn);
  }

  Future<void> _leaveVoice() async {
    await _rtc?.leaveVoice();
    setState(() {
      _currentVoiceChannelId = null;
      _pendingJoinChannelId = null;
      _voiceMembers.clear();
      _diagnostics = {};
    });
  }

  @override
  void dispose() {
    _rtc?.leaveVoice();
    _socket?.close();
    for (final renderer in _screenRenderers.values) {
      renderer.dispose();
    }
    super.dispose();
  }

  String _transportLabel(PeerDiagnostics? diag) {
    if (diag == null) return '连接中…';
    final transport = switch (diag.transport) {
      TransportType.lan => '局域网',
      TransportType.stun => 'STUN 直连',
      TransportType.turn => 'TURN 中继',
      TransportType.unknown => '未知链路',
    };
    final latency = diag.latencyMs != null ? ' · ${diag.latencyMs}ms' : '';
    return '$transport$latency';
  }

  @override
  Widget build(BuildContext context) {
    final bootstrap = _bootstrap;
    if (_error != null) {
      return Scaffold(body: Center(child: Text(_error!)));
    }
    if (bootstrap == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final voiceChannels =
        bootstrap.channels.where((c) => c.type == 'voice').toList();
    final inVoice = _currentVoiceChannelId != null;

    return Scaffold(
      appBar: AppBar(
        title: Text(bootstrap.domainName),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 16),
            child: Center(
              child: Text(
                _wsConnected ? 'WS 已连接' : 'WS 重连中',
                style: TextStyle(
                  fontSize: 12,
                  color: _wsConnected
                      ? const Color(0xFF74D24D)
                      : Theme.of(context).colorScheme.error,
                ),
              ),
            ),
          ),
        ],
      ),
      body: inVoice ? _buildVoiceRoom() : _buildChannelList(voiceChannels),
      bottomNavigationBar: inVoice ? _buildVoiceControls() : null,
    );
  }

  Widget _buildChannelList(List<ChannelInfo> channels) {
    return ListView.builder(
      itemCount: channels.length,
      itemBuilder: (context, index) {
        final channel = channels[index];
        return ListTile(
          leading: const Icon(Icons.graphic_eq),
          title: Text(channel.name),
          subtitle: Text('语音频道 · 上限 ${channel.maxMembers}'),
          onTap: () => _joinVoice(channel),
        );
      },
    );
  }

  Widget _buildVoiceRoom() {
    final members = _voiceMembers.values.toList();
    final sharingRenderers = _screenRenderers.entries.toList();

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        for (final entry in sharingRenderers)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: AspectRatio(
              aspectRatio: 16 / 9,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: RTCVideoView(entry.value),
              ),
            ),
          ),
        for (final member in members)
          Card(
            child: ListTile(
              leading: CircleAvatar(
                backgroundColor: Color(
                  int.parse(member.user.avatarColor.replaceFirst('#', '0xff')),
                ),
                child: Text(
                  member.user.displayName.isNotEmpty
                      ? member.user.displayName.substring(0, 1).toUpperCase()
                      : '?',
                  style: const TextStyle(color: Color(0xFF051017)),
                ),
              ),
              title: Text(member.user.displayName),
              subtitle: Text(
                member.user.id == widget.auth.user.id
                    ? '你'
                    : _transportLabel(_diagnostics[member.user.id]),
              ),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    member.micEnabled ? Icons.mic : Icons.mic_off,
                    size: 18,
                    color: member.micEnabled
                        ? const Color(0xFF6DE2D2)
                        : Theme.of(context).colorScheme.error,
                  ),
                  if (member.screenSharing)
                    const Padding(
                      padding: EdgeInsets.only(left: 8),
                      child: Icon(Icons.screen_share,
                          size: 18, color: Color(0xFFFBB45B)),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildVoiceControls() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            IconButton.filledTonal(
              onPressed: () async {
                final next = !_micEnabled;
                await _rtc?.toggleMic(next);
                setState(() => _micEnabled = next);
              },
              icon: Icon(_micEnabled ? Icons.mic : Icons.mic_off),
            ),
            IconButton.filledTonal(
              onPressed: () async {
                final next = !_speakerOn;
                await _rtc?.setSpeakerphone(next);
                setState(() => _speakerOn = next);
              },
              icon: Icon(_speakerOn ? Icons.volume_up : Icons.hearing),
            ),
            IconButton.filled(
              style: IconButton.styleFrom(
                backgroundColor: Theme.of(context).colorScheme.error,
              ),
              onPressed: _leaveVoice,
              icon: const Icon(Icons.call_end),
            ),
          ],
        ),
      ),
    );
  }
}

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:web_socket_channel/web_socket_channel.dart';

/// WS 信令客户端，1:1 对标 frontend/src/socket.ts：
/// 世代(generation)防串台、指数退避重连(上限 10s)、15s 心跳、手动关闭码 4000。
class SocketClient {
  static const int manualCloseCode = 4000;
  static const Duration heartbeatInterval = Duration(seconds: 15);

  final String wsBaseUrl; // 如 ws://192.168.1.10:8080
  final String token;
  final int domainId;
  final void Function(String type, Map<String, dynamic> payload) onEvent;
  final void Function(bool connected) onStatus;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _heartbeat;
  Timer? _reconnectTimer;
  int _reconnectAttempt = 0;
  int _generation = 0;
  bool? _lastConnectedState;
  bool _manualClose = false;

  SocketClient({
    required this.wsBaseUrl,
    required this.token,
    required this.domainId,
    required this.onEvent,
    required this.onStatus,
  });

  void _notifyStatus(bool connected) {
    if (_lastConnectedState == connected) return;
    _lastConnectedState = connected;
    onStatus(connected);
  }

  Duration _nextReconnectDelay() {
    final delayMs = math.min(1000 * math.pow(2, _reconnectAttempt).toInt(), 10000);
    _reconnectAttempt += 1;
    return Duration(milliseconds: delayMs);
  }

  void _clearTimers() {
    _heartbeat?.cancel();
    _heartbeat = null;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }

  void _scheduleReconnect() {
    if (_manualClose || _reconnectTimer != null) return;
    _reconnectTimer = Timer(_nextReconnectDelay(), () {
      _reconnectTimer = null;
      connect();
    });
  }

  void connect() {
    if (_channel != null) return;
    final generation = ++_generation;
    _manualClose = false;
    _clearTimers();

    final uri = Uri.parse(
      '$wsBaseUrl/ws?token=${Uri.encodeComponent(token)}&domainId=$domainId',
    );
    final channel = WebSocketChannel.connect(uri);
    _channel = channel;

    // web_socket_channel 没有独立的 open 事件：首帧到达即视为已连接。
    var opened = false;
    void markOpen() {
      if (opened || generation != _generation) return;
      opened = true;
      _reconnectAttempt = 0;
      _notifyStatus(true);
      _heartbeat = Timer.periodic(heartbeatInterval, (_) => send('heartbeat', {}));
    }

    _subscription = channel.stream.listen(
      (dynamic data) {
        if (generation != _generation) return;
        markOpen();
        try {
          final parsed = jsonDecode(data as String);
          if (parsed is! Map<String, dynamic>) return;
          final type = parsed['type'];
          if (type is! String) return;
          final payload = parsed['payload'];
          onEvent(
            type,
            payload is Map<String, dynamic> ? payload : <String, dynamic>{},
          );
        } catch (_) {
          // 消息解析失败直接忽略，与 web 端一致
        }
      },
      onDone: () {
        if (generation != _generation) return;
        _notifyStatus(false);
        _clearTimers();
        _subscription = null;
        _channel = null;
        _scheduleReconnect();
      },
      onError: (Object _) {
        if (generation != _generation) return;
        _notifyStatus(false);
        _clearTimers();
        _subscription = null;
        _channel = null;
        _scheduleReconnect();
      },
    );

    // 连接建立后先发 hello（与 web 端一致；服务端收到任何帧前 ready 也会推送）
    channel.ready.then((_) {
      if (generation != _generation) return;
      markOpen();
      send('hello', {});
    }).catchError((Object _) {
      // 连接失败走 onError 分支重连
    });
  }

  void close() {
    _manualClose = true;
    _generation += 1;
    _clearTimers();
    _subscription?.cancel();
    _subscription = null;
    _channel?.sink.close(manualCloseCode, 'manual-close');
    _channel = null;
    _notifyStatus(false);
  }

  void send(String type, Map<String, dynamic> payload) {
    final channel = _channel;
    if (channel == null) return;
    channel.sink.add(jsonEncode({'type': type, 'payload': payload}));
  }
}

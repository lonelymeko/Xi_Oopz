// WS 信令冒烟测试（纯 Dart，无需真机）：
// dart run tool/ws_smoke.dart <ws://host:port> <token> <domainId> <voiceChannelId>
// 预期：连接 → ready → channel.join → presence.snapshot(含自己) → 退出码 0
import 'dart:async';
import 'dart:io';

import '../lib/src/socket_client.dart';

Future<void> main(List<String> args) async {
  final wsBaseUrl = args[0];
  final token = args[1];
  final domainId = int.parse(args[2]);
  final channelId = int.parse(args[3]);

  final completer = Completer<void>();
  var gotReady = false;

  late SocketClient client;
  client = SocketClient(
    wsBaseUrl: wsBaseUrl,
    token: token,
    domainId: domainId,
    onStatus: (connected) => stdout.writeln('status: connected=$connected'),
    onEvent: (type, payload) {
      stdout.writeln('event: $type ${payload.keys.toList()}');
      if (type == 'ready') {
        gotReady = true;
        client.send('channel.join', {'channelId': channelId});
      }
      if (type == 'presence.snapshot' && !completer.isCompleted) {
        final members = payload['members'] as List<dynamic>? ?? const [];
        stdout.writeln('presence members=${members.length} channelId=${payload['channelId']}');
        completer.complete();
      }
    },
  );

  client.connect();
  await completer.future.timeout(const Duration(seconds: 15));
  client.send('channel.leave', {'channelId': channelId});
  await Future<void>.delayed(const Duration(milliseconds: 300));
  client.close();
  stdout.writeln(gotReady ? 'SMOKE OK' : 'SMOKE FAIL: no ready');
  exit(gotReady ? 0 : 1);
}

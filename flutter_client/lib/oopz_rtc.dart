/// Xi_Oopz Flutter 移动端 WebRTC 客户端库。
///
/// 对标 web 端 frontend/src/rtc.ts + socket.ts 的机制，
/// 与现有 Go 后端信令协议直接互通，可与 Web 客户端同房通话。
library oopz_rtc;

export 'src/api_client.dart';
export 'src/rtc_controller.dart';
export 'src/socket_client.dart';
export 'src/types.dart';

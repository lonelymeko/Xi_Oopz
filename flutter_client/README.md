# Oopz Flutter 移动端客户端

对标 web 端（`frontend/src/rtc.ts` + `socket.ts`）WebRTC 机制的 Flutter 实现，
走同一套 Go 后端 WS 信令协议，**可与 Web 客户端同一语音频道互通**。

## 与 Web 端的机制对照

| 机制 | Web (rtc.ts) | Flutter (rtc_controller.dart) |
|---|---|---|
| Mesh 拓扑 + offer 归属 | id 小者 initialOfferOwner / impolite | 相同 |
| 完美协商防 glare | 依赖浏览器隐式 rollback | 显式 `setLocalDescription(rollback)`（原生无隐式回滚），失败降级 recreate |
| SDP 布局 | 3 transceiver：mic 音频 / 屏幕音频 / 屏幕视频 | 相同（顺序一致，靠 mid 区分） |
| 断线梯子 | 宽限期 → ICE restart(直连) → TURN relay 重建(rtc.reset) | 相同，常量同值 |
| reset 对撞决胜 | impolite 3s 内忽略对方 reset；polite 重连多等 1.5s | 相同 |
| 建连宽限期 | 8s 内无可用 pair 只复查不重建 | 相同 |
| 重建预算/终态 | 3 次预算 + failedPeers + 通知 30s 去重 | 相同 |
| media.sync_request 补流 | 1.5s × 5 次 | 相同 |
| 重连后 rehydrate | replaceTrack(null→track) ×2 (300/1200ms) | 相同 |
| 连接诊断 | getStats → 局域网/STUN/TURN + RTT | 相同 |
| 本地音频 | Web Audio 混音（mic+屏幕音频合一轨） | **无混音**：mic 轨直发；将来屏幕音频挂第二条 transceiver（Web 接收侧本就兼容） |
| 屏幕共享 | 发送 + 接收 | **v1 仅接收**（手机发送需 MediaProjection / Broadcast Extension，接口已留） |
| 静音 | 混音 gain=0 | `track.enabled=false`（发静音帧）+ voice.state 同步 |
| 移动端专属 | — | `setSpeakerphone()` 听筒/扬声器切换 |

## 目录

```
lib/
  oopz_rtc.dart            # 库导出
  src/types.dart           # 用户/成员/媒体/诊断/bootstrap 模型
  src/socket_client.dart   # WS 信令（世代防串台/指数退避/心跳，对标 socket.ts）
  src/api_client.dart      # login / bootstrap / presence
  src/rtc_controller.dart  # 核心：mesh + 完美协商 + 重连状态机
  main.dart                # demo App：登录 → 语音频道列表 → 语音房
```

## 跑起来

本目录只含 Dart 代码，平台壳需要生成一次：

```bash
cd flutter_client
flutter create --platforms=android,ios --project-name oopz_flutter_client .
flutter pub get
flutter run   # 连上手机后
```

登录页填服务器地址（如 `http://<内网IP>:8080`，注意手机与后端同一网络；
Android 明文 HTTP 需在 `android/app/src/main/AndroidManifest.xml` 的
`<application>` 上加 `android:usesCleartextTraffic="true"`）。

### Android 权限（AndroidManifest.xml）

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<!-- 息屏/后台保持通话需前台服务 -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
```

`android/app/build.gradle` 里 `minSdkVersion` 需 ≥ 23（flutter_webrtc 要求）。

### iOS 权限（ios/Runner/Info.plist）

```xml
<key>NSMicrophoneUsageDescription</key>
<string>语音频道通话需要使用麦克风</string>
```

后台通话需在 Xcode 的 Capabilities 里勾选 Background Modes → Audio。

## 已知限制 / 待办

- 手机端**发送**屏幕共享未实现（Android 需 MediaProjection 前台服务、iOS 需
  Broadcast Upload Extension）；接收/观看 Web 端共享已完整支持。
- 未实现放映室（screening.*）同步播放，只做语音 + 共享观看。
- 本代码在无真机的沙箱环境编写，已过 `flutter analyze`，**未经真机通话验证**；
  首次联调建议：手机 + Web 各进 `squad-voice`，看成员卡片诊断是否出现
  `局域网/STUN/TURN · Xms`，双向能听到即通。

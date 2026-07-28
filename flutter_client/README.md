# Oopz Flutter 移动端客户端

对标 web 端（`frontend/src/rtc.ts` + `socket.ts`）WebRTC 机制的 Flutter 实现，
走同一套 Go 后端 HTTP + WS 信令协议，**可与 Web 客户端同一语音/放映频道互通**。

当前 Flutter 客户端覆盖移动端核心流程：登录态持久化、多域切换、频道侧边栏、语音连麦、远端投屏观看、放映室直链视频同步播放、Android 后台保活和放映室 PiP。

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
| 移动端专属 | — | 耳机优先/扬声器音频路由、前台服务通知、放映室视频 PiP |

## 移动端体验要点

- **音频路由**：默认不强制外放，使用 `setSpeakerphoneOnButPreferBluetooth()`，优先蓝牙耳机，再有线耳机，没有耳机时走扬声器；用户点“扬声器”时才强制外放。
- **后台通知**：Android 进入语音/放映频道后启动前台服务，通知文本会显示连麦状态、频道类型和房间人数，例如“正在连麦中 · 在视频频道中 · 房间 3 人”。
- **放映室全屏**：全屏页复用当前 `VideoPlayerController`，不会重新加载视频，也不会丢同步进度。
- **放映室 PiP**：不会一进放映室就启用后台小窗；只有视频加载成功后才挂 `OnLeavePiP`。进入 PiP 后用 `PiPSwitcher` 切到纯视频视图，只显示正在播放的视频，不显示成员状态、频道栏、播放列表或底部连麦栏。

## 目录

```
lib/
  oopz_rtc.dart            # 库导出
  src/types.dart           # 用户/成员/媒体/诊断/bootstrap 模型
  src/socket_client.dart   # WS 信令（世代防串台/指数退避/心跳，对标 socket.ts）
  src/api_client.dart      # login / bootstrap / presence
  src/rtc_controller.dart  # 核心：mesh + 完美协商 + 重连状态机
  src/screening_controller.dart # 放映室状态同步 + video_player 驱动
  pages/                   # 登录页、主页/频道切换
  widgets/                 # 语音房、放映室、频道栏、底部控制条
  main.dart                # App 入口 + 登录态恢复
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
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

`android/app/build.gradle` 里 `minSdkVersion` 需 ≥ 23（flutter_webrtc 要求）。

放映室 PiP 还需要 Activity 开启：

```xml
<activity
    android:supportsPictureInPicture="true"
    android:resizeableActivity="true"
    android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode" />
```

### iOS 权限（ios/Runner/Info.plist）

```xml
<key>NSMicrophoneUsageDescription</key>
<string>语音频道通话需要使用麦克风</string>
```

后台通话需在 Xcode 的 Capabilities 里勾选 Background Modes → Audio。

## 验证建议

```bash
cd flutter_client
flutter analyze
flutter run
```

真机重点验证：

- 蓝牙耳机 / 有线耳机连接后，语音和视频声音是否走耳机。
- 普通语音频道切后台后，前台服务通知是否显示“正在连麦中 · 在语音频道中 · 房间 N 人”。
- 放映室没有视频时切后台不会进入 PiP。
- 放映室视频加载成功后切后台进入 PiP，且小窗只显示视频画面。
- 全屏播放不重新加载视频，退出全屏后同步进度仍正常。

## 已知限制 / 待办

- 手机端**发送**屏幕共享未实现（Android 需 MediaProjection 前台服务、iOS 需
  Broadcast Upload Extension）；接收/观看 Web 端共享已完整支持。
- Android 12+ 如蓝牙设备检测不到，需要确认 `BLUETOOTH_CONNECT` 已授权。
- `flutter test` 在当前本机 Flutter master/test shell 下曾出现加载阶段连接断开；当前主要以 `flutter analyze` 和真机流程验证。

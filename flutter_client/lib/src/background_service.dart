import 'dart:io' show Platform;

import 'package:flutter_foreground_task/flutter_foreground_task.dart';

/// 前台服务的任务入口（必须是顶层函数 + vm:entry-point）。
/// 我们只需要「保活」，不做周期任务，所以处理器是空的。
@pragma('vm:entry-point')
void _keepAliveCallback() {
  FlutterForegroundTask.setTaskHandler(_KeepAliveHandler());
}

class _KeepAliveHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {}
  @override
  void onRepeatEvent(DateTime timestamp) {}
  @override
  Future<void> onDestroy(DateTime timestamp) async {}
}

/// Android 后台保活：用前台服务（带常驻通知）把进程保持在前台，
/// 避免系统在切后台/息屏时杀掉进程而中断语音连麦。
/// 仅 Android 生效；其它平台所有方法都是空操作。
class BackgroundKeepAlive {
  static bool get _supported => Platform.isAndroid;
  static bool _initialized = false;

  static void _ensureInit() {
    if (!_supported || _initialized) return;
    _initialized = true;
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'oopz_voice_keepalive',
        channelName: 'Oopz 语音保活',
        channelDescription: '保持语音连麦在后台运行',
        channelImportance: NotificationChannelImportance.LOW,
        priority: NotificationPriority.LOW,
      ),
      iosNotificationOptions: const IOSNotificationOptions(),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.nothing(),
        allowWakeLock: true,
      ),
    );
  }

  /// 进入语音/放映室时调用：拉起前台服务。
  static Future<void> start({
    required String title,
    required String text,
  }) async {
    if (!_supported) return;
    _ensureInit();
    await FlutterForegroundTask.requestNotificationPermission();
    if (await FlutterForegroundTask.isRunningService) {
      await FlutterForegroundTask.updateService(
          notificationTitle: title, notificationText: text);
      return;
    }
    await FlutterForegroundTask.startService(
      serviceId: 1001,
      notificationTitle: title,
      notificationText: text,
      callback: _keepAliveCallback,
    );
  }

  /// 离开语音/放映室时调用：停掉前台服务。
  static Future<void> stop() async {
    if (!_supported) return;
    if (await FlutterForegroundTask.isRunningService) {
      await FlutterForegroundTask.stopService();
    }
  }
}

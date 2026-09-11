import 'dart:io' show Platform;

import 'package:flutter/services.dart';

/// Android 后台保活：调用原生 `CallForegroundService`（带常驻通知的前台服务），
/// 保证切后台/息屏时麦克风采集与 WebSocket 心跳不被系统收回。
///
/// 为什么不用 flutter_foreground_task：该插件固定以
/// ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST 启动服务，会把 manifest 里所有类型
/// 一次性带上去。Android 14+ 只要带上 mediaProjection，就必须先拿到屏幕采集授权，
/// 否则 startForeground 抛 SecurityException，前台服务起不来 —— 表现就是「只是进个
/// 语音频道挂后台，几秒后通话就断」。原生服务按运行时状态动态选择类型位掩码即可绕开。
///
/// 仅 Android 生效；其它平台所有方法都是空操作。
class BackgroundKeepAlive {
  static const MethodChannel _channel = MethodChannel('oopz/foreground');

  static bool get _supported => Platform.isAndroid;

  static String _lastTitle = 'Oopz Live';
  static String _lastText = '正在连麦中';

  static Future<void> _invoke(String method, [Map<String, dynamic>? args]) async {
    if (!_supported) return;
    try {
      await _channel.invokeMethod(method, args);
    } on MissingPluginException {
      // 原生侧未注册（如热重载/其它平台）时静默忽略，不能因此打断通话。
    } on PlatformException {
      // 保活失败不阻断主流程；下一次状态变更会重试。
    }
  }

  /// 进入语音/放映室、以及在场成员数变化时调用：启动或更新前台服务。
  static Future<void> start({
    required String title,
    required String text,
    bool screenSharing = false,
  }) async {
    if (!_supported) return;
    _lastTitle = title;
    _lastText = text;
    await _invoke('start', {
      'title': title,
      'text': text,
      'screenSharing': screenSharing,
    });
  }

  /// 离开语音/放映室时调用：停掉前台服务并移除通知。
  static Future<void> stop() async {
    if (!_supported) return;
    await _invoke('stop');
  }

  /// 发起屏幕共享前调用（必须在用户已授权采集之后）：把前台服务类型升级到含
  /// mediaProjection。Android 14+ 要求 getDisplayMedia/getMediaProjection 之前，
  /// 已有该类型的前台服务在运行。
  static Future<void> startScreenShare() async {
    if (!_supported) return;
    _lastText = '正在共享屏幕';
    await _invoke('start', {
      'title': _lastTitle,
      'text': _lastText,
      'screenSharing': true,
    });
  }

  /// 停止屏幕共享后调用：降级回语音保活（仍然保留 microphone|mediaPlayback）。
  static Future<void> stopScreenShare() async {
    if (!_supported) return;
    _lastText = '正在连麦中';
    await _invoke('start', {
      'title': _lastTitle,
      'text': _lastText,
      'screenSharing': false,
    });
  }
}

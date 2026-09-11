import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:video_player_media_kit/video_player_media_kit.dart';
import 'package:window_manager/window_manager.dart';

import 'oopz_rtc.dart';
import 'pages/home_page.dart';
import 'pages/login_page.dart';
import 'src/skin.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // 桌面端：无边框窗口（自定义顶部标题栏 + 拖动 + 最小化/最大化/关闭）。
  if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
    await windowManager.ensureInitialized();
    const windowOptions = WindowOptions(
      size: Size(1280, 800),
      minimumSize: Size(1000, 640),
      center: true,
      title: 'Oopz Live',
      titleBarStyle: TitleBarStyle.hidden,
    );
    await windowManager.waitUntilReadyToShow(windowOptions, () async {
      await windowManager.show();
      await windowManager.focus();
    });
  }

  // 桌面端（Windows/Linux）video_player 没有官方实现，放映室视频会加载失败；
  // 这里用 media_kit 作为其后端，注册后 VideoPlayerController 即可正常播放。
  if (Platform.isWindows) {
    VideoPlayerMediaKit.ensureInitialized(windows: true);
  }

  // 读取上次选择的皮肤。
  await AppSkin.load();

  // 把 Flutter 框架错误的完整堆栈用醒目 tag 打到 console/logcat，方便真机抓栈：
  // adb logcat | grep OOPZ-ERR
  final previous = FlutterError.onError;
  FlutterError.onError = (details) {
    debugPrint('════ OOPZ-ERR ════\n${details.exceptionAsString()}\n'
        '${details.stack}\n══════════════════');
    previous?.call(details); // 保留默认红屏行为
  };
  runApp(const OopzApp());
}

class OopzApp extends StatelessWidget {
  const OopzApp({super.key});

  @override
  Widget build(BuildContext context) {
    // 监听皮肤变化，重建整棵主题。
    return ValueListenableBuilder<String>(
      valueListenable: AppSkin.currentId,
      builder: (context, _, __) {
        final skin = AppSkin.preset;
        return MaterialApp(
          title: 'Oopz Live',
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            brightness: Brightness.dark,
            scaffoldBackgroundColor: skin.base,
            colorScheme: ColorScheme.fromSeed(
              seedColor: skin.accent,
              brightness: Brightness.dark,
              surface: skin.surface,
            ),
            appBarTheme: AppBarTheme(
              backgroundColor: skin.base,
              elevation: 0,
              scrolledUnderElevation: 0,
            ),
            inputDecorationTheme: InputDecorationTheme(
              filled: true,
              fillColor: skin.surface,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: BorderSide.none,
              ),
            ),
            useMaterial3: true,
          ),
          home: const AuthGate(),
        );
      },
    );
  }
}

/// 启动闸门：读取本地登录态。有 → 直接进主页（免登录）；无 → 登录页。
class AuthGate extends StatefulWidget {
  const AuthGate({super.key});

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  SavedSession? _session;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    final session = await SessionStore.load();
    if (!mounted) return;
    setState(() {
      _session = session;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final session = _session;
    if (session != null) {
      return HomePage(baseUrl: session.baseUrl, auth: session.auth);
    }
    return const LoginPage();
  }
}

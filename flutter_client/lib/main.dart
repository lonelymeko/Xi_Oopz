import 'package:flutter/material.dart';

import 'oopz_rtc.dart';
import 'pages/home_page.dart';
import 'pages/login_page.dart';

void main() {
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
    return MaterialApp(
      title: 'Oopz Live',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF121212),
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF6DE2D2),
          brightness: Brightness.dark,
          surface: const Color(0xFF1E1E1E),
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xFF121212),
          elevation: 0,
          scrolledUnderElevation: 0,
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: const Color(0xFF1E1E1E),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: BorderSide.none,
          ),
        ),
        useMaterial3: true,
      ),
      home: const AuthGate(),
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

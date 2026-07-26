import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'types.dart';

/// 已保存的登录会话：服务器地址 + 鉴权信息。
class SavedSession {
  final String baseUrl;
  final AuthResponse auth;
  const SavedSession({required this.baseUrl, required this.auth});
}

/// 登录态本地持久化（用 shared_preferences 存 token/服务器/用户）。
/// 下次启动直接免登录进入；退出登录时清除。
class SessionStore {
  static const _kBaseUrl = 'session.baseUrl';
  static const _kAuth = 'session.auth';

  /// 登录成功后保存。
  static Future<void> save(String baseUrl, AuthResponse auth) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kBaseUrl, baseUrl);
    await prefs.setString(_kAuth, jsonEncode(auth.toJson()));
  }

  /// 启动时读取；没有或损坏则返回 null。
  static Future<SavedSession?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final baseUrl = prefs.getString(_kBaseUrl);
    final authRaw = prefs.getString(_kAuth);
    if (baseUrl == null || authRaw == null) return null;
    try {
      final auth =
          AuthResponse.fromJson(jsonDecode(authRaw) as Map<String, dynamic>);
      return SavedSession(baseUrl: baseUrl, auth: auth);
    } catch (_) {
      return null; // 数据损坏，当作未登录
    }
  }

  /// 退出登录 / token 失效时清除。
  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kBaseUrl);
    await prefs.remove(_kAuth);
  }
}

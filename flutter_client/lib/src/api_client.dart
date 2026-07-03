import 'dart:convert';

import 'package:http/http.dart' as http;

import 'types.dart';

/// HTTP API 客户端，只封装 Flutter 端语音功能需要的三个接口。
class OopzApiClient {
  final String baseUrl; // 如 http://192.168.1.10:8080

  const OopzApiClient({required this.baseUrl});

  Future<AuthResponse> login(String email, String password) async {
    final resp = await http.post(
      Uri.parse('$baseUrl/api/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email, 'password': password}),
    );
    if (resp.statusCode != 200) {
      throw Exception('登录失败(${resp.statusCode}): ${resp.body}');
    }
    return AuthResponse.fromJson(
        jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>);
  }

  Future<BootstrapData> bootstrap(String token, {int? domainId}) async {
    final query = domainId != null ? '?domainId=$domainId' : '';
    final resp = await http.get(
      Uri.parse('$baseUrl/api/bootstrap$query'),
      headers: {'Authorization': 'Bearer $token'},
    );
    if (resp.statusCode != 200) {
      throw Exception('bootstrap 失败(${resp.statusCode}): ${resp.body}');
    }
    return BootstrapData.fromJson(
        jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>);
  }

  Future<List<PresenceMember>> domainPresence(String token, int domainId) async {
    final resp = await http.get(
      Uri.parse('$baseUrl/api/domains/$domainId/presence'),
      headers: {'Authorization': 'Bearer $token'},
    );
    if (resp.statusCode != 200) {
      throw Exception('presence 失败(${resp.statusCode})');
    }
    final data = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;
    final members = <PresenceMember>[];
    (data['channels'] as Map<String, dynamic>? ?? const {})
        .forEach((_, dynamic list) {
      for (final m in (list as List<dynamic>)) {
        members.add(PresenceMember.fromJson(m as Map<String, dynamic>));
      }
    });
    return members;
  }
}

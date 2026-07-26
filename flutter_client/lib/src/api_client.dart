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

  /// 列出当前用户可见的所有域。
  Future<List<DomainSummary>> listDomains(String token) async {
    final resp = await http.get(
      Uri.parse('$baseUrl/api/domains'),
      headers: {'Authorization': 'Bearer $token'},
    );
    if (resp.statusCode != 200) {
      throw Exception('域列表失败(${resp.statusCode})');
    }
    final list = jsonDecode(utf8.decode(resp.bodyBytes)) as List<dynamic>;
    return list
        .map((e) => DomainSummary.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// 创建新域，返回新域摘要。
  Future<DomainSummary> createDomain(
    String token, {
    required String name,
    String description = '',
    String accentColor = '#6de2d2',
  }) async {
    final resp = await http.post(
      Uri.parse('$baseUrl/api/domains'),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'name': name,
        'description': description,
        'accentColor': accentColor,
      }),
    );
    if (resp.statusCode != 200 && resp.statusCode != 201) {
      throw Exception('创建域失败(${resp.statusCode}): ${resp.body}');
    }
    return DomainSummary.fromJson(
        jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>);
  }

  /// 拉取域级在场（每个语音/放映频道里有谁），用于侧边栏成员展示。
  Future<DomainPresence> domainPresence(String token, int domainId) async {
    final resp = await http.get(
      Uri.parse('$baseUrl/api/domains/$domainId/presence'),
      headers: {'Authorization': 'Bearer $token'},
    );
    if (resp.statusCode != 200) {
      throw Exception('presence 失败(${resp.statusCode})');
    }
    return DomainPresence.fromJson(
        jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>);
  }
}

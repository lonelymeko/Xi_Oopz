import 'package:flutter_webrtc/flutter_webrtc.dart';

/// 与后端 /api 返回的 user 对象对齐（见 internal/models/models.go）。
class OopzUser {
  final int id;
  final String handle;
  final String displayName;
  final String avatarColor;

  const OopzUser({
    required this.id,
    required this.handle,
    required this.displayName,
    required this.avatarColor,
  });

  factory OopzUser.fromJson(Map<String, dynamic> json) => OopzUser(
        id: (json['id'] as num).toInt(),
        handle: json['handle'] as String? ?? '',
        displayName: json['displayName'] as String? ?? '',
        avatarColor: json['avatarColor'] as String? ?? '#6de2d2',
      );
}

/// presence.snapshot / member.joined 里的成员条目。
class PresenceMember {
  final OopzUser user;
  final bool micEnabled;
  final bool screenSharing;

  const PresenceMember({
    required this.user,
    required this.micEnabled,
    required this.screenSharing,
  });

  factory PresenceMember.fromJson(Map<String, dynamic> json) => PresenceMember(
        user: OopzUser.fromJson(json['user'] as Map<String, dynamic>),
        micEnabled: json['micEnabled'] as bool? ?? true,
        screenSharing: json['screenSharing'] as bool? ?? false,
      );
}

/// 对端媒体集合，对齐 web 端 RemoteMedia：
/// audioStream=麦克风、displayAudioStream=屏幕共享音频、screenStream=屏幕共享视频。
class RemoteMedia {
  final OopzUser user;
  MediaStream? audioStream;
  MediaStream? displayAudioStream;
  MediaStream? screenStream;

  RemoteMedia({required this.user});
}

enum TransportType { lan, stun, turn, unknown }

enum RecoveryMode { stable, iceRestart, relay }

/// 连接诊断，对齐 web 端 PeerConnectionDiagnostics。
class PeerDiagnostics {
  final int userId;
  final int? latencyMs;
  final TransportType transport;
  final int retryCount;
  final RecoveryMode recoveryMode;
  final DateTime updatedAt;

  const PeerDiagnostics({
    required this.userId,
    required this.latencyMs,
    required this.transport,
    required this.retryCount,
    required this.recoveryMode,
    required this.updatedAt,
  });
}

class AuthResponse {
  final String token;
  final OopzUser user;

  const AuthResponse({required this.token, required this.user});

  factory AuthResponse.fromJson(Map<String, dynamic> json) => AuthResponse(
        token: json['token'] as String,
        user: OopzUser.fromJson(json['user'] as Map<String, dynamic>),
      );
}

class ChannelInfo {
  final int id;
  final String name;
  final String type; // text / voice / screening
  final int maxMembers;

  const ChannelInfo({
    required this.id,
    required this.name,
    required this.type,
    required this.maxMembers,
  });

  factory ChannelInfo.fromJson(Map<String, dynamic> json) => ChannelInfo(
        id: (json['id'] as num).toInt(),
        name: json['name'] as String? ?? '',
        type: json['type'] as String? ?? 'text',
        maxMembers: (json['maxMembers'] as num?)?.toInt() ?? 0,
      );
}

class BootstrapData {
  final OopzUser user;
  final int domainId;
  final String domainName;
  final List<ChannelInfo> channels;
  final List<Map<String, dynamic>> iceServers;

  const BootstrapData({
    required this.user,
    required this.domainId,
    required this.domainName,
    required this.channels,
    required this.iceServers,
  });

  factory BootstrapData.fromJson(Map<String, dynamic> json) {
    final domain = json['domain'] as Map<String, dynamic>;
    final categories = (json['categories'] as List<dynamic>? ?? const []);
    final channels = <ChannelInfo>[];
    for (final category in categories) {
      for (final channel
          in ((category as Map<String, dynamic>)['channels'] as List<dynamic>? ?? const [])) {
        channels.add(ChannelInfo.fromJson(channel as Map<String, dynamic>));
      }
    }
    // 后端字段名叫 stunServers，但内容是完整 RTCIceServer 列表（含 TURN）。
    final ice = (json['stunServers'] as List<dynamic>? ?? const [])
        .map((e) => Map<String, dynamic>.from(e as Map))
        .toList();
    return BootstrapData(
      user: OopzUser.fromJson(json['user'] as Map<String, dynamic>),
      domainId: (domain['id'] as num).toInt(),
      domainName: domain['name'] as String? ?? '',
      channels: channels,
      iceServers: ice,
    );
  }
}

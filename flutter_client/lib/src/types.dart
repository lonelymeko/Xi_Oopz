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

  Map<String, dynamic> toJson() => {
        'id': id,
        'handle': handle,
        'displayName': displayName,
        'avatarColor': avatarColor,
      };
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

  Map<String, dynamic> toJson() => {'token': token, 'user': user.toJson()};
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

/// 域摘要，对齐后端 DomainSummary（Domain + role）。用于域列表/切换。
class DomainSummary {
  final int id;
  final String name;
  final String description;
  final String accentColor;
  final String role; // owner / member 等

  const DomainSummary({
    required this.id,
    required this.name,
    required this.description,
    required this.accentColor,
    required this.role,
  });

  factory DomainSummary.fromJson(Map<String, dynamic> json) => DomainSummary(
        id: (json['id'] as num).toInt(),
        name: json['name'] as String? ?? '',
        description: json['description'] as String? ?? '',
        accentColor: json['accentColor'] as String? ?? '#6de2d2',
        role: json['role'] as String? ?? 'member',
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

// ---------------------------------------------------------------------------
// 放映室（screening）模型 —— 对齐后端 internal/models ScreeningSnapshot。
// ---------------------------------------------------------------------------

/// 放映室播放状态，对齐后端 ScreeningState。
class ScreeningState {
  final int channelId;
  final int controllerUserId; // 当前控制者用户 id，0 = 无
  final String currentItemId;
  final String currentUrl;
  final String currentTitle;
  final String playbackState; // "playing" / "paused" / ""
  final double currentTime; // 秒
  final double playbackRate;
  final bool awaitingReady;

  const ScreeningState({
    required this.channelId,
    required this.controllerUserId,
    required this.currentItemId,
    required this.currentUrl,
    required this.currentTitle,
    required this.playbackState,
    required this.currentTime,
    required this.playbackRate,
    required this.awaitingReady,
  });

  bool get isPlaying => playbackState == 'playing';
  bool get hasVideo => currentUrl.isNotEmpty;

  factory ScreeningState.fromJson(Map<String, dynamic> json) => ScreeningState(
        channelId: (json['channelId'] as num?)?.toInt() ?? 0,
        controllerUserId: (json['controllerUserId'] as num?)?.toInt() ?? 0,
        currentItemId: json['currentItemId'] as String? ?? '',
        currentUrl: json['currentUrl'] as String? ?? '',
        currentTitle: json['currentTitle'] as String? ?? '',
        playbackState: json['playbackState'] as String? ?? '',
        currentTime: (json['currentTime'] as num?)?.toDouble() ?? 0,
        playbackRate: (json['playbackRate'] as num?)?.toDouble() ?? 1,
        awaitingReady: json['awaitingReady'] as bool? ?? false,
      );
}

/// 放映室在场观众，对齐后端 ScreeningViewer。
class ScreeningViewer {
  final OopzUser user;
  final bool ready;

  const ScreeningViewer({required this.user, required this.ready});

  factory ScreeningViewer.fromJson(Map<String, dynamic> json) => ScreeningViewer(
        user: OopzUser.fromJson(json['user'] as Map<String, dynamic>),
        ready: json['ready'] as bool? ?? false,
      );
}

/// 播放列表条目，对齐后端 ScreeningPlaylistItem。
class ScreeningPlaylistItem {
  final String itemId;
  final String url;
  final String title;
  final int addedBy;

  const ScreeningPlaylistItem({
    required this.itemId,
    required this.url,
    required this.title,
    required this.addedBy,
  });

  factory ScreeningPlaylistItem.fromJson(Map<String, dynamic> json) =>
      ScreeningPlaylistItem(
        itemId: json['itemId'] as String? ?? '',
        url: json['url'] as String? ?? '',
        title: json['title'] as String? ?? '',
        addedBy: (json['addedBy'] as num?)?.toInt() ?? 0,
      );
}

/// 域级在场快照，对齐后端 DomainPresenceSnapshot。
/// 用于侧边栏显示「每个语音/放映频道里有谁、多少人」。
class DomainPresence {
  final Map<int, List<OopzUser>> membersByChannel; // 语音+放映合并，channelId -> 成员
  final Map<int, int> onlineCounts; // channelId -> 在线人数

  const DomainPresence({
    required this.membersByChannel,
    required this.onlineCounts,
  });

  static const empty = DomainPresence(membersByChannel: {}, onlineCounts: {});

  factory DomainPresence.fromJson(Map<String, dynamic> json) {
    final members = <int, List<OopzUser>>{};

    void ingest(Map<String, dynamic>? group) {
      group?.forEach((key, value) {
        final channelId = int.tryParse(key);
        if (channelId == null || value is! List) return;
        final users = <OopzUser>[];
        for (final entry in value) {
          if (entry is Map<String, dynamic> && entry['user'] is Map) {
            users.add(OopzUser.fromJson(
                (entry['user'] as Map).cast<String, dynamic>()));
          }
        }
        members[channelId] = users;
      });
    }

    ingest((json['voiceMembers'] as Map?)?.cast<String, dynamic>());
    ingest((json['screeningMembers'] as Map?)?.cast<String, dynamic>());

    final counts = <int, int>{};
    (json['onlineCounts'] as Map?)?.forEach((key, value) {
      final channelId = int.tryParse(key.toString());
      if (channelId != null && value is num) counts[channelId] = value.toInt();
    });

    return DomainPresence(membersByChannel: members, onlineCounts: counts);
  }
}

/// 放映室全量快照，对齐后端 ScreeningSnapshot。
class ScreeningSnapshot {
  final ScreeningState state;
  final List<ScreeningViewer> viewers;
  final List<ScreeningPlaylistItem> playlist;

  const ScreeningSnapshot({
    required this.state,
    required this.viewers,
    required this.playlist,
  });

  factory ScreeningSnapshot.fromJson(Map<String, dynamic> json) =>
      ScreeningSnapshot(
        state: ScreeningState.fromJson(
            (json['state'] as Map?)?.cast<String, dynamic>() ?? const {}),
        viewers: (json['viewers'] as List<dynamic>? ?? const [])
            .map((e) => ScreeningViewer.fromJson(e as Map<String, dynamic>))
            .toList(),
        playlist: (json['playlist'] as List<dynamic>? ?? const [])
            .map((e) =>
                ScreeningPlaylistItem.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

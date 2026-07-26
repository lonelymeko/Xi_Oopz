import 'package:flutter/material.dart';

import '../oopz_rtc.dart';

class MemberAvatar extends StatelessWidget {
  final PresenceMember member;
  final bool isSelf;
  final PeerDiagnostics? diag;
  final bool compact;

  const MemberAvatar({
    super.key,
    required this.member,
    required this.isSelf,
    this.diag,
    this.compact = false,
  });

  Color _parseAvatarColor(String hex) {
    try {
      final s = hex.replaceFirst('#', '');
      return Color(int.parse('ff$s', radix: 16));
    } catch (_) {
      return const Color(0xFF6DE2D2);
    }
  }

  String _diagLabel(PeerDiagnostics d) {
    final t = switch (d.transport) {
      TransportType.lan => '局域网',
      TransportType.stun => 'STUN',
      TransportType.turn => 'TURN',
      TransportType.unknown => '连接中',
    };
    return d.latencyMs != null ? '$t · ${d.latencyMs}ms' : t;
  }

  @override
  Widget build(BuildContext context) {
    final size = compact ? 52.0 : 88.0;
    final avatarColor = _parseAvatarColor(member.user.avatarColor);
    final err = Theme.of(context).colorScheme.error;
    final ringColor =
        member.micEnabled ? const Color(0xFF6DE2D2) : const Color(0xFF3A3A3A);

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Stack(
          clipBehavior: Clip.none,
          alignment: Alignment.center,
          children: [
            Container(
              width: size,
              height: size,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: ringColor, width: 2.5),
              ),
              padding: const EdgeInsets.all(3),
              child: CircleAvatar(
                backgroundColor: avatarColor,
                child: Text(
                  member.user.displayName.isNotEmpty
                      ? member.user.displayName[0].toUpperCase()
                      : '?',
                  style: TextStyle(
                    color: const Color(0xFF051017),
                    fontSize: size * 0.34,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ),
            if (!member.micEnabled)
              Positioned(
                right: -2,
                bottom: -2,
                child: _badge(Icons.mic_off, err, context),
              ),
            if (member.screenSharing)
              Positioned(
                left: -2,
                bottom: -2,
                child: _badge(
                    Icons.screen_share, const Color(0xFFFBB45B), context),
              ),
          ],
        ),
        SizedBox(height: compact ? 6 : 12),
        SizedBox(
          width: size + 32,
          child: Text(
            isSelf ? '${member.user.displayName}（你）' : member.user.displayName,
            textAlign: TextAlign.center,
            overflow: TextOverflow.ellipsis,
            maxLines: 1,
            style: TextStyle(
                fontSize: compact ? 11 : 13, fontWeight: FontWeight.w500),
          ),
        ),
        if (!compact && !isSelf && diag != null)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              _diagLabel(diag!),
              style: const TextStyle(fontSize: 10, color: Colors.white38),
            ),
          ),
      ],
    );
  }

  Widget _badge(IconData icon, Color color, BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: const Color(0xFF121212),
        border: Border.all(color: color, width: 1.5),
      ),
      child: Icon(icon, size: 12, color: color),
    );
  }
}

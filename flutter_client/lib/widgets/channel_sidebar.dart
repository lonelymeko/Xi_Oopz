import 'package:flutter/material.dart';

import '../oopz_rtc.dart';

/// 频道侧边栏：按 文字 / 语音 / 放映室 分组列出频道，高亮当前查看的频道。
/// 语音 / 放映频道下方显示当前在场成员头像与人数（对齐 Web 端）。
class ChannelSidebar extends StatelessWidget {
  final String domainName;
  final OopzUser me;
  final List<ChannelInfo> channels;
  final int? viewingChannelId;
  final int? joinedVoiceChannelId; // 我当前所在的语音/放映频道
  final Map<int, List<OopzUser>> membersByChannel;
  final Map<int, int> onlineCounts;
  final ValueChanged<ChannelInfo> onSelect;
  final VoidCallback onDomainTap; // 点域名 → 打开域切换器
  final VoidCallback onMeTap; // 点左下角头像 → 账号菜单（退出登录）

  const ChannelSidebar({
    super.key,
    required this.domainName,
    required this.me,
    required this.channels,
    required this.viewingChannelId,
    required this.joinedVoiceChannelId,
    required this.membersByChannel,
    required this.onlineCounts,
    required this.onSelect,
    required this.onDomainTap,
    required this.onMeTap,
  });

  @override
  Widget build(BuildContext context) {
    final text = channels.where((c) => c.type == 'text').toList();
    final voice = channels.where((c) => c.type == 'voice').toList();
    final screening = channels.where((c) => c.type == 'screening').toList();

    return Container(
      width: 240,
      color: const Color(0xFF171717),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _DomainHeader(domainName: domainName, onTap: onDomainTap),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(vertical: 8),
              children: [
                if (text.isNotEmpty) _group('文字频道'),
                for (final c in text) _tile(c, Icons.tag),
                if (voice.isNotEmpty) _group('语音频道'),
                for (final c in voice) _tile(c, Icons.graphic_eq, occupancy: true),
                if (screening.isNotEmpty) _group('放映室'),
                for (final c in screening) _tile(c, Icons.movie_outlined),
              ],
            ),
          ),
          _MeFooter(me: me, onTap: onMeTap),
        ],
      ),
    );
  }

  Widget _group(String title) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
        child: Text(
          title,
          style: const TextStyle(
            color: Colors.white38,
            fontSize: 11,
            letterSpacing: 1.2,
            fontWeight: FontWeight.w700,
          ),
        ),
      );

  Widget _tile(ChannelInfo c, IconData icon, {bool occupancy = false}) {
    final selected = c.id == viewingChannelId;
    final members = membersByChannel[c.id] ?? const [];
    final count = onlineCounts[c.id] ?? members.length;
    final joinedHere = c.id == joinedVoiceChannelId;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _ChannelTile(
          icon: icon,
          name: c.name,
          selected: selected,
          joinedHere: joinedHere,
          trailingText: occupancy && c.maxMembers > 0
              ? '$count/${c.maxMembers}'
              : null,
          onTap: () => onSelect(c),
        ),
        if (members.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(34, 2, 12, 4),
            child: _MemberChips(members: members),
          ),
      ],
    );
  }
}

class _ChannelTile extends StatelessWidget {
  final IconData icon;
  final String name;
  final bool selected;
  final bool joinedHere;
  final String? trailingText;
  final VoidCallback onTap;

  const _ChannelTile({
    required this.icon,
    required this.name,
    required this.selected,
    required this.joinedHere,
    required this.trailingText,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      child: Material(
        color: selected ? const Color(0xFF2A2A2A) : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            child: Row(
              children: [
                Icon(icon,
                    size: 18,
                    color: joinedHere
                        ? const Color(0xFF6DE2D2)
                        : (selected ? Colors.white : Colors.white54)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    name,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      color: selected ? Colors.white : Colors.white70,
                      fontWeight:
                          selected ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ),
                if (trailingText != null)
                  Text(trailingText!,
                      style: const TextStyle(
                          fontSize: 11, color: Colors.white38)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _MemberChips extends StatelessWidget {
  final List<OopzUser> members;
  const _MemberChips({required this.members});

  Color _avatarColor(String hex) {
    try {
      return Color(int.parse('ff${hex.replaceFirst('#', '')}', radix: 16));
    } catch (_) {
      return const Color(0xFF6DE2D2);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 4,
      runSpacing: 4,
      children: [
        for (final u in members)
          Container(
            padding: const EdgeInsets.only(right: 8),
            decoration: BoxDecoration(
              color: const Color(0xFF222222),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                CircleAvatar(
                  radius: 9,
                  backgroundColor: _avatarColor(u.avatarColor),
                  child: Text(
                    u.displayName.isNotEmpty
                        ? u.displayName[0].toUpperCase()
                        : '?',
                    style: const TextStyle(
                        color: Color(0xFF051017),
                        fontSize: 9,
                        fontWeight: FontWeight.w700),
                  ),
                ),
                const SizedBox(width: 4),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 90),
                  child: Text(
                    u.displayName,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 11, color: Colors.white60),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _DomainHeader extends StatelessWidget {
  final String domainName;
  final VoidCallback onTap;
  const _DomainHeader({required this.domainName, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: Color(0xFF0F0F0F))),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  domainName,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      fontSize: 16, fontWeight: FontWeight.w700),
                ),
              ),
              const Icon(Icons.unfold_more, size: 18, color: Colors.white38),
            ],
          ),
        ),
      ),
    );
  }
}

class _MeFooter extends StatelessWidget {
  final OopzUser me;
  final VoidCallback onTap;
  const _MeFooter({required this.me, required this.onTap});

  Color _avatarColor(String hex) {
    try {
      return Color(int.parse('ff${hex.replaceFirst('#', '')}', radix: 16));
    } catch (_) {
      return const Color(0xFF6DE2D2);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0xFF141414),
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: [
              CircleAvatar(
                radius: 16,
                backgroundColor: _avatarColor(me.avatarColor),
                child: Text(
                  me.displayName.isNotEmpty
                      ? me.displayName[0].toUpperCase()
                      : '?',
                  style: const TextStyle(
                      color: Color(0xFF051017), fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  me.displayName,
                  overflow: TextOverflow.ellipsis,
                  style:
                      const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                ),
              ),
              const Icon(Icons.more_horiz, size: 18, color: Colors.white38),
            ],
          ),
        ),
      ),
    );
  }
}

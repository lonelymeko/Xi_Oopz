import 'package:flutter/material.dart';

import '../oopz_rtc.dart';

class LobbyView extends StatelessWidget {
  final List<ChannelInfo> channels;
  final ValueChanged<ChannelInfo> onJoin;

  const LobbyView({
    super.key,
    required this.channels,
    required this.onJoin,
  });

  @override
  Widget build(BuildContext context) {
    if (channels.isEmpty) {
      return const Center(
        child: Text('这个域还没有语音频道',
            style: TextStyle(color: Colors.white54)),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Padding(
          padding: EdgeInsets.only(left: 4, bottom: 8),
          child: Text(
            '语音频道',
            style: TextStyle(
              color: Colors.white54,
              fontSize: 12,
              letterSpacing: 1.4,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        for (final ch in channels)
          _ChannelCard(channel: ch, onJoin: () => onJoin(ch)),
      ],
    );
  }
}

class _ChannelCard extends StatelessWidget {
  final ChannelInfo channel;
  final VoidCallback onJoin;

  const _ChannelCard({required this.channel, required this.onJoin});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: const Color(0xFF1E1E1E),
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onJoin,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: const Color(0xFF6DE2D2).withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(Icons.graphic_eq,
                      color: Color(0xFF6DE2D2)),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(channel.name,
                          style: const TextStyle(
                              fontSize: 16, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 2),
                      Text(
                        '语音频道 · 上限 ${channel.maxMembers} 人',
                        style: const TextStyle(
                            color: Colors.white54, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.arrow_forward_ios,
                    size: 14, color: Colors.white38),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

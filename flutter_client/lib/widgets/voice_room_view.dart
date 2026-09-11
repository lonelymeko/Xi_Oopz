import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../oopz_rtc.dart';
import 'member_avatar.dart';

class VoiceRoomView extends StatelessWidget {
  final int currentUserId;
  final List<PresenceMember> members;
  final Map<int, PeerDiagnostics> diagnostics;
  final Map<int, RTCVideoRenderer> screenRenderers;
  /// 正在说话的成员 id（用于头像说话高亮）。
  final Set<int> speakingUserIds;
  /// 点击某个共享画面 → 交给父级放大（父级用页面状态管理，共享消失会自动关闭）。
  final ValueChanged<int>? onOpenShare;

  const VoiceRoomView({
    super.key,
    required this.currentUserId,
    required this.members,
    required this.diagnostics,
    required this.screenRenderers,
    this.speakingUserIds = const <int>{},
    this.onOpenShare,
  });

  String _nameOf(int userId) {
    for (final m in members) {
      if (m.user.id == userId) return m.user.displayName;
    }
    return '未知用户';
  }

  @override
  Widget build(BuildContext context) {
    if (members.isEmpty) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 16),
            Text('等待成员加入…', style: TextStyle(color: Colors.white54)),
          ],
        ),
      );
    }

    final shares = screenRenderers.entries.toList();
    if (shares.isNotEmpty) {
      return _WithShareLayout(
        shares: shares,
        members: members,
        currentUserId: currentUserId,
        diagnostics: diagnostics,
        nameOf: _nameOf,
        speakingUserIds: speakingUserIds,
        onOpenShare: onOpenShare,
      );
    }

    return _MemberGrid(
      members: members,
      currentUserId: currentUserId,
      diagnostics: diagnostics,
      speakingUserIds: speakingUserIds,
    );
  }
}

class _MemberGrid extends StatelessWidget {
  final List<PresenceMember> members;
  final int currentUserId;
  final Map<int, PeerDiagnostics> diagnostics;
  final Set<int> speakingUserIds;

  const _MemberGrid({
    required this.members,
    required this.currentUserId,
    required this.diagnostics,
    required this.speakingUserIds,
  });

  @override
  Widget build(BuildContext context) {
    return GridView.builder(
      padding: const EdgeInsets.all(20),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 160,
        childAspectRatio: 0.8,
        crossAxisSpacing: 16,
        mainAxisSpacing: 20,
      ),
      itemCount: members.length,
      itemBuilder: (_, i) {
        final m = members[i];
        return MemberAvatar(
          member: m,
          isSelf: m.user.id == currentUserId,
          diag: diagnostics[m.user.id],
          speaking: speakingUserIds.contains(m.user.id),
        );
      },
    );
  }
}

/// 共享布局：上方视频（可翻页/点击放大），下方一排成员头像（对齐 Web 期望形态）。
/// 点击正在共享的成员头像 → 切到他的共享；点击画面 → 全屏。
class _WithShareLayout extends StatefulWidget {
  final List<MapEntry<int, RTCVideoRenderer>> shares;
  final List<PresenceMember> members;
  final int currentUserId;
  final Map<int, PeerDiagnostics> diagnostics;
  final String Function(int userId) nameOf;
  final Set<int> speakingUserIds;
  final ValueChanged<int>? onOpenShare;

  const _WithShareLayout({
    required this.shares,
    required this.members,
    required this.currentUserId,
    required this.diagnostics,
    required this.nameOf,
    required this.speakingUserIds,
    required this.onOpenShare,
  });

  @override
  State<_WithShareLayout> createState() => _WithShareLayoutState();
}

class _WithShareLayoutState extends State<_WithShareLayout> {
  int _page = 0;
  final PageController _controller = PageController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 点头像切到该成员的共享页。必须用 PageController 驱动 PageView，
  /// 只改 _page 状态不会让 PageView 翻页（这就是之前"点头像没反应"的原因）。
  void _goToShare(int index) {
    if (!_controller.hasClients) {
      setState(() => _page = index);
      return;
    }
    _controller.animateToPage(
      index,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
  }

  @override
  Widget build(BuildContext context) {
    final shares = widget.shares;
    final activeUserId = shares[_page.clamp(0, shares.length - 1)].key;
    return Column(
      children: [
        Expanded(
          child: PageView(
            controller: _controller,
            onPageChanged: (index) => setState(() => _page = index),
            children: [
              for (final s in shares)
                _ScreenTile(
                  renderer: s.value,
                  presenterName: widget.nameOf(s.key),
                  onTap: widget.onOpenShare == null
                      ? null
                      : () => widget.onOpenShare!(s.key),
                ),
            ],
          ),
        ),
        Container(
          height: 110,
          decoration: const BoxDecoration(
            color: Color(0xFF171717),
            border: Border(top: BorderSide(color: Color(0xFF2A2A2A))),
          ),
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding:
                const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            itemCount: widget.members.length,
            separatorBuilder: (_, __) => const SizedBox(width: 14),
            itemBuilder: (_, i) {
              final m = widget.members[i];
              final shareIndex =
                  shares.indexWhere((s) => s.key == m.user.id);
              final sharing = shareIndex >= 0;
              return MemberAvatar(
                member: m,
                isSelf: m.user.id == widget.currentUserId,
                diag: widget.diagnostics[m.user.id],
                compact: true,
                speaking: widget.speakingUserIds.contains(m.user.id),
                active: sharing && m.user.id == activeUserId,
                // 点头像看共享：切到该成员的共享画面
                onTap: sharing ? () => _goToShare(shareIndex) : null,
              );
            },
          ),
        ),
      ],
    );
  }
}

class _ScreenTile extends StatelessWidget {
  final RTCVideoRenderer renderer;
  final String presenterName;
  final VoidCallback? onTap;

  const _ScreenTile({
    required this.renderer,
    required this.presenterName,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.screen_share,
                    size: 16, color: Color(0xFFFBB45B)),
                const SizedBox(width: 6),
                Text('$presenterName 的屏幕',
                    style: const TextStyle(
                        color: Colors.white70, fontSize: 12)),
                const Spacer(),
                if (onTap != null)
                  const Text('点击放大',
                      style: TextStyle(color: Colors.white38, fontSize: 11)),
              ],
            ),
            const SizedBox(height: 8),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: Container(
                  color: Colors.black,
                  child: RTCVideoView(
                    renderer,
                    objectFit:
                        RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 全屏观看某个共享（由 HomePage 以叠加层方式渲染，共享结束即自动移除）。
class ShareFullscreen extends StatelessWidget {
  final RTCVideoRenderer renderer;
  final String presenterName;
  final VoidCallback onClose;

  const ShareFullscreen({
    super.key,
    required this.renderer,
    required this.presenterName,
    required this.onClose,
  });

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.black,
      child: Stack(
        children: [
          Positioned.fill(
            child: Center(
              child: RTCVideoView(
                renderer,
                objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
              ),
            ),
          ),
          Positioned(
            left: 12,
            top: 12,
            child: SafeArea(
              child: Row(
                children: [
                  IconButton.filledTonal(
                    tooltip: '退出全屏',
                    icon: const Icon(Icons.fullscreen_exit),
                    onPressed: onClose,
                  ),
                  const SizedBox(width: 12),
                  Text('$presenterName 的屏幕',
                      style: const TextStyle(color: Colors.white70)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

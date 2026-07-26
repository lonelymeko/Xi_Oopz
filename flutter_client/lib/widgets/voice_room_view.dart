import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../oopz_rtc.dart';
import 'member_avatar.dart';

class VoiceRoomView extends StatelessWidget {
  final int currentUserId;
  final List<PresenceMember> members;
  final Map<int, PeerDiagnostics> diagnostics;
  final Map<int, RTCVideoRenderer> screenRenderers;

  const VoiceRoomView({
    super.key,
    required this.currentUserId,
    required this.members,
    required this.diagnostics,
    required this.screenRenderers,
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
      );
    }

    return _MemberGrid(
      members: members,
      currentUserId: currentUserId,
      diagnostics: diagnostics,
    );
  }
}

class _MemberGrid extends StatelessWidget {
  final List<PresenceMember> members;
  final int currentUserId;
  final Map<int, PeerDiagnostics> diagnostics;

  const _MemberGrid({
    required this.members,
    required this.currentUserId,
    required this.diagnostics,
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
        );
      },
    );
  }
}

class _WithShareLayout extends StatelessWidget {
  final List<MapEntry<int, RTCVideoRenderer>> shares;
  final List<PresenceMember> members;
  final int currentUserId;
  final Map<int, PeerDiagnostics> diagnostics;
  final String Function(int userId) nameOf;

  const _WithShareLayout({
    required this.shares,
    required this.members,
    required this.currentUserId,
    required this.diagnostics,
    required this.nameOf,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: PageView(
            children: [
              for (final s in shares)
                _ScreenTile(
                  renderer: s.value,
                  presenterName: nameOf(s.key),
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
            itemCount: members.length,
            separatorBuilder: (_, __) => const SizedBox(width: 14),
            itemBuilder: (_, i) {
              final m = members[i];
              return MemberAvatar(
                member: m,
                isSelf: m.user.id == currentUserId,
                diag: diagnostics[m.user.id],
                compact: true,
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

  const _ScreenTile({required this.renderer, required this.presenterName});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        Navigator.of(context).push(MaterialPageRoute(
          fullscreenDialog: true,
          builder: (_) => _FullscreenViewer(
            renderer: renderer,
            presenterName: presenterName,
          ),
        ));
      },
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

class _FullscreenViewer extends StatelessWidget {
  final RTCVideoRenderer renderer;
  final String presenterName;

  const _FullscreenViewer({
    required this.renderer,
    required this.presenterName,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: Text('$presenterName 的屏幕'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: Center(
        child: RTCVideoView(
          renderer,
          objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
        ),
      ),
    );
  }
}

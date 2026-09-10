import 'package:flutter/material.dart';

class VoiceControls extends StatelessWidget {
  final bool micEnabled;
  final bool speakerOn;
  final bool screenSharing;
  final VoidCallback onToggleMic;
  final VoidCallback onToggleSpeaker;
  final VoidCallback onToggleScreenShare;
  final VoidCallback onLeave;

  const VoiceControls({
    super.key,
    required this.micEnabled,
    required this.speakerOn,
    required this.screenSharing,
    required this.onToggleMic,
    required this.onToggleSpeaker,
    required this.onToggleScreenShare,
    required this.onLeave,
  });

  @override
  Widget build(BuildContext context) {
    final err = Theme.of(context).colorScheme.error;
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: const BoxDecoration(
          color: Color(0xFF1A1A1A),
          border: Border(top: BorderSide(color: Color(0xFF2A2A2A))),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            _CtrlBtn(
              icon: micEnabled ? Icons.mic : Icons.mic_off,
              label: micEnabled ? '静音' : '取消静音',
              color: micEnabled ? Colors.white : err,
              bg: micEnabled
                  ? const Color(0xFF2A2A2A)
                  : err.withValues(alpha: 0.2),
              onTap: onToggleMic,
            ),
            _CtrlBtn(
              icon: speakerOn ? Icons.volume_up : Icons.headphones,
              label: speakerOn ? '扬声器' : '耳机优先',
              color: Colors.white,
              bg: const Color(0xFF2A2A2A),
              onTap: onToggleSpeaker,
            ),
            _CtrlBtn(
              icon: screenSharing ? Icons.stop_screen_share : Icons.screen_share,
              label: screenSharing ? '停止共享' : '共享屏幕',
              color: screenSharing ? const Color(0xFF0B1018) : Colors.white,
              bg: screenSharing ? const Color(0xFF6DE2D2) : const Color(0xFF2A2A2A),
              onTap: onToggleScreenShare,
            ),
            _CtrlBtn(
              icon: Icons.call_end,
              label: '离开',
              color: Colors.white,
              bg: err,
              onTap: onLeave,
            ),
          ],
        ),
      ),
    );
  }
}

class _CtrlBtn extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final Color bg;
  final VoidCallback onTap;

  const _CtrlBtn({
    required this.icon,
    required this.label,
    required this.color,
    required this.bg,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Material(
          color: bg,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: SizedBox(
              width: 56,
              height: 56,
              child: Icon(icon, color: color, size: 26),
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text(label,
            style: const TextStyle(fontSize: 11, color: Colors.white70)),
      ],
    );
  }
}

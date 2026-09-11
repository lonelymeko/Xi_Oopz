import 'dart:async';

import 'package:flutter/material.dart';

import '../src/skin.dart';

/// 音频设备列表项（麦克风/扬声器通用）。[id] 为空串表示"系统默认"。
class DeviceMenuItem {
  final String id;
  final String label;
  const DeviceMenuItem({required this.id, required this.label});
}

/// 底部语音控制条（PC 版 4 个按钮）：麦克风 / 扬声器 / 共享屏幕 / 离开。
///
/// 麦克风、扬声器按钮：
/// - **点击** = 静音/开麦、扬声器/耳机优先切换；
/// - **鼠标悬停** = 弹出设备列表，移开自动消失（对齐网页端）；触屏长按也可打开列表。
class VoiceControls extends StatelessWidget {
  final bool micEnabled;
  final bool speakerOn;
  final bool screenSharing;
  final bool audioOnlySharing;
  final String micLabel;
  final String speakerLabel;
  final String? micDeviceId;
  final String? speakerDeviceId;
  final Future<List<DeviceMenuItem>> Function() loadMics;
  final Future<List<DeviceMenuItem>> Function() loadSpeakers;
  final ValueChanged<String?> onSelectMic;
  final ValueChanged<String?> onSelectSpeaker;
  final VoidCallback onToggleMic;
  final VoidCallback onToggleSpeaker;
  final VoidCallback onToggleScreenShare;
  final VoidCallback onToggleAudioOnlyShare;
  final VoidCallback onLeave;

  const VoiceControls({
    super.key,
    required this.micEnabled,
    required this.speakerOn,
    required this.screenSharing,
    required this.audioOnlySharing,
    required this.micLabel,
    required this.speakerLabel,
    required this.micDeviceId,
    required this.speakerDeviceId,
    required this.loadMics,
    required this.loadSpeakers,
    required this.onSelectMic,
    required this.onSelectSpeaker,
    required this.onToggleMic,
    required this.onToggleSpeaker,
    required this.onToggleScreenShare,
    required this.onToggleAudioOnlyShare,
    required this.onLeave,
  });

  @override
  Widget build(BuildContext context) {
    final err = Theme.of(context).colorScheme.error;
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          color: AppSkin.preset.surface,
          border: Border(top: BorderSide(color: AppSkin.preset.line)),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            _DeviceMenuButton(
              icon: micEnabled ? Icons.mic : Icons.mic_off,
              iconColor: micEnabled ? Colors.white : err,
              bg: micEnabled
                  ? AppSkin.preset.surfaceHigh
                  : err.withValues(alpha: 0.2),
              label: micLabel,
              title: '选择麦克风',
              selectedId: micDeviceId,
              loadItems: loadMics,
              onSelect: onSelectMic,
              onTap: onToggleMic,
            ),
            _DeviceMenuButton(
              icon: speakerOn ? Icons.volume_up : Icons.headphones,
              iconColor: Colors.white,
              bg: AppSkin.preset.surfaceHigh,
              label: speakerLabel,
              title: '选择扬声器',
              selectedId: speakerDeviceId,
              loadItems: loadSpeakers,
              onSelect: onSelectSpeaker,
              onTap: onToggleSpeaker,
            ),
            _CtrlBtn(
              icon: Icons.audiotrack,
              label: audioOnlySharing ? '停止音频' : '只共享音频',
              color:
                  audioOnlySharing ? const Color(0xFF0B1018) : Colors.white,
              bg: audioOnlySharing
                  ? AppSkin.preset.accent
                  : AppSkin.preset.surfaceHigh,
              onTap: onToggleAudioOnlyShare,
            ),
            _CtrlBtn(
              icon: screenSharing ? Icons.stop_screen_share : Icons.screen_share,
              label: screenSharing ? '停止共享' : '共享屏幕',
              color: screenSharing ? const Color(0xFF0B1018) : Colors.white,
              bg: screenSharing
                  ? AppSkin.preset.accent
                  : AppSkin.preset.surfaceHigh,
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

/// 点击执行 [onTap]（如静音切换），悬停/长按弹出设备列表。
class _DeviceMenuButton extends StatefulWidget {
  final IconData icon;
  final Color iconColor;
  final Color bg;
  final String label;
  final String title;
  final String? selectedId;
  final Future<List<DeviceMenuItem>> Function() loadItems;
  final ValueChanged<String?> onSelect;
  final VoidCallback onTap;

  const _DeviceMenuButton({
    required this.icon,
    required this.iconColor,
    required this.bg,
    required this.label,
    required this.title,
    required this.selectedId,
    required this.loadItems,
    required this.onSelect,
    required this.onTap,
  });

  @override
  State<_DeviceMenuButton> createState() => _DeviceMenuButtonState();
}

class _DeviceMenuButtonState extends State<_DeviceMenuButton> {
  final GlobalKey _anchorKey = GlobalKey();
  OverlayEntry? _entry;
  Timer? _hideTimer;
  bool _loading = false;

  @override
  void dispose() {
    _hideTimer?.cancel();
    _entry?.remove();
    _entry = null;
    super.dispose();
  }

  void _cancelHide() => _hideTimer?.cancel();

  void _scheduleHide() {
    _hideTimer?.cancel();
    _hideTimer = Timer(const Duration(milliseconds: 260), _hide);
  }

  void _hide() {
    _hideTimer?.cancel();
    _entry?.remove();
    _entry = null;
    if (mounted) setState(() {});
  }

  Future<void> _show() async {
    _cancelHide();
    if (_entry != null || _loading) return;
    _loading = true;
    List<DeviceMenuItem> items;
    try {
      items = await widget.loadItems();
    } catch (_) {
      items = const [];
    }
    _loading = false;
    if (!mounted || _entry != null) return;

    final anchorBox =
        _anchorKey.currentContext?.findRenderObject() as RenderBox?;
    final overlay = Overlay.of(context, rootOverlay: true);
    if (anchorBox == null) return;

    final origin = anchorBox.localToGlobal(Offset.zero);
    final size = anchorBox.size;
    final screen = MediaQuery.of(context).size;
    const menuWidth = 288.0;
    final left = (origin.dx + size.width / 2 - menuWidth / 2)
        .clamp(8.0, (screen.width - menuWidth - 8).clamp(8.0, screen.width));
    final bottom = screen.height - origin.dy + 8;

    _entry = OverlayEntry(
      builder: (octx) => Positioned(
        left: left,
        bottom: bottom,
        width: menuWidth,
        child: MouseRegion(
          onEnter: (_) => _cancelHide(),
          onExit: (_) => _scheduleHide(),
          child: Material(
            elevation: 12,
            color: const Color(0xFF232323),
            borderRadius: BorderRadius.circular(12),
            clipBehavior: Clip.antiAlias,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 340),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
                      child: Text(
                        widget.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                            color: Colors.white54),
                      ),
                    ),
                    if (items.isEmpty)
                      const Padding(
                        padding: EdgeInsets.all(16),
                        child: Text('没有检测到设备',
                            style:
                                TextStyle(color: Colors.white38, fontSize: 13)),
                      ),
                    for (final item in items)
                      _MenuItemTile(
                        label: item.label,
                        selected: (item.id.isEmpty ? null : item.id) ==
                            widget.selectedId,
                        onTap: () {
                          widget.onSelect(item.id.isEmpty ? null : item.id);
                          _hide();
                        },
                        onHoverStay: _cancelHide,
                        onHoverLeave: _scheduleHide,
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    overlay.insert(_entry!);
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      key: _anchorKey,
      onEnter: (_) => _show(),
      onExit: (_) => _scheduleHide(),
      child: _CtrlBtn(
        icon: widget.icon,
        label: widget.label,
        color: widget.iconColor,
        bg: widget.bg,
        onTap: widget.onTap,
        onLongPress: _show,
      ),
    );
  }
}

class _MenuItemTile extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback onHoverStay;
  final VoidCallback onHoverLeave;

  const _MenuItemTile({
    required this.label,
    required this.selected,
    required this.onTap,
    required this.onHoverStay,
    required this.onHoverLeave,
  });

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) => onHoverStay(),
      onExit: (_) => onHoverLeave(),
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13, color: Colors.white),
                ),
              ),
              if (selected)
                const Icon(Icons.check, size: 16, color: Color(0xFF6DE2D2)),
            ],
          ),
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
  final VoidCallback? onLongPress;

  const _CtrlBtn({
    required this.icon,
    required this.label,
    required this.color,
    required this.bg,
    required this.onTap,
    this.onLongPress,
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
            onLongPress: onLongPress,
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

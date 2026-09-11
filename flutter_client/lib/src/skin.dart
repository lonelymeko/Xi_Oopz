import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 纯色皮肤预设（暂时只支持纯色）。
class SkinPreset {
  final String id;
  final String name;
  final Color accent;
  final Color base;
  const SkinPreset(this.id, this.name, this.accent, this.base);

  /// 面板色（比 base 稍亮）
  Color get surface => Color.lerp(base, Colors.white, 0.07)!;

  /// 更高一层的面板/输入框色
  Color get surfaceHigh => Color.lerp(base, Colors.white, 0.13)!;

  /// 描边色
  Color get line => Color.lerp(base, Colors.white, 0.18)!;
}

/// 皮肤管理：一个全局 ValueNotifier，OopzApp 监听它重建 Theme。
class AppSkin {
  static const List<SkinPreset> presets = [
    SkinPreset('teal', '青', Color(0xFF6DE2D2), Color(0xFF121212)),
    SkinPreset('blue', '蓝', Color(0xFF5B8DEF), Color(0xFF0F1523)),
    SkinPreset('purple', '紫', Color(0xFF9B6DEF), Color(0xFF160F23)),
    SkinPreset('pink', '粉', Color(0xFFEF6D9E), Color(0xFF230F18)),
    SkinPreset('green', '绿', Color(0xFF6DEF9B), Color(0xFF0F2216)),
    SkinPreset('orange', '橙', Color(0xFFEFB46D), Color(0xFF231A0F)),
    SkinPreset('red', '红', Color(0xFFEF6D6D), Color(0xFF230F0F)),
  ];

  static final ValueNotifier<String> currentId = ValueNotifier<String>('teal');

  static SkinPreset get preset => presets.firstWhere(
        (p) => p.id == currentId.value,
        orElse: () => presets.first,
      );

  static const _kSkinId = 'skin.id';

  static Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final id = prefs.getString(_kSkinId);
    if (id != null && presets.any((p) => p.id == id)) {
      currentId.value = id;
    }
  }

  static Future<void> select(String id) async {
    if (!presets.any((p) => p.id == id)) return;
    currentId.value = id;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kSkinId, id);
  }
}

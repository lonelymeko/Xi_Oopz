import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../oopz_rtc.dart';

/// 放映室视图：直链视频同步播放 + 播放列表 + 观众 + 控制权。
/// 从 [controller] 读状态；[controller] 变化时由父组件 setState 触发重建。
class ScreeningView extends StatelessWidget {
  final ScreeningController controller;
  final int currentUserId;

  const ScreeningView({
    super.key,
    required this.controller,
    required this.currentUserId,
  });

  @override
  Widget build(BuildContext context) {
    final state = controller.state;
    final isController = controller.isController;

    return Column(
      children: [
        _viewerBar(context),
        // 视频区弹性占位（按比例居中 + 黑边），避免宽屏/平板上固定高度撑爆 Column
        Expanded(flex: 3, child: _videoArea(context)),
        if (state != null && state.hasVideo) _controlBar(context, isController),
        Expanded(flex: 2, child: _playlistArea(context, isController)),
      ],
    );
  }

  // ---- 顶部：在看人数 ----
  Widget _viewerBar(BuildContext context) {
    final viewers = controller.viewers;
    final controllerId = controller.state?.controllerUserId ?? 0;
    String controllerName = '';
    for (final v in viewers) {
      if (v.user.id == controllerId) controllerName = v.user.displayName;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      color: const Color(0xFF171717),
      child: Row(
        children: [
          const Icon(Icons.group, size: 16, color: Colors.white54),
          const SizedBox(width: 6),
          Text('${viewers.length} 人在看',
              style: const TextStyle(fontSize: 13, color: Colors.white70)),
          const Spacer(),
          if (controllerName.isNotEmpty) ...[
            const Icon(Icons.videogame_asset,
                size: 16, color: Color(0xFFFBB45B)),
            const SizedBox(width: 4),
            Text('控制者：$controllerName',
                style: const TextStyle(fontSize: 12, color: Color(0xFFFBB45B))),
          ],
        ],
      ),
    );
  }

  // ---- 视频画面 ----
  Widget _videoArea(BuildContext context) {
    final video = controller.video;
    Widget child;
    if (controller.isLoadingVideo) {
      child = const Center(child: CircularProgressIndicator());
    } else if (video != null && video.value.isInitialized) {
      child = AspectRatio(
        aspectRatio:
            video.value.aspectRatio == 0 ? 16 / 9 : video.value.aspectRatio,
        child: VideoPlayer(video),
      );
    } else if (controller.state?.hasVideo ?? false) {
      child = const Center(
        child: Text('无法播放该视频', style: TextStyle(color: Colors.white38)),
      );
    } else {
      child = const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.movie_creation_outlined,
                size: 48, color: Colors.white24),
            SizedBox(height: 12),
            Text('还没有片子，点下方「＋」添加直链', style: TextStyle(color: Colors.white38)),
          ],
        ),
      );
    }
    // 填满父级 Expanded，视频用 Center+AspectRatio 居中留黑边，不强制自身高度
    return Container(color: Colors.black, child: Center(child: child));
  }

  // ---- 播放控制条 ----
  Widget _controlBar(BuildContext context, bool isController) {
    final video = controller.video;
    if (video == null) return const SizedBox.shrink(); // 视频未就绪先不显示

    // 用 ValueListenableBuilder 监听控制器：进度/播放态变化时只重建控制条，
    // 不再靠外层每 500ms 全局 setState（那会在拆卸/弹窗时引发元素 deactivation 竞态）。
    return ValueListenableBuilder<VideoPlayerValue>(
      valueListenable: video,
      builder: (context, value, _) {
        final playing = value.isPlaying;
        final duration = value.duration;
        final position = value.position;
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          color: const Color(0xFF1A1A1A),
          child: Column(
            children: [
              Row(
                children: [
                  IconButton(
                    icon: Icon(playing ? Icons.pause : Icons.play_arrow),
                    onPressed: isController
                        ? () => playing ? controller.pause() : controller.play()
                        : null,
                  ),
                  Expanded(
                    child: _ProgressBar(
                      position: position,
                      duration: duration,
                      enabled: isController,
                      onSeek: (secs) => controller.seek(secs),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text('${_fmt(position)} / ${_fmt(duration)}',
                      style:
                          const TextStyle(fontSize: 11, color: Colors.white54)),
                ],
              ),
              if (!isController)
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    icon: const Icon(Icons.pan_tool_alt, size: 16),
                    label: const Text('取得控制权'),
                    onPressed: controller.takeControl,
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  // ---- 播放列表 ----
  Widget _playlistArea(BuildContext context, bool isController) {
    final playlist = controller.playlist;
    final currentItemId = controller.state?.currentItemId ?? '';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
          child: Row(
            children: [
              Text('播放列表 (${playlist.length})',
                  style: const TextStyle(
                      color: Colors.white54,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 1)),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.add, size: 20),
                tooltip: '添加直链',
                onPressed: () => _showAddDialog(context),
              ),
            ],
          ),
        ),
        Expanded(
          child: playlist.isEmpty
              ? const Center(
                  child:
                      Text('播放列表为空', style: TextStyle(color: Colors.white24)))
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  itemCount: playlist.length,
                  itemBuilder: (_, i) {
                    final item = playlist[i];
                    final isCurrent = item.itemId == currentItemId;
                    return _PlaylistTile(
                      item: item,
                      isCurrent: isCurrent,
                      canControl: isController,
                      onPlay: () => controller.replaceUrl(item.url, item.title),
                      onRemove: () => controller.removeItem(item.itemId),
                    );
                  },
                ),
        ),
      ],
    );
  }

  Future<void> _showAddDialog(BuildContext context) async {
    final result = await showDialog<_AddVideoDialogResult>(
      context: context,
      builder: (ctx) => const _AddVideoDialog(),
    );
    if (result == null) return;

    // 等弹窗路由完成本帧拆卸后再触发外层放映室重建，避免输入框 deactivation
    // 期间收到放映室状态更新，导致 InputDecorator 被调度到错误 build scope。
    await WidgetsBinding.instance.endOfFrame;
    if (!context.mounted) return;

    if (result.replace) {
      controller.replaceUrl(result.url, result.title); // 替换当前并立即播放
    } else {
      controller.addUrl(result.url, result.title); // 追加到播放列表
    }
  }

  static String _fmt(Duration d) {
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    final h = d.inHours;
    return h > 0 ? '$h:$m:$s' : '$m:$s';
  }
}

class _AddVideoDialogResult {
  final String url;
  final String title;
  final bool replace;

  const _AddVideoDialogResult({
    required this.url,
    required this.title,
    required this.replace,
  });
}

class _AddVideoDialog extends StatefulWidget {
  const _AddVideoDialog();

  @override
  State<_AddVideoDialog> createState() => _AddVideoDialogState();
}

class _AddVideoDialogState extends State<_AddVideoDialog> {
  final _urlController = TextEditingController();
  final _titleController = TextEditingController();

  @override
  void dispose() {
    _urlController.dispose();
    _titleController.dispose();
    super.dispose();
  }

  void _submit({required bool replace}) {
    final url = _urlController.text.trim();
    if (url.isEmpty) {
      Navigator.pop(context);
      return;
    }

    final rawTitle = _titleController.text.trim();
    final title = rawTitle.isEmpty ? url.split('/').last : rawTitle;
    Navigator.pop(
      context,
      _AddVideoDialogResult(url: url, title: title, replace: replace),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: const Color(0xFF1E1E1E),
      title: const Text('添加视频直链'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _urlController,
            autofocus: true,
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(
              labelText: '视频直链 URL',
              hintText: 'https://.../movie.mp4',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _titleController,
            textInputAction: TextInputAction.done,
            decoration: const InputDecoration(labelText: '标题（可选）'),
            onSubmitted: (_) => _submit(replace: true),
          ),
        ],
      ),
      actionsOverflowButtonSpacing: 8,
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context), child: const Text('取消')),
        OutlinedButton.icon(
          icon: const Icon(Icons.playlist_add, size: 18),
          label: const Text('添加到列表'),
          onPressed: () => _submit(replace: false),
        ),
        FilledButton.icon(
          icon: const Icon(Icons.play_circle, size: 18),
          label: const Text('替换并播放'),
          onPressed: () => _submit(replace: true),
        ),
      ],
    );
  }
}

class _ProgressBar extends StatelessWidget {
  final Duration position;
  final Duration duration;
  final bool enabled;
  final ValueChanged<double> onSeek;

  const _ProgressBar({
    required this.position,
    required this.duration,
    required this.enabled,
    required this.onSeek,
  });

  @override
  Widget build(BuildContext context) {
    final total = duration.inMilliseconds.toDouble();
    final value =
        total <= 0 ? 0.0 : (position.inMilliseconds.toDouble()).clamp(0, total);
    return SliderTheme(
      data: SliderTheme.of(context).copyWith(
        trackHeight: 3,
        thumbShape: RoundSliderThumbShape(enabledThumbRadius: enabled ? 6 : 0),
        overlayShape: const RoundSliderOverlayShape(overlayRadius: 12),
      ),
      child: Slider(
        min: 0,
        max: total <= 0 ? 1 : total,
        value: total <= 0 ? 0 : value.toDouble(),
        activeColor: const Color(0xFF6DE2D2),
        inactiveColor: Colors.white24,
        // 观众只读：onChanged=null 置灰
        onChanged: enabled ? (v) => onSeek(v / 1000.0) : null,
      ),
    );
  }
}

class _PlaylistTile extends StatelessWidget {
  final ScreeningPlaylistItem item;
  final bool isCurrent;
  final bool canControl;
  final VoidCallback onPlay;
  final VoidCallback onRemove;

  const _PlaylistTile({
    required this.item,
    required this.isCurrent,
    required this.canControl,
    required this.onPlay,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      decoration: BoxDecoration(
        color: isCurrent
            ? const Color(0xFF6DE2D2).withValues(alpha: 0.12)
            : const Color(0xFF1E1E1E),
        borderRadius: BorderRadius.circular(8),
      ),
      child: ListTile(
        dense: true,
        leading: Icon(
          isCurrent ? Icons.play_circle_fill : Icons.movie_outlined,
          color: isCurrent ? const Color(0xFF6DE2D2) : Colors.white38,
          size: 20,
        ),
        title: Text(
          item.title.isEmpty ? item.url : item.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 13,
            color: isCurrent ? Colors.white : Colors.white70,
          ),
        ),
        subtitle: isCurrent
            ? const Text('正在播放',
                style: TextStyle(fontSize: 11, color: Color(0xFF6DE2D2)))
            : null,
        trailing: canControl
            ? Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (!isCurrent)
                    IconButton(
                      icon: const Icon(Icons.play_arrow, size: 18),
                      onPressed: onPlay,
                    ),
                  IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    color: Colors.white38,
                    onPressed: onRemove,
                  ),
                ],
              )
            : null,
        onTap: canControl && !isCurrent ? onPlay : null,
      ),
    );
  }
}

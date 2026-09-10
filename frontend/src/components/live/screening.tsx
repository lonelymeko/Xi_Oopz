import { useEffect, useRef, useState } from "react";

import { DownloadIcon, ExpandIcon, PauseIcon, PlayIcon, PlaylistAddIcon, PlaylistIcon, TrashIcon } from "./icons";
import { buildApiUrl } from "../../config/runtime";
import type { ScreeningPlaylistItem, ScreeningSnapshot, User, Channel } from "../../types";
import { isLikelyLiveScreeningURL } from "../../utils/live";
import type { DownloadNoticeEvent, ScreeningPlayerElement } from "../../types/live";

/**
 * 播放进度同步锚点。
 * `at` 使用本地单调时钟（performance.now），`time` 是同一时刻房间广播的播放进度。
 * 用它可以只依赖本机时钟外推进度，避免 Date.now() 与服务端 updatedAt 混用造成时钟差。
 */
export type ScreeningSyncAnchor = {
  at: number;
  time: number;
  rate: number;
  playing: boolean;
  itemId: string;
};

/**
 * 计算观众端应当对齐到的播放进度。
 * 有可用锚点时按本地单调时钟外推；否则（首个状态、切换条目、暂停/拖动）直接用房间里的
 * currentTime 对齐。旧实现用 `Date.now() - new Date(updatedAt)` 计算 elapsed，混用了本机与
 * 服务端墙钟：一旦两端有时钟差，elapsed 会被算成 0 或偏大，targetTime 就会稳定落后真实位置
 * 并超过 3s 阈值，于是每个 tick 都把播放器拉回同一个秒数，表现为「无限回溯、不跟随控制者」。
 */
export function projectScreeningTime(anchor: ScreeningSyncAnchor | null, state: ScreeningSnapshot["state"], now: number): number {
  if (anchor && anchor.itemId === state.currentItemId && anchor.playing && state.playbackState === "playing") {
    return anchor.time + ((now - anchor.at) / 1000) * anchor.rate;
  }
  return state.currentTime;
}

/**
 * 放映室核心面板与播放列表组件。
 */
/**
 * 放映室主面板组件，负责播放器同步与控制事件上报。
 */
export function ScreeningRoomPanel({
  channel,
  snapshot,
  currentUser,
  joinEpoch,
  joined,
  urlInput,
  titleInput,
  onUrlInputChange,
  onTitleInputChange,
  onReplace,
  onAppend,
  onPlaybackEvent,
  onError,
  onDownloadNotice,
}: {
  channel: Channel;
  snapshot: ScreeningSnapshot | null;
  currentUser: User | null;
  joinEpoch: number;
  joined: boolean;
  urlInput: string;
  titleInput: string;
  onUrlInputChange: (value: string) => void;
  onTitleInputChange: (value: string) => void;
  onReplace: (input: { url: string; title: string }) => void;
  onAppend: (input: { url: string; title: string }) => void;
  onPlaybackEvent: (type: string, payload: { itemId?: string; currentTime: number; playbackRate: number }) => void;
  onError: (title: string, message: string) => void;
  onDownloadNotice: (event: DownloadNoticeEvent) => void;
}) {
  const playerRef = useRef<ScreeningPlayerElement | null>(null);
  const imageStageRef = useRef<HTMLDivElement | null>(null);
  const tickTimerRef = useRef<number | null>(null);
  const imageTickTimerRef = useRef<number | null>(null);
  const lastLoadedItemRef = useRef<string>("");
  const lastAppliedJoinEpochRef = useRef(-1);
  const previousControllerRef = useRef(false);
  // Monotonic playback-sync anchor: project the controller's position using the viewer's
  // own performance.now() clock instead of Date.now() - server.updatedAt, which mixes the
  // client and server wall clocks and causes repeated seek-back loops when there is clock
  // skew (one side keeps being pulled back to the same second).
  const syncAnchorRef = useRef<ScreeningSyncAnchor | null>(null);
  const lastAnchorStampRef = useRef(0);
  // 图片序列（HLS 图片流）走的是另一条渲染路径，没有 <media-player> 元素，单独维护锚点。
  const imageAnchorRef = useRef<ScreeningSyncAnchor | null>(null);
  const lastImageAnchorStampRef = useRef(0);
  // Latest derived context for the controller tick timer, so the 2.5s interval isn't torn
  // down and recreated on every render/state change (which made ticks irregular and let
  // viewers drift past the 3s alignment threshold between ticks).
  const tickContextRef = useRef<{
    isController: boolean;
    isLiveScreening: boolean;
    isImageSequence: boolean;
    playing: boolean;
    itemId: string;
  }>({ isController: false, isLiveScreening: false, isImageSequence: false, playing: false, itemId: "" });
  const imageReadyItemRef = useRef("");
  const [imagePlaylist, setImagePlaylist] = useState<ImageSequencePlaylistState>({
    frames: [],
    sourceUrl: "",
    status: "idle",
  });
  const [imageCurrentTime, setImageCurrentTime] = useState(0);
  const [proxyImageFrames, setProxyImageFrames] = useState(false);
  // 只保留「是否正在下载」用于按钮的取消态；进度百分比统一交给通知栏展示。
  const [downloadRunning, setDownloadRunning] = useState(false);
  const [resolving, setResolving] = useState(false);
  const downloadAbortRef = useRef<AbortController | null>(null);

  const state = snapshot?.state || null;
  const viewers = snapshot?.viewers || [];
  const isController = Boolean(currentUser && state && state.controllerUserId === currentUser.id);
  const controllerName = viewers.find((item) => item.user.id === state?.controllerUserId)?.user.displayName || "当前主持人";
  const isLiveScreening = isLikelyLiveScreeningURL(state?.currentUrl);
  const isPlaying = state?.playbackState === "playing";
  const playbackUrl = buildScreeningPlaybackUrl(state?.currentUrl);
  const isImageSequence = imagePlaylist.sourceUrl === playbackUrl && imagePlaylist.status === "ready" && imagePlaylist.frames.length > 0;
  const imageDuration = isImageSequence ? getImageSequenceDuration(imagePlaylist.frames) : 0;
  const activeImageFrame = isImageSequence ? getImageSequenceFrameAtTime(imagePlaylist.frames, imageCurrentTime) : null;

  useEffect(() => {
    imageReadyItemRef.current = "";
    setImageCurrentTime(0);
    setProxyImageFrames(false);
    if (!playbackUrl || !isLikelyHLSPlaybackUrl(playbackUrl)) {
      setImagePlaylist({ frames: [], sourceUrl: playbackUrl, status: "idle" });
      return;
    }

    const controller = new AbortController();
    setImagePlaylist({ frames: [], sourceUrl: playbackUrl, status: "loading" });
    void fetch(playbackUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`manifest request failed: ${response.status}`);
        }
        return response.text();
      })
      .then(async (manifest) => {
        if (controller.signal.aborted) return;
        const frames = parseImageSequenceHLSManifest(manifest, playbackUrl);
        if (frames.length > 0 && (await isPNGWrappedTSFrame(frames[0].url, controller.signal))) {
          if (!controller.signal.aborted) {
            setImagePlaylist({ frames: [], sourceUrl: playbackUrl, status: "unsupported" });
          }
          return;
        }
        setImagePlaylist({
          frames,
          sourceUrl: playbackUrl,
          status: frames.length > 0 ? "ready" : "unsupported",
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setImagePlaylist({ frames: [], sourceUrl: playbackUrl, status: "error" });
        }
      });

    return () => controller.abort();
  }, [playbackUrl, state?.currentItemId]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (!state) {
      if (player.src) {
        player.src = "";
      }
      lastLoadedItemRef.current = "";
      lastAppliedJoinEpochRef.current = -1;
      return;
    }
    const shouldReloadForJoin = lastAppliedJoinEpochRef.current !== joinEpoch;
    if (state.currentItemId && (lastLoadedItemRef.current !== state.currentItemId || player.src !== playbackUrl || shouldReloadForJoin)) {
      lastLoadedItemRef.current = state.currentItemId;
      lastAppliedJoinEpochRef.current = joinEpoch;
      player.src = playbackUrl;
    } else if (!state.currentItemId && player.src) {
      player.src = "";
      lastLoadedItemRef.current = "";
    }
  }, [joinEpoch, playbackUrl, state?.channelId, state?.currentItemId, state]);

  useEffect(() => {
    if (!isImageSequence || !state?.currentItemId) return;
    const player = playerRef.current;
    if (player?.src) {
      player.src = "";
    }
  }, [isImageSequence, state?.currentItemId]);

  useEffect(() => {
    if (!isImageSequence || !state?.currentItemId) {
      imageAnchorRef.current = null;
      lastImageAnchorStampRef.current = 0;
      return;
    }

    const projectImageTime = () => {
      const projected = projectScreeningTime(imageAnchorRef.current, state, performance.now());
      setImageCurrentTime(imageDuration ? Math.min(Math.max(0, projected), imageDuration) : Math.max(0, projected));
    };

    // 与视频播放器一致：只在拿到更新的房间状态时重新锚定，随后用本地单调时钟外推。
    const stamp = Date.parse(state.updatedAt || "");
    const stampValue = Number.isFinite(stamp) ? stamp : 0;
    const previousAnchor = imageAnchorRef.current;
    if (previousAnchor === null || previousAnchor.itemId !== state.currentItemId || stampValue > lastImageAnchorStampRef.current) {
      lastImageAnchorStampRef.current = stampValue;
      imageAnchorRef.current = {
        at: performance.now(),
        time: state.currentTime,
        rate: state.playbackRate || 1,
        playing: state.playbackState === "playing",
        itemId: state.currentItemId,
      };
    }

    projectImageTime();
    if (state.playbackState !== "playing") {
      return;
    }
    const timer = window.setInterval(projectImageTime, 250);
    return () => window.clearInterval(timer);
  }, [imageDuration, isImageSequence, state]);

  useEffect(() => {
    if (!isImageSequence || !isController || !state?.awaitingReady || !state.currentItemId) return;
    if (imageReadyItemRef.current === state.currentItemId) return;
    imageReadyItemRef.current = state.currentItemId;
    onPlaybackEvent("screening.controller.ready", {
      itemId: state.currentItemId,
      currentTime: 0,
      playbackRate: state.playbackRate || 1,
    });
  }, [isController, isImageSequence, onPlaybackEvent, state]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !state || !state.currentItemId) {
      syncAnchorRef.current = null;
      lastAnchorStampRef.current = -1;
      return;
    }

    if (isLiveScreening) {
      if (state.playbackState === "playing" && player.paused) {
        void player.play().catch(() => undefined);
      }
      if (
        (state.playbackState === "paused" ||
          state.playbackState === "loading" ||
          state.playbackState === "ended" ||
          state.playbackState === "idle") &&
        !player.paused
      ) {
        void player.pause().catch(() => undefined);
      }
      return;
    }

    const now = performance.now();
    // Project the controller's position with our own monotonic clock anchored to the last
    // received state (see projectScreeningTime) instead of `Date.now() - server updatedAt`.
    const targetTime = projectScreeningTime(syncAnchorRef.current, state, now);

    if (state.playbackRate > 0 && Math.abs(player.playbackRate - state.playbackRate) > 0.01) {
      player.playbackRate = state.playbackRate;
    }

    // 控制者是进度的权威源，绝不能拿房间广播 seek 自己——否则有人加入/tick 广播携带
    // 略旧的 currentTime 时，会把控制者反复拉回到广播时刻，表现为“播一会又回退”。
    // 只有观众才对齐远端进度。（与 Flutter 端 _syncViewerToState 的 !isController 守卫一致。）
    if (!isController && targetTime != null && Number.isFinite(targetTime)) {
      const media = player as HTMLElement & { readyState?: number };
      const readyState = typeof media.readyState === "number" ? media.readyState : 4;
      // Only realign once we actually have data; seeking a still-buffering player would make it
      // re-buffer and immediately drift again, repeating the rollback loop.
      if (readyState >= 2 && Math.abs(player.currentTime - targetTime) >= 3) {
        try {
          player.currentTime = targetTime;
        } catch {
          // ignore seek race during loading
        }
      }
    }

    if (state.playbackState === "playing" && player.paused) {
      void player.play().catch(() => undefined);
    }
    if (
      (state.playbackState === "paused" ||
        state.playbackState === "loading" ||
        state.playbackState === "ended" ||
        state.playbackState === "idle") &&
      !player.paused
    ) {
      void player.pause().catch(() => undefined);
    }

    // Re-anchor for the next projection. Only accept strictly newer room state: a delayed or
    // duplicated broadcast (for example a viewer-list change re-broadcasting the same
    // updated_at) must not rewind a projection we already advanced locally.
    const stamp = Date.parse(state.updatedAt || "");
    const stampValue = Number.isFinite(stamp) ? stamp : 0;
    const previousAnchor = syncAnchorRef.current;
    const shouldAnchor =
      previousAnchor === null || previousAnchor.itemId !== state.currentItemId || stampValue > lastAnchorStampRef.current;
    if (shouldAnchor) {
      lastAnchorStampRef.current = stampValue;
      syncAnchorRef.current = {
        at: now,
        time: state.currentTime,
        rate: state.playbackRate || 1,
        playing: state.playbackState === "playing",
        itemId: state.currentItemId,
      };
    }
  }, [isController, isLiveScreening, state]);

  // Keep the tick context ref fresh without recreating the interval below.
  useEffect(() => {
    tickContextRef.current = {
      isController,
      isLiveScreening,
      isImageSequence,
      playing: isPlaying,
      itemId: state?.currentItemId || "",
    };
  }, [isController, isImageSequence, isLiveScreening, isPlaying, state?.currentItemId]);

  useEffect(() => {
    if (tickTimerRef.current) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (!isController || !isPlaying || isLiveScreening || isImageSequence) {
      return;
    }
    tickTimerRef.current = window.setInterval(() => {
      const player = playerRef.current;
      const context = tickContextRef.current;
      if (!player || !context.itemId) return;
      onPlaybackEvent("screening.tick", {
        itemId: context.itemId,
        currentTime: player.currentTime,
        playbackRate: player.playbackRate || 1,
      });
    }, 2500);
    return () => {
      if (tickTimerRef.current) {
        window.clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
    };
  }, [isController, isImageSequence, isLiveScreening, isPlaying, onPlaybackEvent]);

  useEffect(() => {
    if (imageTickTimerRef.current) {
      window.clearInterval(imageTickTimerRef.current);
      imageTickTimerRef.current = null;
    }
    if (!isImageSequence || !isController || !state || state.playbackState !== "playing" || !state.currentItemId) {
      return;
    }
    imageTickTimerRef.current = window.setInterval(() => {
      const context = tickContextRef.current;
      if (!context.itemId) return;
      onPlaybackEvent("screening.tick", {
        itemId: context.itemId,
        currentTime: projectScreeningTime(imageAnchorRef.current, state, performance.now()),
        playbackRate: state.playbackRate || 1,
      });
    }, 2500);
    return () => {
      if (imageTickTimerRef.current) {
        window.clearInterval(imageTickTimerRef.current);
        imageTickTimerRef.current = null;
      }
    };
  }, [imageDuration, isController, isImageSequence, onPlaybackEvent, state]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    const logPlayerEvent = (eventName: string, extra?: Record<string, unknown>) => {
      void eventName;
      void extra;
    };

    const handleCanPlay = () => {
      logPlayerEvent("can-play");
      if (!isController || !state?.awaitingReady || !state.currentItemId) return;
      onPlaybackEvent("screening.controller.ready", {
        itemId: state.currentItemId,
        currentTime: 0,
        playbackRate: player.playbackRate || 1,
      });
    };
    const handlePlay = () => {
      logPlayerEvent("play");
      if (!isController || !state?.currentItemId) return;
      onPlaybackEvent("screening.play", {
        itemId: state.currentItemId,
        currentTime: player.currentTime || 0,
        playbackRate: player.playbackRate || 1,
      });
    };
    const handlePause = () => {
      logPlayerEvent("pause");
      if (!isController || !state?.currentItemId || state.playbackState === "loading") return;
      onPlaybackEvent("screening.pause", {
        itemId: state.currentItemId,
        currentTime: player.currentTime || 0,
        playbackRate: player.playbackRate || 1,
      });
    };
    const handleSeeked = () => {
      if (isLiveScreening) return;
      logPlayerEvent("seeked");
      if (!isController || !state?.currentItemId) return;
      onPlaybackEvent("screening.seek", {
        itemId: state.currentItemId,
        currentTime: player.currentTime || 0,
        playbackRate: player.playbackRate || 1,
      });
    };
    const handleRateChange = () => {
      if (isLiveScreening) return;
      logPlayerEvent("rate-change");
      if (!isController || !state?.currentItemId) return;
      onPlaybackEvent("screening.rate", {
        itemId: state.currentItemId,
        currentTime: player.currentTime || 0,
        playbackRate: player.playbackRate || 1,
      });
    };
    const handleEnded = () => {
      logPlayerEvent("ended");
      if (!isController || !state?.currentItemId) return;
      onPlaybackEvent("screening.item.ended", {
        itemId: state.currentItemId,
        currentTime: 0,
        playbackRate: player.playbackRate || 1,
      });
    };
    const handleLoadedMetadata = () => {
      logPlayerEvent("loaded-metadata", {
        duration: typeof player.duration === "number" && Number.isFinite(player.duration) ? player.duration : null,
      });
    };
    const handleCanPlayThrough = () => {
      logPlayerEvent("can-play-through");
    };
    const handleWaiting = () => {
      logPlayerEvent("waiting");
    };
    const handleStalled = () => {
      logPlayerEvent("stalled");
    };
    const handleSeeking = () => {
      logPlayerEvent("seeking");
    };
    const handleError = (event: Event) => {
      const playerWithError = player as HTMLElement & {
        error?: { code?: number; message?: string } | null;
        networkState?: number;
        readyState?: number;
      };
      logPlayerEvent("error", {
        eventType: event.type,
        errorCode: playerWithError.error?.code ?? null,
        errorMessage: playerWithError.error?.message ?? null,
        networkState: playerWithError.networkState ?? null,
        readyState: playerWithError.readyState ?? null,
      });
    };
    const handleProviderChange = (event: Event) => {
      const provider = (event as CustomEvent<ScreeningHLSProvider | null>).detail;
      if (!provider || provider.type !== "hls" || !("config" in provider)) return;
      provider.config = {
        ...provider.config,
        fLoader: PNGWrappedTSFragmentLoader,
      };
    };

    player.addEventListener("provider-change", handleProviderChange);
    player.addEventListener("can-play", handleCanPlay);
    player.addEventListener("can-play-through", handleCanPlayThrough);
    player.addEventListener("loaded-metadata", handleLoadedMetadata);
    player.addEventListener("play", handlePlay);
    player.addEventListener("pause", handlePause);
    player.addEventListener("waiting", handleWaiting);
    player.addEventListener("stalled", handleStalled);
    player.addEventListener("seeking", handleSeeking);
    player.addEventListener("seeked", handleSeeked);
    player.addEventListener("rate-change", handleRateChange);
    player.addEventListener("end", handleEnded);
    player.addEventListener("error", handleError);

    return () => {
      player.removeEventListener("can-play", handleCanPlay);
      player.removeEventListener("can-play-through", handleCanPlayThrough);
      player.removeEventListener("loaded-metadata", handleLoadedMetadata);
      player.removeEventListener("play", handlePlay);
      player.removeEventListener("pause", handlePause);
      player.removeEventListener("waiting", handleWaiting);
      player.removeEventListener("stalled", handleStalled);
      player.removeEventListener("seeking", handleSeeking);
      player.removeEventListener("seeked", handleSeeked);
      player.removeEventListener("rate-change", handleRateChange);
      player.removeEventListener("end", handleEnded);
      player.removeEventListener("error", handleError);
      player.removeEventListener("provider-change", handleProviderChange);
    };
  }, [channel.id, isController, isLiveScreening, onPlaybackEvent, state]);

  useEffect(() => {
    const becameController = isController && !previousControllerRef.current;
    previousControllerRef.current = isController;
    if (!becameController || !state?.currentItemId) {
      return;
    }
    const timer = window.setTimeout(() => {
      const player = playerRef.current;
      if (!player) return;
      const payload = {
        itemId: state.currentItemId,
        currentTime: Number.isFinite(player.currentTime) ? player.currentTime : state.currentTime,
        playbackRate: player.playbackRate || state.playbackRate || 1,
      };
      if (state.awaitingReady) {
        onPlaybackEvent("screening.controller.ready", payload);
        return;
      }
      onPlaybackEvent(player.paused ? "screening.pause" : "screening.tick", payload);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [isController, isLiveScreening, onPlaybackEvent, state]);

  const handleImagePlayToggle = () => {
    if (!isController || !state?.currentItemId) return;
    onPlaybackEvent(state.playbackState === "playing" ? "screening.pause" : "screening.play", {
      itemId: state.currentItemId,
      currentTime: imageCurrentTime,
      playbackRate: state.playbackRate || 1,
    });
  };

  const handleImageSeek = (value: number) => {
    if (!isController || !state?.currentItemId) return;
    setImageCurrentTime(value);
    onPlaybackEvent("screening.seek", {
      itemId: state.currentItemId,
      currentTime: value,
      playbackRate: state.playbackRate || 1,
    });
  };

  const handleImageFullscreen = () => {
    void imageStageRef.current?.requestFullscreen?.();
  };

  /**
   * 下载当前放映的视频到本地。
   * 直链交给浏览器原生下载（后端代理 download=1 同源 + attachment，流式落盘）；
   * HLS 分片必须前端抓齐再拼成单个文件。
   * 进度统一走通知栏（onDownloadNotice），按钮里不再单独维护一套百分比。
   */
  async function handleDownloadCurrent() {
    const rawUrl = state?.currentUrl?.trim();
    if (!rawUrl) return;
    if (isLiveScreening) {
      onError("暂不支持下载", "直播流没有固定结尾，无法下载为本地文件");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      onError("暂不支持下载", "当前播放地址不是可下载的直链");
      return;
    }

    const fallbackName = (state?.currentTitle || "").trim() || decodeURIComponent(parsed.pathname.split("/").pop() || "") || "video";

    if (!isLikelyHLSManifestPath(parsed.pathname)) {
      const ext = (parsed.pathname.match(/\.[a-z0-9]{2,4}$/i)?.[0] || "").toLowerCase();
      const filename =
        ext && fallbackName.toLowerCase().endsWith(ext) ? fallbackName : `${fallbackName.replace(/\.[a-z0-9]{2,4}$/i, "")}${ext || ".mp4"}`;
      triggerNativeDownload(buildApiUrl(`/api/media/proxy?segments=1&download=1&url=${encodeURIComponent(parsed.toString())}`), filename);
      // 原生下载由浏览器接管，前端观测不到进度，只提示已交给浏览器
      onDownloadNotice({ phase: "handedOff", title: filename });
      return;
    }

    if (downloadAbortRef.current) {
      downloadAbortRef.current.abort();
      return;
    }
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    setDownloadRunning(true);
    // 这里不发 begin：fMP4 源会走原生下载、没有前端进度，进度通知由 begin 阶段按需创建
    try {
      const result = await assembleHLSDownload(
        parsed.toString(),
        controller.signal,
        (done, total) => {
          if (total > 0) {
            onDownloadNotice({ phase: "progress", progress: Math.floor((done / total) * 100) });
          }
        },
        (phase) => onDownloadNotice(phase === "begin" ? { phase: "begin", title: fallbackName } : { phase: "remuxing" }),
        fallbackName,
      );

      if (result.mode === "native") {
        // 后端拼流成单个文件流，交给浏览器原生下载（有下载栏，前端不持有字节）
        triggerNativeDownload(result.url, result.filename);
        onDownloadNotice({ phase: "handedOff", title: result.filename });
        return;
      }

      saveBlobToLocal(result.blob, result.filename);
      onDownloadNotice({
        phase: "done",
        title: result.filename,
        message: result.remuxed
          ? "已转封装为 MP4 并保存到本地"
          : result.filename.endsWith(".ts")
            ? "该片源编码无法转成 MP4，已按 TS 原样保存"
            : "已保存到本地",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        onDownloadNotice({ phase: "cancelled" });
      } else {
        console.error(error);
        onDownloadNotice({
          phase: "failed",
          title: "下载失败",
          message: error instanceof Error ? error.message : "拉取视频分片失败，请稍后重试",
        });
      }
    } finally {
      downloadAbortRef.current = null;
      setDownloadRunning(false);
    }
  }

  async function prepareSubmissionInput() {
    const url = urlInput.trim();
    if (!url) {
      onError("放映室操作失败", "请输入可直接播放的视频 URL");
      return null;
    }
    // 已是直链就直接用；否则当作视频网页地址，交后端无头浏览器嗅探真实直链，
    // 免去手动开发者工具找 m3u8 的过程。
    if (isDirectMediaUrl(url)) {
      return { url, title: titleInput.trim() };
    }
    setResolving(true);
    try {
      const resp = await fetch(buildApiUrl(`/api/media/resolve?url=${encodeURIComponent(url)}`));
      const data = (await resp.json()) as { mediaUrl?: string; error?: string };
      if (!resp.ok || !data.mediaUrl) {
        onError("解析失败", data.error || "未能从该网页解析出可播放的视频直链");
        return null;
      }
      return { url: data.mediaUrl, title: titleInput.trim() };
    } catch (error) {
      onError("解析失败", error instanceof Error ? error.message : "解析视频网页时出错");
      return null;
    } finally {
      setResolving(false);
    }
  }

  return (
    <section className="screening-panel">
      <div className="screening-panel__header">
        <div className="screening-panel__title">
          <div className="chat-panel__title-icon">
            <PlayIcon />
          </div>
          <div>
            <h3>{channel.name}</h3>
            <span>{state?.currentTitle || channel.topic || "通过可直链访问的视频 URL 发起同步观影。"}</span>
          </div>
        </div>
        <div className="screening-panel__meta">
          <span className="connection-badge">{state?.playbackState || "idle"}</span>
          <span className="screening-panel__controller">控制者：{controllerName}</span>
        </div>
      </div>

      <div className="screening-stage">
        <div className="screening-stage__video-wrap">
          {isImageSequence ? (
            <div ref={imageStageRef} className="screening-stage__image-sequence">
              {activeImageFrame ? (
                <img
                  key={activeImageFrame.url}
                  className="screening-stage__image-frame"
                  src={proxyImageFrames ? buildProxiedMediaUrl(activeImageFrame.url) : activeImageFrame.url}
                  alt={state?.currentTitle || channel.name}
                  draggable={false}
                  referrerPolicy="no-referrer"
                  onError={() => {
                    if (!proxyImageFrames) {
                      setProxyImageFrames(true);
                    }
                  }}
                />
              ) : null}
              <div className="screening-stage__image-controls">
                <button
                  type="button"
                  className="screening-stage__image-button"
                  disabled={!isController}
                  title={state?.playbackState === "playing" ? "暂停" : "播放"}
                  aria-label={state?.playbackState === "playing" ? "暂停" : "播放"}
                  onClick={handleImagePlayToggle}
                >
                  {state?.playbackState === "playing" ? <PauseIcon /> : <PlayIcon />}
                  <span>{state?.playbackState === "playing" ? "暂停" : "播放"}</span>
                </button>
                <span className="screening-stage__image-time">
                  {formatScreeningTime(imageCurrentTime)} / {formatScreeningTime(imageDuration)}
                </span>
                <input
                  className="screening-stage__image-range"
                  type="range"
                  min="0"
                  max={Math.max(1, Math.floor(imageDuration))}
                  step="1"
                  value={Math.min(Math.floor(imageCurrentTime), Math.max(1, Math.floor(imageDuration)))}
                  disabled={!isController}
                  onChange={(event) => handleImageSeek(Number(event.currentTarget.value))}
                />
                <button
                  type="button"
                  className="screening-stage__image-button"
                  title="全屏"
                  aria-label="全屏"
                  onClick={handleImageFullscreen}
                >
                  <ExpandIcon />
                  <span>全屏</span>
                </button>
              </div>
            </div>
          ) : (
            <media-player
              ref={(node: HTMLElement | null) => {
                playerRef.current = node as ScreeningPlayerElement | null;
              }}
              class="screening-stage__player"
              aspect-ratio="16/9"
              src={playbackUrl || undefined}
              title={state?.currentTitle || channel.name}
              viewType="video"
              streamType={isLiveScreening ? "live" : "on-demand"}
              load="visible"
              preload="auto"
              playsinline
              crossorigin
            >
              <media-outlet></media-outlet>
              <media-community-skin></media-community-skin>
            </media-player>
          )}
          {joined && state?.currentUrl && !isImageSequence ? (
            <button
              type="button"
              className="screening-stage__download"
              title={downloadRunning ? "取消下载" : "下载到本地"}
              aria-label={downloadRunning ? "取消下载" : "下载到本地"}
              onClick={() => void handleDownloadCurrent()}
            >
              <DownloadIcon />
            </button>
          ) : null}
          {!state?.currentUrl ? (
            <div className="screening-stage__empty">
              {joined ? "输入直链视频 URL 后即可开始放映" : "双击左侧放映室频道即可进入并开始同步观影"}
            </div>
          ) : null}
        </div>
      </div>

      {joined ? (
        <div className="screening-composer">
          <div className="screening-composer__inputs">
            <input
              value={urlInput}
              onChange={(event) => onUrlInputChange(event.target.value)}
              placeholder="视频直链或视频网页地址（网页会自动解析）"
            />
            <input value={titleInput} onChange={(event) => onTitleInputChange(event.target.value)} placeholder="可选标题" />
          </div>
          <div className="screening-composer__actions">
            <button
              className="action-pill action-pill--labeled"
              disabled={resolving}
              onClick={() => {
                void (async () => {
                  const next = await prepareSubmissionInput();
                  if (!next) return;
                  onReplace(next);
                })();
              }}
            >
              <PlayIcon />
              <span>{resolving ? "解析中…" : "替换当前并开始"}</span>
            </button>
            <button
              className="action-pill action-pill--labeled"
              disabled={resolving}
              onClick={() => {
                void (async () => {
                  const next = await prepareSubmissionInput();
                  if (!next) return;
                  onAppend(next);
                })();
              }}
            >
              <PlaylistAddIcon />
              <span>加入播放列表</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="screening-composer screening-composer--locked">
          <PlayIcon />
          <span>单击只是选中放映室，双击频道名称才会进入并连麦。</span>
        </div>
      )}
    </section>
  );
}

function buildScreeningPlaybackUrl(rawUrl?: string) {
  const value = rawUrl?.trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return value;
    }
    if (!isLikelyHLSManifestPath(parsed.pathname)) {
      return value;
    }
    return buildApiUrl(`/api/media/proxy.m3u8?url=${encodeURIComponent(parsed.toString())}`);
  } catch {
    return value;
  }
}

function buildProxiedMediaUrl(rawUrl: string) {
  return buildApiUrl(`/api/media/proxy?segments=1&url=${encodeURIComponent(rawUrl)}`);
}

/** HLS 下载的两种落地方式：fMP4 交后端拼流走原生下载，TS 在前端拼装并 remux。 */
export type HLSDownloadResult =
  | { mode: "native"; url: string; filename: string }
  | { mode: "blob"; blob: Blob; filename: string; remuxed: boolean };

/**
 * 处理 HLS 下载。按分片类型分流（这是刻意的取舍）：
 * - fMP4 源（有 EXT-X-MAP 或分片是 .m4s/.mp4）：只探测清单，随后把地址交给后端
 *   `/api/media/download.m3u8` 拼流，由浏览器原生下载（有下载栏、后端内存 O(单分片)）。
 *   后端不做转封装，但 fMP4 拼起来本来就是合法 mp4。
 * - 经典 TS 源：仍在前端抓分片、拼接，再用 mux.js 转封装成 mp4（后端没有转封装能力），
 *   失败则原样保存 .ts。这条路的进度走前端通知栏。
 *
 * 副作用：fMP4 源会多一次清单探测（清单很小）。换来的是下载不经前端内存。
 */
export async function assembleHLSDownload(
  manifestUrl: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
  onPhase?: (phase: "begin" | "remuxing") => void,
  preferredName?: string,
): Promise<HLSDownloadResult> {
  // 优先浏览器直连源站抓取（分片不经过后端），CORS 被拦时才回退后端代理。
  // 返回 [文本, 重定向后的最终地址]，最终地址用于把相对分片解析成绝对地址。
  const fetchTextDirectFirst = async (url: string): Promise<[string, string]> => {
    try {
      const direct = await fetch(url, { signal });
      if (direct.ok) return [await direct.text(), direct.url || url];
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
    const proxied = await fetch(buildApiUrl(`/api/media/proxy.m3u8?segments=1&url=${encodeURIComponent(url)}`), { signal });
    if (!proxied.ok) throw new Error(`清单拉取失败(${proxied.status})`);
    return [await proxied.text(), url];
  };

  const fetchBytesDirectFirst = async (url: string): Promise<ArrayBuffer> => {
    try {
      const direct = await fetch(url, { signal });
      if (direct.ok) return direct.arrayBuffer();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
    const proxied = await fetch(buildApiUrl(`/api/media/proxy?segments=1&url=${encodeURIComponent(url)}`), { signal });
    if (!proxied.ok) throw new Error(`分片拉取失败(${proxied.status})`);
    return proxied.arrayBuffer();
  };

  const absolutize = (ref: string, base: string) => {
    try {
      return new URL(ref, base).toString();
    } catch {
      return ref;
    }
  };

  let [manifest, manifestBase] = await fetchTextDirectFirst(manifestUrl);

  // 多码率主清单：取第一个变体，按当前清单地址解析成绝对地址后再取一层
  if (manifest.includes("#EXT-X-STREAM-INF")) {
    const lines = manifest.split(/\r?\n/);
    const variant = lines.find(
      (line, index) => index > 0 && lines[index - 1].startsWith("#EXT-X-STREAM-INF") && line.trim() && !line.startsWith("#"),
    );
    if (!variant) throw new Error("主清单里没有可用的码率变体");
    [manifest, manifestBase] = await fetchTextDirectFirst(absolutize(variant.trim(), manifestBase));
  }

  if (!manifest.includes("#EXT-X-ENDLIST")) {
    throw new Error("直播/无结尾的流无法下载为本地文件");
  }

  const lines = manifest.split(/\r?\n/).map((line) => line.trim());
  const parts: string[] = [];
  const mapMatch = manifest.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/);
  if (mapMatch) parts.push(absolutize(mapMatch[1], manifestBase));
  for (const line of lines) {
    if (line && !line.startsWith("#")) parts.push(absolutize(line, manifestBase));
  }
  if (!parts.length) throw new Error("清单里没有可下载的分片");

  const firstSegment = parts[mapMatch ? 1 : 0] || "";
  const isFragmentedMP4 = Boolean(mapMatch) || /\.(m4s|mp4)(\?|$)/i.test(firstSegment);
  if (isFragmentedMP4) {
    const filename = withMediaExtension(preferredName || filenameFromUrl(manifestUrl), ".mp4");
    const query = new URLSearchParams({ url: manifestUrl });
    if (preferredName?.trim()) {
      query.set("filename", preferredName.trim());
    }
    return { mode: "native", url: buildApiUrl(`/api/media/download.m3u8?${query.toString()}`), filename };
  }

  // 经典 MPEG-TS 分片：前端抓齐后拼接，再尝试转封装成 mp4。
  // 转封装失败（片源不是 H.264 或数据异常）就退回保存 .ts，绝不丢文件。
  onPhase?.("begin");
  const buffers: ArrayBuffer[] = [];
  for (let i = 0; i < parts.length; i++) {
    buffers.push(await fetchBytesDirectFirst(parts[i]));
    onProgress(i + 1, parts.length);
  }

  const tsBytes = concatBuffers(buffers);
  const baseName = preferredName || filenameFromUrl(manifestUrl);
  onPhase?.("remuxing");
  const remuxed = await remuxTsToFragmentedMp4(tsBytes);
  if (remuxed) {
    return {
      mode: "blob",
      blob: new Blob([remuxed as BlobPart], { type: "video/mp4" }),
      filename: withMediaExtension(baseName, ".mp4"),
      remuxed: true,
    };
  }
  return {
    mode: "blob",
    blob: new Blob([tsBytes as BlobPart], { type: "video/mp2t" }),
    filename: withMediaExtension(baseName, ".ts"),
    remuxed: false,
  };
}

/** 取文件名主体（去掉扩展名），空则回落到 video。 */
function withMediaExtension(name: string, extension: string): string {
  const base = (name || "").trim().replace(/\.[a-z0-9]{2,4}$/i, "");
  return `${base || "video"}${extension}`;
}

function filenameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return decodeURIComponent(parsed.pathname.split("/").pop() || "") || "video";
  } catch {
    return "video";
  }
}

function concatBuffers(buffers: ArrayBuffer[]): Uint8Array {
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    merged.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return merged;
}

/**
 * 把 MPEG-TS 字节流转封装成 fragmented MP4（ftyp/moov + moof/mdat）。
 *
 * 只在片源确实是 H.264 时才可用：mux.js 的 TS 解析只认 h264(0x1b) 与 adts(0x0f)，
 * 其余 stream type（例如 HEVC 0x24）在 lib/m2ts/m2ts.js 里是 "ignore unknown stream types"
 * 直接丢弃——也就是说 HEVC 片源会转出「只有声音」甚至空的文件，比原来的 .ts 更糟。
 * 因此这里用「有没有出现过 video/combined 事件」来判定，判定不过就返回 null 让调用方回退 .ts。
 *
 * 返回 null 表示不能转（非 H.264 / 数据异常 / 产出为空）。
 */
export async function remuxTsToFragmentedMp4(tsBytes: Uint8Array): Promise<Uint8Array | null> {
  if (!tsBytes.byteLength) return null;
  // 按需加载：只有真的下载老片源（TS）时才把 mux.js 拉进来。实测整体静态 import 会让
  // 首屏主包 +82KB（gzip +26KB），改成动态 import 后主包不变，代价只落在下载路径上。
  const { Transmuxer } = await import("mux.js/lib/mp4");
  const transmuxer = new Transmuxer();
  // 这些值只在回调里被写入，用「容器 + 长度判断」而不是裸变量：TS 会把只在闭包里
  // 赋值的变量在后续检查处收窄成初始值（实测会报 "type 'never'"），长度判断不受影响。
  const initSegments: Uint8Array[] = [];
  const videoSegmentTypes: string[] = [];
  const mediaChunks: Uint8Array[] = [];

  transmuxer.on("data", (segment) => {
    if (segment.type === "video" || segment.type === "combined") {
      videoSegmentTypes.push(segment.type);
    }
    // init 段（ftyp+moov）每个事件都会给，只需要第一份，后续重复拼会让文件结构错乱
    if (segment.initSegment?.byteLength) {
      initSegments.push(segment.initSegment);
    }
    if (segment.data?.byteLength) {
      mediaChunks.push(segment.data);
    }
  });

  try {
    transmuxer.push(tsBytes);
    transmuxer.flush();
  } catch {
    return null;
  }

  // 没有 video 段 = 片源不是 H.264（mux.js 静默丢弃未知 stream type），此时绝不能
  // 返回音频/空文件，交给调用方回退保存原始 .ts
  if (!videoSegmentTypes.length || !initSegments.length || !mediaChunks.length) return null;

  const initSegment = initSegments[0];
  const total = initSegment.byteLength + mediaChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  merged.set(initSegment, 0);
  let offset = initSegment.byteLength;
  for (const chunk of mediaChunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 触发浏览器原生下载。
 * 目标是同源地址时，浏览器会流式写入磁盘并立即在下载栏显示进度，
 * 不需要前端先把整个文件缓冲成 blob（旧实现要等全部拉完才弹出“下载完成”）。
 */
function triggerNativeDownload(href: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function saveBlobToLocal(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  triggerNativeDownload(objectUrl, filename);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}

/** 是否已是可直接播放的媒体直链（否则视为需嗅探的视频网页地址）。 */
function isDirectMediaUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
    if (isLikelyHLSManifestPath(parsed.pathname)) return true;
    return /\.(mp4|m3u8|flv|mkv|webm|mov|ts|m4s)(\?|$)/i.test(parsed.pathname);
  } catch {
    return true;
  }
}

function isLikelyHLSManifestPath(pathname: string) {
  const path = pathname.toLowerCase();
  return path.endsWith(".m3u8") || path.endsWith("/m3u8") || path.includes(".m3u8/") || path.includes("/m3u8/");
}

type ImageSequenceFrame = {
  duration: number;
  startsAt: number;
  url: string;
};

type ImageSequencePlaylistState = {
  frames: ImageSequenceFrame[];
  sourceUrl: string;
  status: "idle" | "loading" | "ready" | "unsupported" | "error";
};

type ScreeningHLSProvider = {
  config: Record<string, unknown>;
  type: string;
};

type HLSLoaderCallbacks = {
  onError?: (error: { code: number; text: string }, context: HLSLoaderContext, networkDetails: unknown, stats: HLSLoaderStats) => void;
  onSuccess?: (
    response: { code: number; data: ArrayBuffer; text: string; url: string },
    stats: HLSLoaderStats,
    context: HLSLoaderContext,
    networkDetails: unknown,
  ) => void;
};

type HLSLoaderContext = {
  headers?: Record<string, string>;
  responseType?: string;
  url: string;
};

type HLSLoaderStats = {
  aborted: boolean;
  bwEstimate: number;
  chunkCount: number;
  loaded: number;
  loading: {
    end: number;
    first: number;
    start: number;
  };
  parsing: {
    end: number;
    start: number;
  };
  buffering: {
    end: number;
    first: number;
    start: number;
  };
  retry: number;
  total: number;
};

class PNGWrappedTSFragmentLoader {
  private abortController: AbortController | null = null;
  public stats: HLSLoaderStats = {
    aborted: false,
    bwEstimate: 0,
    chunkCount: 0,
    loaded: 0,
    loading: {
      end: 0,
      first: 0,
      start: 0,
    },
    parsing: {
      end: 0,
      start: 0,
    },
    buffering: {
      end: 0,
      first: 0,
      start: 0,
    },
    retry: 0,
    total: 0,
  };

  load(context: HLSLoaderContext, _config: unknown, callbacks: HLSLoaderCallbacks) {
    this.abortController = new AbortController();
    this.stats.loading.start = performance.now();
    void fetch(context.url, {
      headers: context.headers,
      signal: this.abortController.signal,
    })
      .then(async (response) => {
        this.stats.loading.first = performance.now();
        const buffer = await response.arrayBuffer();
        const data = unwrapPNGWrappedTSSegment(buffer);
        this.stats.loaded = data.byteLength;
        this.stats.total = data.byteLength;
        this.stats.chunkCount = 1;
        this.stats.loading.end = performance.now();
        callbacks.onSuccess?.(
          {
            code: response.status,
            data,
            text: "",
            url: response.url || context.url,
          },
          this.stats,
          context,
          null,
        );
      })
      .catch((error) => {
        if (this.stats.aborted) return;
        this.stats.loading.end = performance.now();
        callbacks.onError?.(
          {
            code: 0,
            text: error instanceof Error ? error.message : "fragment request failed",
          },
          context,
          null,
          this.stats,
        );
      });
  }

  abort() {
    this.stats.aborted = true;
    this.abortController?.abort();
  }

  destroy() {
    this.abort();
    this.abortController = null;
  }
}

export function parseImageSequenceHLSManifest(manifest: string, baseUrl: string): ImageSequenceFrame[] {
  const lines = manifest.split(/\r?\n/);
  const frames: ImageSequenceFrame[] = [];
  let pendingDuration = 0;
  let mediaReferenceCount = 0;
  let startsAt = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const durationText = line.slice("#EXTINF:".length).split(",")[0];
      const duration = Number.parseFloat(durationText);
      pendingDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }

    mediaReferenceCount += 1;
    const resolvedUrl = resolvePlaylistReference(line, baseUrl);
    if (!resolvedUrl || !isLikelyImageUrl(resolvedUrl)) {
      return [];
    }
    const duration = pendingDuration > 0 ? pendingDuration : 1;
    frames.push({ duration, startsAt, url: resolvedUrl });
    startsAt += duration;
    pendingDuration = 0;
  }

  return mediaReferenceCount > 0 && frames.length === mediaReferenceCount ? frames : [];
}

function isLikelyHLSPlaybackUrl(value: string) {
  try {
    return isLikelyHLSManifestPath(new URL(value, window.location.href).pathname);
  } catch {
    return value.toLowerCase().includes(".m3u8");
  }
}

function resolvePlaylistReference(value: string, baseUrl: string) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return "";
  }
}

function isLikelyImageUrl(value: string) {
  try {
    const pathname = new URL(value, window.location.href).pathname.toLowerCase();
    return /\.(png|jpe?g|webp|gif|avif)$/.test(pathname);
  } catch {
    return /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/.test(value.toLowerCase());
  }
}

async function isPNGWrappedTSFrame(url: string, signal: AbortSignal) {
  try {
    const response = await fetch(url, {
      headers: { Range: "bytes=0-1023" },
      signal,
    });
    const buffer = await response.arrayBuffer();
    return isPNGWrappedTSSegment(buffer);
  } catch {
    return false;
  }
}

export function unwrapPNGWrappedTSSegment(buffer: ArrayBuffer) {
  const offset = findPNGWrappedTSSegmentOffset(buffer);
  return offset >= 0 ? buffer.slice(offset) : buffer;
}

function isPNGWrappedTSSegment(buffer: ArrayBuffer) {
  return findPNGWrappedTSSegmentOffset(buffer) >= 0;
}

export function findPNGWrappedTSSegmentOffset(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length <= 188 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return -1;
  }
  const maxOffset = Math.min(4096, bytes.length - 188);
  for (let offset = 8; offset <= maxOffset; offset += 1) {
    if (bytes[offset] !== 0x47) continue;
    let syncMatches = 0;
    for (let packet = 0; packet < 5; packet += 1) {
      const index = offset + packet * 188;
      if (index >= bytes.length || bytes[index] === 0x47) {
        syncMatches += 1;
      }
    }
    if (syncMatches >= 4) {
      return offset;
    }
  }
  return -1;
}

function getImageSequenceDuration(frames: ImageSequenceFrame[]) {
  const lastFrame = frames[frames.length - 1];
  return lastFrame ? lastFrame.startsAt + lastFrame.duration : 0;
}

function getImageSequenceFrameAtTime(frames: ImageSequenceFrame[], currentTime: number) {
  if (!frames.length) return null;
  const duration = getImageSequenceDuration(frames);
  const targetTime = Math.min(Math.max(0, currentTime), Math.max(0, duration - 0.001));
  return frames.find((frame) => targetTime >= frame.startsAt && targetTime < frame.startsAt + frame.duration) || frames[frames.length - 1];
}

function formatScreeningTime(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * 放映室播放列表组件。
 */
export function ScreeningPlaylistSection({
  playlist,
  onRemove,
}: {
  playlist: ScreeningPlaylistItem[];
  onRemove: (itemId: string) => void;
}) {
  return (
    <section className="member-section">
      <h4 className="screening-playlist__heading">
        <PlaylistIcon />
        <span>{`播放列表 · ${playlist.length}`}</span>
      </h4>
      <div className="screening-playlist-sidebar">
        {playlist.length ? (
          playlist.map((item, index) => (
            <div key={item.itemId} className="screening-playlist__item">
              <span>{index + 1}</span>
              <div className="screening-playlist__content">
                <div className="screening-playlist__title-row">
                  <strong title={item.title || item.url}>{item.title || item.url}</strong>
                  <button
                    type="button"
                    className="screening-playlist__delete"
                    title="删除视频"
                    aria-label={`删除 ${item.title || item.url}`}
                    onClick={() => onRemove(item.itemId)}
                  >
                    <TrashIcon />
                  </button>
                </div>
                <p>{item.url}</p>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-state empty-state--small">当前播放列表为空</div>
        )}
      </div>
    </section>
  );
}

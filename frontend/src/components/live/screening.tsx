import { useEffect, useRef, useState } from "react";

import { DownloadIcon, PlayIcon, TrashIcon } from "./icons";
import { buildApiUrl } from "../../config/runtime";
import type { ScreeningPlaylistItem, ScreeningSnapshot, User, Channel } from "../../types";
import { isLikelyLiveScreeningURL } from "../../utils/live";
import type { ScreeningPlayerElement } from "../../types/live";

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
  urlInput,
  titleInput,
  onUrlInputChange,
  onTitleInputChange,
  onReplace,
  onAppend,
  onPlaybackEvent,
  onError,
}: {
  channel: Channel;
  snapshot: ScreeningSnapshot | null;
  currentUser: User | null;
  joinEpoch: number;
  urlInput: string;
  titleInput: string;
  onUrlInputChange: (value: string) => void;
  onTitleInputChange: (value: string) => void;
  onReplace: (input: { url: string; title: string }) => void;
  onAppend: (input: { url: string; title: string }) => void;
  onPlaybackEvent: (type: string, payload: { itemId?: string; currentTime: number; playbackRate: number }) => void;
  onError: (title: string, message: string) => void;
}) {
  const playerRef = useRef<ScreeningPlayerElement | null>(null);
  const imageStageRef = useRef<HTMLDivElement | null>(null);
  const tickTimerRef = useRef<number | null>(null);
  const imageTickTimerRef = useRef<number | null>(null);
  const lastLoadedItemRef = useRef<string>("");
  const lastAppliedJoinEpochRef = useRef(-1);
  const previousControllerRef = useRef(false);
  const imageReadyItemRef = useRef("");
  const [imagePlaylist, setImagePlaylist] = useState<ImageSequencePlaylistState>({
    frames: [],
    sourceUrl: "",
    status: "idle",
  });
  const [imageCurrentTime, setImageCurrentTime] = useState(0);
  const [proxyImageFrames, setProxyImageFrames] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [resolving, setResolving] = useState(false);
  const downloadAbortRef = useRef<AbortController | null>(null);

  const state = snapshot?.state || null;
  const viewers = snapshot?.viewers || [];
  const isController = Boolean(currentUser && state && state.controllerUserId === currentUser.id);
  const controllerName = viewers.find((item) => item.user.id === state?.controllerUserId)?.user.displayName || "当前主持人";
  const isLiveScreening = isLikelyLiveScreeningURL(state?.currentUrl);
  const playbackUrl = buildScreeningPlaybackUrl(state?.currentUrl);
  const isImageSequence =
    imagePlaylist.sourceUrl === playbackUrl && imagePlaylist.status === "ready" && imagePlaylist.frames.length > 0;
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
    if (
      state.currentItemId &&
      (lastLoadedItemRef.current !== state.currentItemId || player.src !== playbackUrl || shouldReloadForJoin)
    ) {
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
    if (!isImageSequence || !state?.currentItemId) return;

    const updateCurrentImageTime = () => {
      setImageCurrentTime(getScreeningTargetTime(state, imageDuration));
    };
    updateCurrentImageTime();
    if (state.playbackState !== "playing") {
      return;
    }
    const timer = window.setInterval(updateCurrentImageTime, 250);
    return () => window.clearInterval(timer);
  }, [
    imageDuration,
    isImageSequence,
    state?.currentItemId,
    state?.currentTime,
    state?.playbackRate,
    state?.playbackState,
    state?.updatedAt,
    state,
  ]);

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
    if (!player || !state || !state.currentItemId) return;

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

    const elapsed =
      state.playbackState === "playing" && state.updatedAt ? Math.max(0, (Date.now() - new Date(state.updatedAt).getTime()) / 1000) : 0;
    const targetTime = state.playbackState === "playing" ? state.currentTime + elapsed * (state.playbackRate || 1) : state.currentTime;
    if (state.playbackRate > 0 && Math.abs(player.playbackRate - state.playbackRate) > 0.01) {
      player.playbackRate = state.playbackRate;
    }
    // 控制者是进度的权威源，绝不能拿房间广播 seek 自己——否则有人加入/tick 广播携带
    // 略旧的 currentTime（叠加客户端与服务器时钟差导致 elapsed 归零）时，会把控制者
    // 反复拉回到广播时刻，表现为“播一会又回退”。只有观众才对齐远端进度。
    // （与 Flutter 端 _syncViewerToState 的 !isController 守卫、VideoTogether 的 host 权威一致。）
    if (!isController && Math.abs(player.currentTime - targetTime) >= 3) {
      try {
        player.currentTime = targetTime;
      } catch {
        // ignore seek race during loading
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
  }, [isController, isLiveScreening, state]);

  useEffect(() => {
    if (tickTimerRef.current) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (!isController || !state || state.playbackState !== "playing" || isLiveScreening || isImageSequence) {
      return;
    }
    tickTimerRef.current = window.setInterval(() => {
      const player = playerRef.current;
      if (!player || !state.currentItemId) return;
      onPlaybackEvent("screening.tick", {
        itemId: state.currentItemId,
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
  }, [isController, isImageSequence, isLiveScreening, onPlaybackEvent, state]);

  useEffect(() => {
    if (imageTickTimerRef.current) {
      window.clearInterval(imageTickTimerRef.current);
      imageTickTimerRef.current = null;
    }
    if (!isImageSequence || !isController || !state || state.playbackState !== "playing" || !state.currentItemId) {
      return;
    }
    imageTickTimerRef.current = window.setInterval(() => {
      onPlaybackEvent("screening.tick", {
        itemId: state.currentItemId,
        currentTime: getScreeningTargetTime(state, imageDuration),
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
   * 直链走后端代理的 download=1（同源 + attachment，浏览器直接落盘）；
   * HLS 在前端经代理抓取全部分片拼成单个文件保存（沿用 media proxy 这套取流链路）。
   */
  async function handleDownloadCurrent() {
    if (downloadAbortRef.current) {
      downloadAbortRef.current.abort();
      return;
    }
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

    const controller = new AbortController();
    downloadAbortRef.current = controller;
    setDownloadProgress(0);
    try {
      if (!isLikelyHLSManifestPath(parsed.pathname)) {
        // 直链：优先浏览器直连源站取流（不吃后端流量），源站无 CORS 时才回退后端代理落盘
        const blob = await downloadDirectFile(parsed.toString(), controller.signal, (done, total) => {
          setDownloadProgress(total > 0 ? Math.floor((done / total) * 100) : 0);
        });
        if (blob) {
          const ext = (parsed.pathname.match(/\.[a-z0-9]{2,4}$/i)?.[0] || ".mp4").toLowerCase();
          saveBlobToLocal(blob, `${fallbackName.replace(/\.[a-z0-9]{2,4}$/i, "")}${ext}`);
        } else {
          const anchor = document.createElement("a");
          anchor.href = buildApiUrl(`/api/media/proxy?segments=1&download=1&url=${encodeURIComponent(parsed.toString())}`);
          anchor.download = fallbackName;
          anchor.rel = "noopener";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        }
        return;
      }

      const blobInfo = await assembleHLSDownload(parsed.toString(), controller.signal, (done, total) => {
        setDownloadProgress(total > 0 ? Math.floor((done / total) * 100) : 0);
      });
      saveBlobToLocal(blobInfo.blob, `${fallbackName.replace(/\.m3u8$/i, "")}${blobInfo.extension}`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error(error);
        onError("下载失败", error instanceof Error ? error.message : "拉取视频分片失败，请稍后重试");
      }
    } finally {
      downloadAbortRef.current = null;
      setDownloadProgress(null);
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
                <button type="button" className="screening-stage__image-button" disabled={!isController} onClick={handleImagePlayToggle}>
                  {state?.playbackState === "playing" ? "暂停" : "播放"}
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
                <button type="button" className="screening-stage__image-button" onClick={handleImageFullscreen}>
                  全屏
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
          {state?.currentUrl && !isImageSequence ? (
            <button
              type="button"
              className="screening-stage__download"
              title={downloadProgress != null ? "取消下载" : "下载到本地"}
              aria-label={downloadProgress != null ? "取消下载" : "下载到本地"}
              onClick={() => void handleDownloadCurrent()}
            >
              <DownloadIcon />
              {downloadProgress != null ? <span>{downloadProgress}%</span> : null}
            </button>
          ) : null}
          {!state?.currentUrl ? <div className="screening-stage__empty">输入直链视频 URL 后即可开始放映</div> : null}
        </div>
      </div>

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
            className="action-pill"
            disabled={resolving}
            onClick={() => {
              void (async () => {
                const next = await prepareSubmissionInput();
                if (!next) return;
                onReplace(next);
              })();
            }}
          >
            {resolving ? "解析中…" : "替换当前并开始"}
          </button>
          <button
            className="action-pill"
            disabled={resolving}
            onClick={() => {
              void (async () => {
                const next = await prepareSubmissionInput();
                if (!next) return;
                onAppend(next);
              })();
            }}
          >
            加入播放列表
          </button>
        </div>
      </div>
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

/**
 * 经 media proxy 抓取 HLS 全部分片并拼成单个可保存文件。
 * TS 分片直接顺序拼接即合法 TS 流；fMP4 由 EXT-X-MAP 的 init 段 + 分片拼接。
 */
export async function assembleHLSDownload(
  manifestUrl: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<{ blob: Blob; extension: string }> {
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
    const variant = lines.find((line, index) => index > 0 && lines[index - 1].startsWith("#EXT-X-STREAM-INF") && line.trim() && !line.startsWith("#"));
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

  const buffers: ArrayBuffer[] = [];
  for (let i = 0; i < parts.length; i++) {
    buffers.push(await fetchBytesDirectFirst(parts[i]));
    onProgress(i + 1, parts.length);
  }

  const firstSegment = parts[mapMatch ? 1 : 0] || "";
  const isFragmentedMP4 = Boolean(mapMatch) || /\.(m4s|mp4)(\?|$)/i.test(firstSegment);
  return {
    blob: new Blob(buffers, { type: isFragmentedMP4 ? "video/mp4" : "video/mp2t" }),
    extension: isFragmentedMP4 ? ".mp4" : ".ts",
  };
}

/**
 * 下载单文件直链（mp4 等）：优先浏览器直连源站取流拼 blob（不吃后端流量），
 * 源站无 CORS 被拦时返回 null，交由调用方回退后端 attachment 落盘。
 */
async function downloadDirectFile(
  url: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<Blob | null> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null; // CORS/网络被拦，回退后端
  }
  if (!resp.ok || !resp.body) return null;

  const total = Number(resp.headers.get("Content-Length") || 0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      onProgress(received, total);
    }
  }
  return new Blob(chunks as BlobPart[], { type: resp.headers.get("Content-Type") || "video/mp4" });
}

function saveBlobToLocal(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
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
  onSuccess?: (response: { code: number; data: ArrayBuffer; text: string; url: string }, stats: HLSLoaderStats, context: HLSLoaderContext, networkDetails: unknown) => void;
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

function getScreeningTargetTime(state: ScreeningSnapshot["state"], duration: number) {
  const elapsed =
    state.playbackState === "playing" && state.updatedAt ? Math.max(0, (Date.now() - new Date(state.updatedAt).getTime()) / 1000) : 0;
  const targetTime = state.playbackState === "playing" ? state.currentTime + elapsed * (state.playbackRate || 1) : state.currentTime;
  if (!duration) {
    return Math.max(0, targetTime);
  }
  return Math.min(Math.max(0, targetTime), Math.max(0, duration));
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
      <h4>{`播放列表 · ${playlist.length}`}</h4>
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

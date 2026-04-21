import { useEffect, useRef } from "react";

import { PlayIcon } from "./icons";
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
  const tickTimerRef = useRef<number | null>(null);
  const lastLoadedItemRef = useRef<string>("");
  const lastAppliedJoinEpochRef = useRef(-1);
  const previousControllerRef = useRef(false);

  const state = snapshot?.state || null;
  const viewers = snapshot?.viewers || [];
  const isController = Boolean(currentUser && state && state.controllerUserId === currentUser.id);
  const controllerName = viewers.find((item) => item.user.id === state?.controllerUserId)?.user.displayName || "当前主持人";
  const isLiveScreening = isLikelyLiveScreeningURL(state?.currentUrl);

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
      (lastLoadedItemRef.current !== state.currentItemId || player.src !== (state.currentUrl || "") || shouldReloadForJoin)
    ) {
      lastLoadedItemRef.current = state.currentItemId;
      lastAppliedJoinEpochRef.current = joinEpoch;
      player.src = state.currentUrl || "";
      console.info(`[screening-ui][${new Date().toISOString()}] screening:player:src-assigned`, {
        channelId: state.channelId,
        itemId: state.currentItemId,
        currentUrl: state.currentUrl,
        joinEpoch,
      });
    } else if (!state.currentItemId && player.src) {
      player.src = "";
      lastLoadedItemRef.current = "";
    }
  }, [joinEpoch, state?.channelId, state?.currentItemId, state?.currentUrl, state]);

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
    if (Math.abs(player.currentTime - targetTime) >= 3) {
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
  }, [isLiveScreening, state]);

  useEffect(() => {
    if (tickTimerRef.current) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (!isController || !state || state.playbackState !== "playing" || isLiveScreening) {
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
  }, [isController, isLiveScreening, onPlaybackEvent, state]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    const logPlayerEvent = (eventName: string, extra?: Record<string, unknown>) => {
      console.info(`[screening-ui][${new Date().toISOString()}] screening:player:${eventName}`, {
        channelId: state?.channelId || channel.id,
        itemId: state?.currentItemId || "",
        currentUrl: state?.currentUrl || player.src || "",
        playbackState: state?.playbackState || "idle",
        currentTime: Number.isFinite(player.currentTime) ? player.currentTime : null,
        paused: player.paused,
        playbackRate: player.playbackRate || 1,
        ...extra,
      });
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

  async function prepareSubmissionInput() {
    const url = urlInput.trim();
    if (!url) {
      onError("放映室操作失败", "请输入可直接播放的视频 URL");
      return null;
    }
    return { url, title: titleInput.trim() };
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
          <media-player
            ref={(node: HTMLElement | null) => {
              playerRef.current = node as ScreeningPlayerElement | null;
            }}
            class="screening-stage__player"
            aspect-ratio="16/9"
            src={state?.currentUrl || undefined}
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
          {!state?.currentUrl ? <div className="screening-stage__empty">输入直链视频 URL 后即可开始放映</div> : null}
        </div>
      </div>

      <div className="screening-composer">
        <div className="screening-composer__inputs">
          <input
            value={urlInput}
            onChange={(event) => onUrlInputChange(event.target.value)}
            placeholder="输入可直接播放的视频 URL，例如 https://.../demo.mp4"
          />
          <input value={titleInput} onChange={(event) => onTitleInputChange(event.target.value)} placeholder="可选标题" />
        </div>
        <div className="screening-composer__actions">
          <button
            className="action-pill"
            onClick={() => {
              void (async () => {
                const next = await prepareSubmissionInput();
                if (!next) return;
                onReplace(next);
              })();
            }}
          >
            替换当前并开始
          </button>
          <button
            className="action-pill"
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

/**
 * 放映室播放列表组件。
 */
export function ScreeningPlaylistSection({ playlist }: { playlist: ScreeningPlaylistItem[] }) {
  return (
    <section className="member-section">
      <h4>{`播放列表 · ${playlist.length}`}</h4>
      <div className="screening-playlist-sidebar">
        {playlist.length ? (
          playlist.map((item, index) => (
            <div key={item.itemId} className="screening-playlist__item">
              <span>{index + 1}</span>
              <div>
                <strong>{item.title || item.url}</strong>
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

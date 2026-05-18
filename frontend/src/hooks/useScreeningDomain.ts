import type { MutableRefObject } from "react";

import type { Channel } from "../types";
import type { ScreenShareOptions } from "../rtc";

/**
 * 放映领域 Hook 参数。
 */
type UseScreeningDomainOptions = {
  activeChannelRef: MutableRefObject<Channel | null>;
  currentVoiceChannelIdRef: MutableRefObject<number | null>;
  currentVoiceChannel: Channel | null;
  currentVoiceChannelId: number | null;
  firstTextChannel: Channel | null;
  screenSharing: boolean;
  screenSharePreset: { surface: ScreenShareOptions["surface"]; audioMode: ScreenShareOptions["audioMode"] };
  rtcRef: MutableRefObject<{
    stopScreenShare: (silent: boolean) => Promise<void>;
    startScreenShare: (options: ScreenShareOptions) => Promise<void>;
  } | null>;
  socketRef: MutableRefObject<{ send: (type: string, payload: unknown) => void } | null>;
  screeningJoinDedupRef: MutableRefObject<{ channelId: number | null; until: number }>;
  setScreenSharing: (value: boolean) => void;
  setShowScreenShareSheet: (value: boolean) => void;
  setScreeningSnapshot: (value: import("../types").ScreeningSnapshot | null) => void;
  setScreeningJoinEpoch: (value: number | ((current: number) => number)) => void;
  setActiveChannel: (value: Channel | null) => void;
  setStatus: (value: string) => void;
  pushNotice: (kind: "error" | "info", title: string, message: string) => void;
  showError: (error: unknown, title: string, fallback: string) => string;
  screeningLog: (label: string, extra?: Record<string, unknown>) => void;
  leaveVoice: () => Promise<void>;
  refreshPresence: () => Promise<void>;
};

/**
 * 放映领域 Hook：集中管理放映进出与屏幕共享动作。
 */
export function useScreeningDomain(options: UseScreeningDomainOptions) {
  const {
    activeChannelRef,
    currentVoiceChannelIdRef,
    currentVoiceChannel,
    currentVoiceChannelId,
    firstTextChannel,
    screenSharing,
    screenSharePreset,
    rtcRef,
    socketRef,
    screeningJoinDedupRef,
    setScreenSharing,
    setShowScreenShareSheet,
    setScreeningSnapshot,
    setScreeningJoinEpoch,
    setActiveChannel,
    setStatus,
    pushNotice,
    showError,
    screeningLog,
    leaveVoice,
    refreshPresence,
  } = options;

  /**
   * 离开放映频道并按需回退到文本频道。
   */
  async function leaveScreeningChannel(nextActive: Channel | null) {
    const leavingChannel = activeChannelRef.current?.type === "screening" ? activeChannelRef.current : null;
    if (!leavingChannel) {
      if (nextActive) {
        setActiveChannel(nextActive);
      }
      return;
    }

    socketRef.current?.send("screening.leave", { channelId: leavingChannel.id });
    screeningJoinDedupRef.current = { channelId: null, until: 0 };
    setScreeningSnapshot(null);
    setScreeningJoinEpoch((value) => value + 1);
    setActiveChannel(nextActive);
    void refreshPresence();
    await Promise.resolve();
    if (currentVoiceChannelIdRef.current) {
      await leaveVoice();
    }
  }

  /**
   * 切换屏幕共享开关。
   */
  async function toggleScreenShare() {
    if (currentVoiceChannel?.type === "screening") {
      setStatus("放映室连麦不支持屏幕共享");
      pushNotice("error", "无法共享屏幕", "放映室与语音频道互斥，且放映室连麦暂不支持屏幕共享。");
      return;
    }

    try {
      const next = !screenSharing;
      if (next) {
        setShowScreenShareSheet(true);
        return;
      }
      await rtcRef.current?.stopScreenShare(false);
      setScreenSharing(false);
      socketRef.current?.send("screen.state", { channelId: currentVoiceChannelId, screenSharing: false });
    } catch (error) {
      console.error(error);
      setStatus("屏幕共享失败");
      showError(error, "屏幕共享失败", "请检查浏览器权限或重新选择共享窗口");
    }
  }

  /**
   * 确认屏幕共享参数并启动共享。
   */
  async function confirmScreenShare() {
    try {
      const options: ScreenShareOptions = {
        surface: screenSharePreset.surface,
        audioMode: screenSharePreset.audioMode,
      };
      await rtcRef.current?.startScreenShare(options);
      setScreenSharing(true);
      setShowScreenShareSheet(false);
      if (options.surface === "screen" && options.audioMode === "share") {
        pushNotice(
          "info",
          "正在共享系统音频",
          "系统音频可能把远端通话声、通知声一起带出去，建议佩戴耳机；浏览器支持时会尝试启用 restrictOwnAudio 和 suppressLocalAudioPlayback 兜底。",
        );
      }
      socketRef.current?.send("screen.state", {
        channelId: currentVoiceChannelId,
        screenSharing: true,
      });
      screeningLog("screening:join:send", { channelId: currentVoiceChannelId, reason: "confirm-share" });
    } catch (error) {
      console.error(error);
      setStatus("屏幕共享失败");
      showError(error, "屏幕共享失败", "请检查浏览器权限或重新选择共享窗口");
    }
  }

  return {
    firstTextChannel,
    leaveScreeningChannel,
    toggleScreenShare,
    confirmScreenShare,
  };
}

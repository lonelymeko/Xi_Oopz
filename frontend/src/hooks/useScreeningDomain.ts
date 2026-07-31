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
  audioOnlySharing: boolean;
  rtcRef: MutableRefObject<{
    stopScreenShare: (silent: boolean) => Promise<void>;
    startScreenShare: (options: ScreenShareOptions) => Promise<void>;
    startAudioOnlyShare: () => Promise<void>;
    stopAudioOnlyShare: () => Promise<void>;
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
    audioOnlySharing,
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

  /**
   * 切换“仅共享系统音频”：直接弹系统选择器，不进入屏幕共享状态。
   */
  async function toggleAudioOnlyShare() {
    if (!currentVoiceChannelId) {
      pushNotice("info", "请先进入语音频道", "共享系统音频需要先加入一个语音频道");
      return;
    }
    try {
      if (audioOnlySharing) {
        await rtcRef.current?.stopAudioOnlyShare();
        setStatus("已停止共享系统音频");
        return;
      }
      await rtcRef.current?.startAudioOnlyShare();
      setStatus("正在共享系统音频");
    } catch (error) {
      // 用户在系统选择器点取消属于正常操作，不当成错误弹窗
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError")) {
        return;
      }
      console.error(error);
      showError(error, "共享系统音频失败", "请在系统选择器里勾选“分享音频”后重试");
    }
  }

  return {
    firstTextChannel,
    leaveScreeningChannel,
    toggleScreenShare,
    confirmScreenShare,
    toggleAudioOnlyShare,
  };
}

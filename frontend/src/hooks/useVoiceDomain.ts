import type { MutableRefObject } from "react";

import type { RTCController } from "../rtc";
import { pickPreferredAudioInputId } from "../utils/live";
import type { AudioInputOption } from "../types/live";

/**
 * 语音领域 Hook 参数。
 */
type UseVoiceDomainOptions = {
  currentVoiceChannelId: number | null;
  voiceTargetChannelId: number | null;
  selectedAudioInputId: string;
  noiseSuppressionEnabled: boolean;
  deafened: boolean;
  micEnabled: boolean;
  audioInputs: AudioInputOption[];
  setSelectedAudioInputId: (value: string | ((current: string) => string)) => void;
  setNoiseSuppressionEnabled: (value: boolean) => void;
  setShowAudioSettings: (value: boolean) => void;
  setStatus: (value: string) => void;
  setCurrentVoiceChannelId: (value: number | null) => void;
  setVoiceTargetChannelId: (value: number | null) => void;
  setMicEnabled: (value: boolean) => void;
  setDeafened: (value: boolean) => void;
  setScreenSharing: (value: boolean) => void;
  setVoiceMembers: (value: Map<number, import("../types").PresenceMember>) => void;
  setRemoteMedia: (value: Map<number, import("../types").RemoteMedia>) => void;
  setLocalAudioStream: (value: MediaStream | null) => void;
  setLocalScreenStream: (value: MediaStream | null) => void;
  setMaximizedScreenKey: (value: string | null) => void;
  setAudioInputs: (value: AudioInputOption[]) => void;
  setAudioPrewarming: (value: boolean) => void;
  socketRef: MutableRefObject<{ send: (type: string, payload: unknown) => void } | null>;
  rtcRef: MutableRefObject<RTCController | null>;
  joinTraceRef: MutableRefObject<{ id: number; startedAt: number; channelId: number } | null>;
  leaveTraceRef: MutableRefObject<{ id: number; startedAt: number; channelId: number | null } | null>;
  voiceTraceCounterRef: MutableRefObject<number>;
  voiceJoinInFlightRef: MutableRefObject<number | null>;
  voiceLeaveInFlightRef: MutableRefObject<boolean>;
  audioSettingsCloseTimerRef: MutableRefObject<number | null>;
  headphoneSettingsCloseTimerRef: MutableRefObject<number | null>;
  showError: (error: unknown, title: string, fallback: string) => string;
  resolveErrorMessage: (error: unknown, fallback: string) => string;
  voiceLog: (label: string, extra?: Record<string, unknown>) => void;
  refreshPresence: () => Promise<void>;
};

/**
 * 语音领域 Hook：集中管理语音入离会、设备切换与控制动作。
 */
export function useVoiceDomain(options: UseVoiceDomainOptions) {
  const {
    currentVoiceChannelId,
    voiceTargetChannelId,
    selectedAudioInputId,
    noiseSuppressionEnabled,
    deafened,
    micEnabled,
    audioInputs,
    setSelectedAudioInputId,
    setNoiseSuppressionEnabled,
    setShowAudioSettings,
    setStatus,
    setCurrentVoiceChannelId,
    setVoiceTargetChannelId,
    setMicEnabled,
    setDeafened,
    setScreenSharing,
    setVoiceMembers,
    setRemoteMedia,
    setLocalAudioStream,
    setLocalScreenStream,
    setMaximizedScreenKey,
    setAudioInputs,
    setAudioPrewarming,
    socketRef,
    rtcRef,
    joinTraceRef,
    leaveTraceRef,
    voiceTraceCounterRef,
    voiceJoinInFlightRef,
    voiceLeaveInFlightRef,
    audioSettingsCloseTimerRef,
    headphoneSettingsCloseTimerRef,
    showError,
    resolveErrorMessage,
    voiceLog,
    refreshPresence,
  } = options;

  /**
   * 加入语音频道并初始化本地音频状态。
   */
  async function joinVoice(channelId?: number) {
    const targetId = channelId || voiceTargetChannelId;
    if (!targetId) return;
    if (voiceJoinInFlightRef.current === targetId) return;

    voiceJoinInFlightRef.current = targetId;
    const effectiveAudioInputId = pickPreferredAudioInputId(audioInputs, selectedAudioInputId);
    const traceId = voiceTraceCounterRef.current + 1;
    voiceTraceCounterRef.current = traceId;
    joinTraceRef.current = { id: traceId, startedAt: performance.now(), channelId: targetId };

    try {
      if (effectiveAudioInputId !== selectedAudioInputId) {
        setSelectedAudioInputId(effectiveAudioInputId);
      }
      voiceLog("join:start", {
        traceId,
        channelId: targetId,
        selectedAudioInputId: effectiveAudioInputId,
        noiseSuppressionEnabled,
      });
      setStatus("正在打开麦克风并进入语音房...");
      await rtcRef.current?.setAudioInputDevice(effectiveAudioInputId);
      await rtcRef.current?.setNoiseSuppression(noiseSuppressionEnabled);
      await rtcRef.current?.joinVoice(targetId);
      setCurrentVoiceChannelId(targetId);
      setVoiceTargetChannelId(targetId);
      setMicEnabled(true);
      setDeafened(false);
      setScreenSharing(false);
      setStatus("正在加入语音房");
    } catch (error) {
      console.error(error);
      voiceLog("join:error", { traceId, error: error instanceof Error ? error.message : String(error) });
      setStatus(resolveErrorMessage(error, "麦克风权限失败"));
      showError(error, "加入语音房失败", "无法获取麦克风权限或建立实时连接");
    } finally {
      if (voiceJoinInFlightRef.current === targetId) {
        voiceJoinInFlightRef.current = null;
      }
    }
  }

  /**
   * 离开语音频道并回收本地语音相关状态。
   */
  async function leaveVoice() {
    if (voiceLeaveInFlightRef.current) return;

    voiceLeaveInFlightRef.current = true;
    const traceId = voiceTraceCounterRef.current + 1;
    voiceTraceCounterRef.current = traceId;
    leaveTraceRef.current = { id: traceId, startedAt: performance.now(), channelId: currentVoiceChannelId };

    try {
      voiceLog("leave:start", { traceId, channelId: currentVoiceChannelId });
      await rtcRef.current?.leaveVoice();
      setCurrentVoiceChannelId(null);
      setVoiceMembers(new Map());
      setRemoteMedia(new Map());
      setMicEnabled(true);
      setDeafened(false);
      setScreenSharing(false);
      setLocalAudioStream(null);
      setLocalScreenStream(null);
      setMaximizedScreenKey(null);
      setStatus("已离开语音房");
      void refreshPresence();
    } finally {
      voiceLeaveInFlightRef.current = false;
    }
  }

  /**
   * 切换麦克风启用状态并同步到服务端。
   */
  async function toggleMic() {
    const next = !micEnabled;
    if (next && deafened) {
      setDeafened(false);
    }
    setMicEnabled(next);
    await rtcRef.current?.toggleMic(next);
    if (currentVoiceChannelId) {
      socketRef.current?.send("voice.state", { channelId: currentVoiceChannelId, micEnabled: next });
    }
  }

  /**
   * 切换静听状态，开启时自动关闭麦克风。
   */
  async function toggleDeafen() {
    const next = !deafened;
    setDeafened(next);
    if (next && micEnabled) {
      setMicEnabled(false);
      await rtcRef.current?.toggleMic(false);
      if (currentVoiceChannelId) {
        socketRef.current?.send("voice.state", { channelId: currentVoiceChannelId, micEnabled: false });
      }
    }
    setStatus(next ? "已开启耳机静听，并自动关闭麦克风" : "已关闭耳机静听");
  }

  /**
   * 更新麦克风输入设备并触发预热。
   */
  async function handleAudioInputChange(deviceId: string) {
    setSelectedAudioInputId(deviceId);
    try {
      await rtcRef.current?.setAudioInputDevice(deviceId);
      await rtcRef.current?.prewarmAudio();
      setStatus("麦克风设备已更新");
    } catch (error) {
      console.error(error);
      setStatus("切换麦克风失败");
      showError(error, "切换麦克风失败", "请检查设备权限或重新选择设备");
    }
  }

  /**
   * 更新降噪开关并触发预热。
   */
  async function handleNoiseSuppressionChange(enabled: boolean) {
    setNoiseSuppressionEnabled(enabled);
    try {
      await rtcRef.current?.setNoiseSuppression(enabled);
      await rtcRef.current?.prewarmAudio();
      setStatus(enabled ? "已开启降噪" : "已关闭降噪");
    } catch (error) {
      console.error(error);
      setStatus("更新降噪配置失败");
      showError(error, "更新降噪配置失败", "请稍后重试");
      return;
    }
  }

  /**
   * 打开麦克风设置面板并执行设备预热。
   */
  function openAudioSettings() {
    if (audioSettingsCloseTimerRef.current) {
      window.clearTimeout(audioSettingsCloseTimerRef.current);
      audioSettingsCloseTimerRef.current = null;
    }
    setShowAudioSettings(true);
    setAudioPrewarming(true);
    voiceLog("audio-settings:hover-open", {
      selectedAudioInputId: selectedAudioInputId || "auto",
      noiseSuppressionEnabled,
    });

    void rtcRef.current
      ?.prewarmAudio()
      .then(async () => {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        const nextInputs = devices
          .filter((device) => device.kind === "audioinput")
          .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `麦克风 ${index + 1}` }));
        setAudioInputs(nextInputs);
        setSelectedAudioInputId((current) => pickPreferredAudioInputId(nextInputs, current));
      })
      .catch((error) => {
        console.error(error);
        showError(error, "预热麦克风失败", "无法预热当前麦克风设备");
      })
      .finally(() => {
        setAudioPrewarming(false);
      });
  }

  /**
   * 延迟关闭麦克风设置面板。
   */
  function scheduleCloseAudioSettings(setShowAudioSettings: (value: boolean) => void) {
    if (audioSettingsCloseTimerRef.current) {
      window.clearTimeout(audioSettingsCloseTimerRef.current);
    }
    audioSettingsCloseTimerRef.current = window.setTimeout(() => {
      setShowAudioSettings(false);
      audioSettingsCloseTimerRef.current = null;
    }, 180);
  }

  /**
   * 打开耳机静听设置面板。
   */
  function openHeadphoneSettings(setShowHeadphoneSettings: (value: boolean) => void) {
    if (headphoneSettingsCloseTimerRef.current) {
      window.clearTimeout(headphoneSettingsCloseTimerRef.current);
      headphoneSettingsCloseTimerRef.current = null;
    }
    setShowHeadphoneSettings(true);
  }

  /**
   * 延迟关闭耳机静听设置面板。
   */
  function scheduleCloseHeadphoneSettings(setShowHeadphoneSettings: (value: boolean) => void) {
    if (headphoneSettingsCloseTimerRef.current) {
      window.clearTimeout(headphoneSettingsCloseTimerRef.current);
    }
    headphoneSettingsCloseTimerRef.current = window.setTimeout(() => {
      setShowHeadphoneSettings(false);
      headphoneSettingsCloseTimerRef.current = null;
    }, 180);
  }

  return {
    joinVoice,
    leaveVoice,
    toggleMic,
    toggleDeafen,
    handleAudioInputChange,
    handleNoiseSuppressionChange,
    openAudioSettings,
    scheduleCloseAudioSettings,
    openHeadphoneSettings,
    scheduleCloseHeadphoneSettings,
  };
}

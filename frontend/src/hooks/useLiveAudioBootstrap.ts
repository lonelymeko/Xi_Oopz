import { useEffect } from "react";
import type { MutableRefObject } from "react";

import type { RTCController } from "../rtc";
import { pickPreferredAudioInputId } from "../utils/live";
import type { AudioInputOption } from "../types/live";

/**
 * 音频启动 Hook 参数。
 */
type UseLiveAudioBootstrapOptions = {
  sessionToken: string | null;
  userId: number | null;
  domainId: number | null;
  localAudioStream: MediaStream | null;
  showError: (error: unknown, title: string, fallback: string) => string;
  setStatus: (value: string) => void;
  setAudioDevicesLoading: (value: boolean) => void;
  setAudioPrewarming: (value: boolean) => void;
  setAudioInputs: (value: AudioInputOption[]) => void;
  setSelectedAudioInputId: (value: string | ((current: string) => string)) => void;
  rtcRef: MutableRefObject<RTCController | null>;
  startupAudioStreamRef: MutableRefObject<MediaStream | null>;
  audioBootstrapStartedRef: MutableRefObject<boolean>;
};

/**
 * 音频启动 Hook：管理设备同步、首轮预热与预热流接管。
 */
export function useLiveAudioBootstrap(options: UseLiveAudioBootstrapOptions) {
  const {
    sessionToken,
    userId,
    domainId,
    localAudioStream,
    showError,
    setStatus,
    setAudioDevicesLoading,
    setAudioPrewarming,
    setAudioInputs,
    setSelectedAudioInputId,
    rtcRef,
    startupAudioStreamRef,
    audioBootstrapStartedRef,
  } = options;

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setAudioDevicesLoading(false);
      return;
    }

    let disposed = false;
    const syncDevices = async () => {
      setAudioDevicesLoading(true);
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (disposed) return;
        const nextInputs = devices
          .filter((device) => device.kind === "audioinput")
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `麦克风 ${index + 1}`,
          }));
        setAudioInputs(nextInputs);
        setSelectedAudioInputId((current) => pickPreferredAudioInputId(nextInputs, current));
      } catch (error) {
        console.error(error);
      } finally {
        if (!disposed) {
          setAudioDevicesLoading(false);
        }
      }
    };

    void syncDevices();
    const handleDeviceChange = () => {
      void syncDevices();
    };
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [localAudioStream, setAudioDevicesLoading, setAudioInputs, setSelectedAudioInputId]);

  useEffect(() => {
    if (!rtcRef.current) return;
    if (startupAudioStreamRef.current) {
      rtcRef.current.primePrewarmedAudio(startupAudioStreamRef.current);
    }
  }, [domainId, rtcRef, sessionToken, startupAudioStreamRef, userId]);

  useEffect(() => {
    if (audioBootstrapStartedRef.current) return;
    audioBootstrapStartedRef.current = true;
    setAudioPrewarming(true);
    setStatus("正在请求麦克风权限...");

    const bootstrapAudio = async () => {
      if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
        setAudioDevicesLoading(false);
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
        video: false,
      });
      startupAudioStreamRef.current?.getTracks().forEach((track) => track.stop());
      startupAudioStreamRef.current = stream;
      rtcRef.current?.primePrewarmedAudio(stream);
      const devices = await navigator.mediaDevices.enumerateDevices();
      const nextInputs = devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `麦克风 ${index + 1}`,
        }));
      setAudioInputs(nextInputs);
      setSelectedAudioInputId((current) => pickPreferredAudioInputId(nextInputs, current));
      setStatus("麦克风与音频设备已就绪");
    };

    void bootstrapAudio()
      .catch((error) => {
        console.error(error);
        showError(error, "麦克风初始化失败", "无法获取麦克风权限或音频设备信息");
        setStatus("麦克风未授权");
      })
      .finally(() => {
        setAudioDevicesLoading(false);
        setAudioPrewarming(false);
      });
  }, [
    audioBootstrapStartedRef,
    rtcRef,
    setAudioDevicesLoading,
    setAudioInputs,
    setAudioPrewarming,
    setSelectedAudioInputId,
    setStatus,
    showError,
    startupAudioStreamRef,
  ]);
}

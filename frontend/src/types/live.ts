import type { AuthResponse, User } from "../types";
import type { ScreenAudioMode, ScreenShareSurface } from "../rtc";

/**
 * 会话类型：当前与鉴权返回保持一致。
 */
export type Session = AuthResponse;

/**
 * 鉴权模式类型。
 */
export type AuthMode = "login" | "register";

/**
 * 屏幕预览数据结构。
 */
export type ScreenPreview = {
  key: string;
  user: User;
  stream: MediaStream;
  isLocal: boolean;
};

/**
 * 音频输入设备选项。
 */
export type AudioInputOption = {
  deviceId: string;
  label: string;
};

/**
 * 通知项类型。
 */
export type Notice = {
  id: number;
  kind: "error" | "info";
  title: string;
  message: string;
};

/**
 * 屏幕共享预设。
 */
export type ScreenSharePreset = {
  surface: ScreenShareSurface;
  audioMode: ScreenAudioMode;
};

/**
 * 放映播放器元素扩展类型。
 */
export type ScreeningPlayerElement = HTMLElement & {
  src?: string;
  currentTime: number;
  duration?: number;
  playbackRate: number;
  volume?: number;
  paused: boolean;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  enterFullscreen?: (target?: string) => Promise<void>;
};

/**
 * 通用动作返回结构。
 */
export type LiveActionResult<T = void> = {
  ok: boolean;
  data?: T;
  errorMessage?: string;
};

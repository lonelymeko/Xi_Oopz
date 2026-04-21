import { useCallback } from "react";

/**
 * 语音调试日志标签集合。
 */
const VOICE_UI_DEBUG_LABELS = new Set([
  "join:start",
  "join:audio-device-applied",
  "join:noise-suppression-applied",
  "join:rtc.joinVoice-returned",
  "join:presence.snapshot",
  "join:error",
  "leave:start",
  "leave:rtc.leaveVoice-returned",
  "leave:local-state-cleared",
]);

/**
 * 放映调试日志标签集合。
 */
const SCREENING_DEBUG_LABELS = new Set([
  "screening:join:send",
  "screening:snapshot:received",
  "screening:controller:changed",
  "screening:player:src-assigned",
]);

/**
 * 实时日志 Hook：提供语音与放映的标签过滤日志函数。
 */
export function useLiveLogger() {
  /**
   * 语音日志：按白名单输出语音链路关键节点。
   */
  const voiceLog = useCallback((label: string, extra?: Record<string, unknown>) => {
    if (!VOICE_UI_DEBUG_LABELS.has(label)) return;
    const stamp = new Date().toISOString();
    if (extra) {
      console.info(`[voice-ui][${stamp}] ${label}`, extra);
      return;
    }
    console.info(`[voice-ui][${stamp}] ${label}`);
  }, []);

  /**
   * 放映日志：按白名单输出放映链路关键节点。
   */
  const screeningLog = useCallback((label: string, extra?: Record<string, unknown>) => {
    if (!SCREENING_DEBUG_LABELS.has(label)) return;
    const stamp = new Date().toISOString();
    if (extra) {
      console.info(`[screening-ui][${stamp}] ${label}`, extra);
      return;
    }
    console.info(`[screening-ui][${stamp}] ${label}`);
  }, []);

  return { voiceLog, screeningLog };
}

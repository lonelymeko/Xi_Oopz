import { useCallback } from "react";

/**
 * 实时日志 Hook：提供语音与放映的标签过滤日志函数。
 */
export function useLiveLogger() {
  /**
   * 语音日志：按白名单输出语音链路关键节点。
   */
  const voiceLog = useCallback((_label: string, _extra?: Record<string, unknown>) => {}, []);

  /**
   * 放映日志：按白名单输出放映链路关键节点。
   */
  const screeningLog = useCallback((_label: string, _extra?: Record<string, unknown>) => {}, []);

  return { voiceLog, screeningLog };
}

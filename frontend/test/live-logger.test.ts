import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useLiveLogger } from "../src/hooks/useLiveLogger";

const captures: Array<{ voiceLog: (...args: unknown[]) => void; screeningLog: (...args: unknown[]) => void }> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 探针组件：用于采集 Hook 输出函数引用。
 */
function LoggerProbe() {
  const { voiceLog, screeningLog } = useLiveLogger();
  captures.push({ voiceLog: voiceLog as (...args: unknown[]) => void, screeningLog: screeningLog as (...args: unknown[]) => void });
  return null;
}

describe("useLiveLogger", () => {
  afterEach(() => {
    captures.splice(0, captures.length);
  });

  it("多次渲染时应保持日志函数引用稳定", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
      root.render(createElement(LoggerProbe));
    });
    act(() => {
      root.render(createElement(LoggerProbe));
    });
    act(() => {
      root.unmount();
    });

    expect(captures.length).toBeGreaterThanOrEqual(2);
    expect(captures[0].voiceLog).toBe(captures[1].voiceLog);
    expect(captures[0].screeningLog).toBe(captures[1].screeningLog);
  });
});

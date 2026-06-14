import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatPeerDiagnostics, formatTime, initials, isLikelyLiveScreeningURL, pickPreferredAudioInputId } from "../src/utils/live";

describe("live utils", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T09:20:00+08:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("应正确生成头像首字母", () => {
    expect(initials("小明")).toBe("小明");
    expect(initials("  a ")).toBe("A");
    expect(initials()).toBe("?");
  });

  it("应正确格式化当日和跨日时间", () => {
    expect(formatTime("2026-04-12T08:15:00+08:00")).toBe("08:15");
    expect(formatTime("2026-04-11T23:10:00+08:00")).toContain("昨天");
  });

  it("应识别直播流地址", () => {
    expect(isLikelyLiveScreeningURL("https://live.bilibili.com/1")).toBe(true);
    expect(isLikelyLiveScreeningURL("https://example.com/camera.flv")).toBe(true);
    expect(isLikelyLiveScreeningURL("https://example.com/live/index.m3u8?stream=live")).toBe(true);
    expect(isLikelyLiveScreeningURL("https://example.com/video/index.m3u8")).toBe(false);
    expect(isLikelyLiveScreeningURL("https://example.com/video.mp4")).toBe(false);
  });

  it("应格式化链路诊断文案", () => {
    expect(
      formatPeerDiagnostics({
        userId: 1,
        latencyMs: 34,
        transport: "turn",
        retryCount: 2,
        recoveryMode: "relay",
        updatedAt: Date.now(),
      }),
    ).toContain("TURN");
  });

  it("应优先选择可用输入设备", () => {
    const inputs = [
      { deviceId: "default", label: "默认" },
      { deviceId: "mic-1", label: "麦克风 1" },
    ];
    expect(pickPreferredAudioInputId(inputs, "mic-1")).toBe("mic-1");
    expect(pickPreferredAudioInputId(inputs, "")).toBe("mic-1");
  });
});

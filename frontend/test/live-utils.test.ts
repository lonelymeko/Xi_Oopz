import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatPeerDiagnostics,
  formatTime,
  initials,
  isLikelyLiveScreeningURL,
  mapAudioInputDevices,
  pickPreferredAudioInputId,
} from "../src/utils/live";

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

  it("未选择时应跟随系统默认麦克风", () => {
    const inputs = [
      { deviceId: "mic-1", label: "麦克风 1" },
      { deviceId: "default", label: "系统默认（麦克风阵列）" },
      { deviceId: "communications", label: "通讯默认（麦克风阵列）" },
    ];
    // 用户手动选过就保留其选择
    expect(pickPreferredAudioInputId(inputs, "mic-1")).toBe("mic-1");
    // 未选择时跟随系统默认，而不是枚举顺序里的第一个具体设备
    expect(pickPreferredAudioInputId(inputs, "")).toBe("default");
    // 选中的设备被拔掉后同样回落到系统默认
    expect(pickPreferredAudioInputId(inputs, "unplugged-mic")).toBe("default");
  });

  it("无 default 条目时（如 Firefox）应取枚举首项", () => {
    const inputs = [
      { deviceId: "mic-a", label: "麦克风 A" },
      { deviceId: "mic-b", label: "麦克风 B" },
    ];
    expect(pickPreferredAudioInputId(inputs, "")).toBe("mic-a");
    expect(pickPreferredAudioInputId([], "")).toBe("");
  });

  it("应把系统默认设备标签整理为可读文案", () => {
    const devices = [
      { kind: "audioinput", deviceId: "default", label: "默认 - 麦克风阵列 (Realtek)" },
      { kind: "audioinput", deviceId: "communications", label: "Communications - 麦克风阵列 (Realtek)" },
      { kind: "audioinput", deviceId: "mic-1", label: "USB 麦克风" },
      { kind: "audiooutput", deviceId: "spk-1", label: "扬声器" },
      { kind: "audioinput", deviceId: "mic-2", label: "" },
    ] as unknown as MediaDeviceInfo[];

    expect(mapAudioInputDevices(devices)).toEqual([
      { deviceId: "default", label: "系统默认（麦克风阵列 (Realtek)）" },
      { deviceId: "communications", label: "通讯默认（麦克风阵列 (Realtek)）" },
      { deviceId: "mic-1", label: "USB 麦克风" },
      { deviceId: "mic-2", label: "麦克风 4" },
    ]);
  });
});

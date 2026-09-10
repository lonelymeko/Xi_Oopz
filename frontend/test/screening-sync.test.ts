import { describe, expect, it } from "vitest";

import { projectScreeningTime, type ScreeningSyncAnchor } from "../src/components/live/screening";
import type { ScreeningState } from "../src/types";

/**
 * 构造放映室状态；updatedAt 故意写成与观众端墙钟无关的值，
 * 用来证明同步推算不再依赖服务端时间戳。
 */
function state(overrides: Partial<ScreeningState> = {}): ScreeningState {
  return {
    channelId: 7,
    controllerUserId: 1,
    currentItemId: "item-1",
    currentUrl: "https://cdn.example.com/vod/index.m3u8",
    currentTitle: "demo",
    playbackState: "playing",
    currentTime: 60,
    playbackRate: 1,
    updatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    awaitingReady: false,
    syncToken: 3,
    ...overrides,
  };
}

function anchor(overrides: Partial<ScreeningSyncAnchor> = {}): ScreeningSyncAnchor {
  return { at: 1000, time: 60, rate: 1, playing: true, itemId: "item-1", ...overrides };
}

describe("projectScreeningTime", () => {
  it("应只用本地单调时钟外推，服务端 updatedAt 与本地墙钟差 6 小时也不受影响", () => {
    // 锚点在本地 1000ms 处锁定到 60s，本地 4500ms 时应推进到 63.5s。
    expect(projectScreeningTime(anchor(), state(), 4500)).toBe(63.5);
  });

  it("应按 playbackRate 外推", () => {
    expect(projectScreeningTime(anchor({ rate: 2 }), state({ playbackRate: 2 }), 3000)).toBe(64);
  });

  it("没有锚点时直接用房间 currentTime", () => {
    expect(projectScreeningTime(null, state({ currentTime: 12 }), 9999)).toBe(12);
  });

  it("暂停状态直接对齐房间 currentTime，不再外推", () => {
    expect(projectScreeningTime(anchor(), state({ playbackState: "paused", currentTime: 61 }), 9000)).toBe(61);
  });

  it("切换条目后旧锚点失效，回到房间 currentTime", () => {
    expect(projectScreeningTime(anchor(), state({ currentItemId: "item-2", currentTime: 5 }), 9000)).toBe(5);
  });

  it("锚点本身处于暂停时不再外推，避免暂停后进度漂移", () => {
    expect(projectScreeningTime(anchor({ playing: false }), state({ currentTime: 60 }), 9000)).toBe(60);
  });
});

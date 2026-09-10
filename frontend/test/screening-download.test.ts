import { afterEach, describe, expect, it, vi } from "vitest";

import { assembleHLSDownload } from "../src/components/live/screening";

function textResponse(body: string, url = "") {
  return { ok: true, status: 200, url, text: async () => body } as Response;
}

/** jsdom 的 Blob 缺 arrayBuffer()，用可检查内部分片的替身验证拼接顺序。 */
class InspectableBlob {
  readonly parts: ArrayBuffer[];
  readonly type: string;
  constructor(parts: ArrayBuffer[], options?: { type?: string }) {
    this.parts = parts;
    this.type = options?.type || "";
  }
  get size() {
    return this.parts.reduce((sum, part) => sum + part.byteLength, 0);
  }
  concatenated() {
    const merged = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) {
      merged.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    return merged;
  }
}

function binaryResponse(bytes: number[]) {
  return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer } as Response;
}

describe("assembleHLSDownload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("TS 分片应在前端拼装（不经后端拼流），并在转封装不可用时保留 .ts", async () => {
    const manifest = [
      "#EXTM3U",
      "#EXTINF:4,",
      "https://cdn.example.com/vod/seg1.ts",
      "#EXTINF:4,",
      "https://cdn.example.com/vod/seg2.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("index.m3u8")) return textResponse(manifest, url);
      if (url.includes("seg1.ts")) return binaryResponse([1, 2]);
      if (url.includes("seg2.ts")) return binaryResponse([3, 4]);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Blob", InspectableBlob);

    const progress: Array<[number, number]> = [];
    const phases: string[] = [];
    const result = await assembleHLSDownload(
      "https://cdn.example.com/vod/index.m3u8",
      new AbortController().signal,
      (done, total) => progress.push([done, total]),
      (phase) => phases.push(phase),
    );

    // 合成分片不是合法 TS，转封装必然失败 → 回退保存 .ts，绝不产出坏文件
    expect(result.mode).toBe("blob");
    if (result.mode !== "blob") throw new Error("expected blob mode");
    expect(result.remuxed).toBe(false);
    expect(result.filename.endsWith(".ts")).toBe(true);
    expect((result.blob as unknown as InspectableBlob).concatenated()).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    // TS 路径必须在取分片前通知 begin，并在拼装后进入 remuxing 阶段
    expect(phases).toEqual(["begin", "remuxing"]);
    // 直连优先：清单与分片第一跳都直接打源站，不走后端代理
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://cdn.example.com/vod/index.m3u8");
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes("/api/media/proxy"))).toBe(true);
  });

  it("fMP4 分片应交给后端拼流 + 原生下载，前端不再拉分片", async () => {
    const master = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=800000", "https://cdn.example.com/vod/variant.m3u8"].join("\n");
    const variant = [
      "#EXTM3U",
      '#EXT-X-MAP:URI="https://cdn.example.com/vod/init.mp4"',
      "#EXTINF:4,",
      "https://cdn.example.com/vod/chunk1.m4s",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("index.m3u8")) return textResponse(master, url);
      if (url.includes("variant.m3u8")) return textResponse(variant, url);
      throw new Error(`fMP4 源不应在前端拉分片，却请求了 ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await assembleHLSDownload(
      "https://cdn.example.com/vod/index.m3u8",
      new AbortController().signal,
      () => {},
      () => {},
      "我的影片",
    );

    expect(result.mode).toBe("native");
    if (result.mode !== "native") throw new Error("expected native mode");
    expect(result.filename).toBe("我的影片.mp4");
    expect(result.url).toContain("/api/media/download.m3u8?");
    expect(result.url).toContain(encodeURIComponent("https://cdn.example.com/vod/index.m3u8"));
    // 只探测清单（主清单 + 变体），一个分片都没拉
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("无 EXT-X-ENDLIST 的直播流应拒绝下载", async () => {
    const manifest = ["#EXTM3U", "#EXTINF:4,", "https://cdn.example.com/vod/seg1.ts"].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => textResponse(manifest)),
    );

    await expect(assembleHLSDownload("https://cdn.example.com/live/index.m3u8", new AbortController().signal, () => {})).rejects.toThrow(
      /直播/,
    );
  });
});

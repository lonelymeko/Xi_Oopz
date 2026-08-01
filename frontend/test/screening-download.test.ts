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

  it("应经代理抓取 TS 分片并按顺序拼接", async () => {
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
    const result = await assembleHLSDownload("https://cdn.example.com/vod/index.m3u8", new AbortController().signal, (done, total) =>
      progress.push([done, total]),
    );

    expect(result.extension).toBe(".ts");
    expect((result.blob as unknown as InspectableBlob).concatenated()).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    // 直连优先：清单与分片第一跳都直接打源站，不走后端代理
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://cdn.example.com/vod/index.m3u8");
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes("/api/media/proxy"))).toBe(true);
  });

  it("应先取主清单第一个变体，fMP4 需带 init 段且扩展名为 mp4", async () => {
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
      if (url.includes("init.mp4")) return binaryResponse([9]);
      if (url.includes("chunk1.m4s")) return binaryResponse([8]);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Blob", InspectableBlob);

    const result = await assembleHLSDownload("https://cdn.example.com/vod/index.m3u8", new AbortController().signal, () => {});

    expect(result.extension).toBe(".mp4");
    // init 段必须排在最前
    expect((result.blob as unknown as InspectableBlob).concatenated()).toEqual(new Uint8Array([9, 8]));
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

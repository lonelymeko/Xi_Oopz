import { describe, expect, it } from "vitest";

import { remuxTsToFragmentedMp4 } from "../src/components/live/screening";
import { H264_TS_BYTE_LENGTH, HEVC_TS_BYTE_LENGTH, h264TsBytes, hevcTsBytes } from "./fixtures/ts-samples";

/** 容器首部是否是 MP4 的 ftyp box（前 4 字节为 box 长度，紧接 "ftyp"）。 */
function hasFtypBox(bytes: Uint8Array): boolean {
  return bytes.length > 8 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp";
}

/** 顺序遍历顶层 box，返回类型列表（用来确认 ftyp/moov/moof/mdat 都在）。 */
function boxTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (size < 8) break;
    types.push(String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)));
    offset += size;
  }
  return types;
}

/** 字节流里是否出现指定 ASCII（H.264 在 mp4 里的 sample entry 是 "avc1"）。 */
function containsAscii(bytes: Uint8Array, text: string): boolean {
  const needle = Array.from(text, (ch) => ch.charCodeAt(0));
  outer: for (let i = 0; i + needle.length <= bytes.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe("remuxTsToFragmentedMp4 的编码闸门", () => {
  it("空输入应返回 null，让调用方回退保存 .ts", async () => {
    await expect(remuxTsToFragmentedMp4(new Uint8Array(0))).resolves.toBeNull();
  });

  it("非 TS 的任意字节应返回 null，而不是产出坏文件", async () => {
    await expect(remuxTsToFragmentedMp4(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).resolves.toBeNull();
  });
});

describe("remuxTsToFragmentedMp4（真实片源样本）", () => {
  it("样本本身必须完整——防止 base64 被截断（相邻字面量会被 ASI 拆开，静默只解码第一行）", () => {
    expect(h264TsBytes().byteLength).toBe(H264_TS_BYTE_LENGTH);
    expect(hevcTsBytes().byteLength).toBe(HEVC_TS_BYTE_LENGTH);
  });

  it("H.264 的 TS 应转出合法 fragmented MP4：init 段在前、含 moof/mdat、视频轨为 avc1", async () => {
    const bytes = await remuxTsToFragmentedMp4(h264TsBytes());
    expect(bytes).not.toBeNull();
    const output = bytes as Uint8Array;

    expect(hasFtypBox(output)).toBe(true);
    const types = boxTypes(output);
    expect(types[0]).toBe("ftyp");
    expect(types).toContain("moov");
    expect(types).toContain("moof");
    expect(types).toContain("mdat");
    // 视频轨以 avc1 写出，说明确实是 H.264 且真的带上了视频轨（不是只剩音频）
    expect(containsAscii(output, "avc1")).toBe(true);
  });

  it("HEVC 的 TS 必须返回 null（回退 .ts），不能产出只剩音频或空的 mp4", async () => {
    // mux.js 的 TS 解析只认 h264(0x1b) 与 adts(0x0f)，HEVC(0x24) 属于
    // "ignore unknown stream types" 会被静默丢弃；不拦就会得到无声/空文件。
    await expect(remuxTsToFragmentedMp4(hevcTsBytes())).resolves.toBeNull();
  });
});

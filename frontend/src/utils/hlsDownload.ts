/**
 * HLS 下载用的辅助工具：AES-128 分片解密、MP4 时长修正。
 */

export type HLSSegmentKey = {
  iv: Uint8Array | null;
  uri: string;
};

/** 解析 #EXT-X-KEY 行；METHOD=NONE 返回 null，非 AES-128 的加密方式直接报错。 */
export function parseHLSKeyLine(line: string, resolve: (ref: string) => string): HLSSegmentKey | null {
  const method = line.match(/METHOD=([^,\s]+)/)?.[1]?.toUpperCase() || "NONE";
  if (method === "NONE") return null;
  if (method !== "AES-128") throw new Error(`暂不支持 ${method} 加密的视频下载`);
  const uri = line.match(/URI="([^"]+)"/)?.[1];
  if (!uri) throw new Error("清单里的密钥地址缺失");
  const ivText = line.match(/IV=0x([0-9a-fA-F]+)/)?.[1];
  return { iv: ivText ? hexToBytes(ivText.padStart(32, "0").slice(-32)) : null, uri: resolve(uri) };
}

/**
 * AES-128 密钥必须是 16 字节。部分源站的 .key 文件写的是 32 位十六进制文本，
 * 实际加密用的是这段文本的前 16 个字符，这里统一裁成可用的 16 字节。
 */
export function normalizeAES128Key(key: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(key);
  if (bytes.length !== 32) return key;
  const isHexText = bytes.every((b) => (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46));
  return isHexText ? key.slice(0, 16) : key;
}

/** 未显式给 IV 时，按规范用分片的媒体序号（大端）作为 IV。 */
export function sequenceIV(sequence: number): Uint8Array {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence >>> 0);
  return iv;
}

export async function decryptAES128Segment(data: ArrayBuffer, key: ArrayBuffer, iv: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, cryptoKey, data);
}

/**
 * 把真实总时长写进 MP4 头（mvhd/tkhd/mdhd）。转封装器是流式输出，头里的时长是占位的最大值，
 * 不改的话播放器会显示错误的总时长。只处理 version 0 的盒子，其余原样返回。
 */
export function patchMP4Duration(init: Uint8Array, seconds: number): Uint8Array {
  const out = init.slice();
  const view = new DataView(out.buffer);
  let movieTimescale = 0;
  const walk = (start: number, end: number) => {
    for (let offset = start; offset + 8 <= end; ) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(out[offset + 4], out[offset + 5], out[offset + 6], out[offset + 7]);
      if (size < 8 || offset + size > end) return;
      const body = offset + 8;
      const isVersion0 = out[body] === 0;
      if ((type === "mvhd" || type === "mdhd") && isVersion0) {
        const timescale = view.getUint32(body + 12);
        if (type === "mvhd") movieTimescale = timescale;
        view.setUint32(body + 16, Math.min(0xfffffffe, Math.round(seconds * timescale)));
      } else if (type === "tkhd" && isVersion0 && movieTimescale > 0) {
        view.setUint32(body + 20, Math.min(0xfffffffe, Math.round(seconds * movieTimescale)));
      } else if (type === "moov" || type === "trak" || type === "mdia") {
        walk(body, offset + size);
      }
      offset += size;
    }
  };
  walk(0, out.byteLength);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

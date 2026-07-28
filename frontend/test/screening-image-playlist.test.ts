import { describe, expect, it } from "vitest";

import {
  findPNGWrappedTSSegmentOffset,
  parseImageSequenceHLSManifest,
  unwrapPNGWrappedTSSegment,
} from "../src/components/live/screening";

describe("screening image sequence playlist", () => {
  it("parses image-only HLS media playlists", () => {
    const frames = parseImageSequenceHLSManifest(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXTINF:10.5,",
        "first.png",
        "#EXTINF:2,",
        "https://cdn.example.com/second.jpg?token=1",
        "#EXT-X-ENDLIST",
      ].join("\n"),
      "https://cdn.example.com/path/index.m3u8",
    );

    expect(frames).toEqual([
      {
        duration: 10.5,
        startsAt: 0,
        url: "https://cdn.example.com/path/first.png",
      },
      {
        duration: 2,
        startsAt: 10.5,
        url: "https://cdn.example.com/second.jpg?token=1",
      },
    ]);
  });

  it("does not treat standard video HLS segments as image sequences", () => {
    const frames = parseImageSequenceHLSManifest(
      ["#EXTM3U", "#EXTINF:8,", "segment-001.ts", "#EXTINF:8,", "segment-002.m4s", "#EXT-X-ENDLIST"].join("\n"),
      "https://cdn.example.com/video/index.m3u8",
    );

    expect(frames).toEqual([]);
  });

  it("detects PNG-wrapped MPEG-TS segments", () => {
    const wrapped = makePNGWrappedTSSegment(70, 5);

    expect(findPNGWrappedTSSegmentOffset(wrapped)).toBe(70);
    expect(new Uint8Array(unwrapPNGWrappedTSSegment(wrapped))[0]).toBe(0x47);
  });

  it("does not detect a partial PNG probe as MPEG-TS", () => {
    const partial = makePNGWrappedTSSegment(70, 1).slice(0, 80);

    expect(findPNGWrappedTSSegmentOffset(partial)).toBe(-1);
  });
});

function makePNGWrappedTSSegment(offset: number, packetCount: number) {
  const bytes = new Uint8Array(offset + packetCount * 188);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let packet = 0; packet < packetCount; packet += 1) {
    const index = offset + packet * 188;
    bytes[index] = 0x47;
    bytes[index + 1] = packet;
  }
  return bytes.buffer.slice(0);
}

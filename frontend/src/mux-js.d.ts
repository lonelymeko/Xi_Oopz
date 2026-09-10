/**
 * mux.js 只发布 JS（6.3.0 无 .d.ts），这里只声明我们实际用到的最小接口：
 * 把 MPEG-TS 转封装成 fragmented MP4 的 Transmuxer。
 * 参考 mux.js/lib/mp4/index.js 的导出与 lib/mp4/transmuxer.js 的 data 事件载荷。
 */
declare module "mux.js/lib/mp4" {
  /** `data` 事件载荷（字段取自 mux.js 的 CoalesceStream.flush） */
  export type MuxDataSegment = {
    /** 单轨时是该轨类型；音频+视频被 remux 合并时为 "combined" */
    type?: "video" | "audio" | "combined";
    /** ftyp + moov，只在需要时使用第一个事件里的这一份 */
    initSegment?: Uint8Array;
    /** moof + mdat 媒体段 */
    data?: Uint8Array;
    /** 轨道属性（宽高、采样率等） */
    info?: Record<string, unknown>;
  };

  export type MuxTransmuxerOptions = {
    /** 默认 true：把音视频合并进同一个 fMP4 段 */
    remux?: boolean;
    baseMediaDecodeTime?: number;
  };

  export class Transmuxer {
    constructor(options?: MuxTransmuxerOptions);
    on(event: "data", handler: (segment: MuxDataSegment) => void): void;
    on(event: "done", handler: () => void): void;
    off(event: string, handler: (...args: never[]) => void): void;
    push(bytes: Uint8Array): void;
    flush(): void;
  }
}

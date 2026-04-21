import type { Message, PresenceMember, ScreeningPlaylistItem, ScreeningSnapshot, ScreeningState } from "../types";

/**
 * Socket ready 事件负载。
 */
export type SocketReadyPayload = {
  domainId: number;
  userId: number;
};

/**
 * 频道在线快照事件负载。
 */
export type PresenceSnapshotPayload = {
  channelId: number;
  members: PresenceMember[];
};

/**
 * 成员加入事件负载。
 */
export type MemberJoinedPayload = PresenceMember;

/**
 * 成员离开事件负载。
 */
export type MemberLeftPayload = {
  userId: number;
  channelId: number;
};

/**
 * 语音状态事件负载。
 */
export type VoiceStatePayload = {
  userId: number;
  channelId: number;
  micEnabled: boolean;
};

/**
 * 屏幕状态事件负载。
 */
export type ScreenStatePayload = {
  userId: number;
  channelId: number;
  screenSharing: boolean;
};

/**
 * 放映控制者变更事件负载。
 */
export type ScreeningControllerChangedPayload = {
  controllerUserId: number;
  controllerName: string;
};

/**
 * 放映列表更新事件负载。
 */
export type ScreeningPlaylistUpdatedPayload = {
  playlist: ScreeningPlaylistItem[];
};

/**
 * 实时错误事件负载。
 */
export type SocketErrorPayload = {
  message?: string;
};

/**
 * 实时事件映射表。
 */
export type SocketEventMap = {
  ready: SocketReadyPayload;
  "presence.snapshot": PresenceSnapshotPayload;
  "member.joined": MemberJoinedPayload;
  "member.left": MemberLeftPayload;
  "chat.message": Message;
  "voice.state": VoiceStatePayload;
  "screen.state": ScreenStatePayload;
  "screening.snapshot": ScreeningSnapshot;
  "screening.playlist.updated": ScreeningPlaylistUpdatedPayload;
  "screening.controller.changed": ScreeningControllerChangedPayload;
  "screening.play": ScreeningState;
  "screening.pause": ScreeningState;
  "screening.seek": ScreeningState;
  "screening.tick": ScreeningState;
  "screening.rate": ScreeningState;
  "screen.sync_request": Record<string, unknown>;
  "media.sync_request": Record<string, unknown>;
  "rtc.offer": Record<string, unknown>;
  "rtc.answer": Record<string, unknown>;
  "rtc.ice_candidate": Record<string, unknown>;
  error: SocketErrorPayload;
};

/**
 * 实时事件名联合类型。
 */
export type SocketEvent = keyof SocketEventMap;

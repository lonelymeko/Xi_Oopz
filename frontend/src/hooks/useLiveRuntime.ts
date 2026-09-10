import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { RTCController } from "../rtc";
import { soundManager } from "../sound";
import { SocketClient } from "../socket";
import type { Message, PresenceMember, ScreeningSnapshot, ScreeningState } from "../types";
import type { SocketEventMap } from "../types/socket";

/**
 * 实时运行时 Hook 参数。
 */
type UseLiveRuntimeOptions = {
  sessionToken: string | null;
  userId: number | null;
  domainId: number | null;
  selectedAudioInputId: string;
  noiseSuppressionEnabled: boolean;
  socketRef: MutableRefObject<SocketClient | null>;
  rtcRef: MutableRefObject<RTCController | null>;
  activeChannelIdRef: MutableRefObject<number | null>;
  activeChannelRef: MutableRefObject<import("../types").Channel | null>;
  currentVoiceChannelIdRef: MutableRefObject<number | null>;
  activeScreeningChannelIdRef: MutableRefObject<number | null>;
  voiceJoinInFlightRef: MutableRefObject<number | null>;
  voiceMembersRef: MutableRefObject<Map<number, PresenceMember>>;
  currentUserRef: MutableRefObject<import("../types").User | null>;
  membersRef: MutableRefObject<import("../types").DomainMember[]>;
  iceServersRef: MutableRefObject<RTCIceServer[]>;
  setWsConnected: Dispatch<SetStateAction<boolean>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setCurrentVoiceChannelId: (value: number | null) => void;
  setVoiceMembers: Dispatch<SetStateAction<Map<number, PresenceMember>>>;
  setOnlineCounts: Dispatch<SetStateAction<Record<string, number>>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setMicEnabled: (value: boolean) => void;
  setScreenSharing: (value: boolean) => void;
  setScreeningSnapshot: Dispatch<SetStateAction<ScreeningSnapshot | null>>;
  setScreeningChannelMembers: Dispatch<SetStateAction<Record<string, import("../types").User[]>>>;
  setRemoteMedia: (value: Map<number, import("../types").RemoteMedia>) => void;
  setPeerDiagnostics: (value: Map<number, import("../types").PeerConnectionDiagnostics>) => void;
  setLocalAudioStream: (value: MediaStream | null) => void;
  setLocalScreenStream: (value: MediaStream | null) => void;
  setAudioOnlySharing: (value: boolean) => void;
  pushNotice: (kind: "error" | "info", title: string, message: string) => void;
  voiceLog: (label: string, extra?: Record<string, unknown>) => void;
  screeningLog: (label: string, extra?: Record<string, unknown>) => void;
  refreshPresence: () => Promise<void>;
};

/**
 * 实时运行时 Hook：统一管理 WS/RTC 生命周期和事件分发。
 */
export function useLiveRuntime(options: UseLiveRuntimeOptions) {
  const {
    sessionToken,
    userId,
    domainId,
    selectedAudioInputId,
    noiseSuppressionEnabled,
    socketRef,
    rtcRef,
    activeChannelIdRef,
    activeChannelRef,
    currentVoiceChannelIdRef,
    activeScreeningChannelIdRef,
    voiceJoinInFlightRef,
    voiceMembersRef,
    currentUserRef,
    membersRef,
    iceServersRef,
    setWsConnected,
    setStatus,
    setCurrentVoiceChannelId,
    setVoiceMembers,
    setOnlineCounts,
    setMessages,
    setMicEnabled,
    setScreenSharing,
    setScreeningSnapshot,
    setScreeningChannelMembers,
    setRemoteMedia,
    setPeerDiagnostics,
    setLocalAudioStream,
    setLocalScreenStream,
    setAudioOnlySharing,
    pushNotice,
    voiceLog,
    screeningLog,
    refreshPresence,
  } = options;
  const socketEventHandlerRef = useRef<(type: string, payload: unknown) => void>(() => {});
  const socketStatusHandlerRef = useRef<(connected: boolean) => void>(() => {});

  /**
   * 分发并处理服务端实时事件（实现体）。
   */
  const handleSocketEventImpl = useCallback(
    (type: string, payload: unknown) => {
      switch (type) {
        case "ready": {
          const readyPayload = payload as SocketEventMap["ready"];
          voiceLog("socket:ready", { domainId: readyPayload.domainId, userId: readyPayload.userId });
          setStatus("实时连接就绪");
          if (currentVoiceChannelIdRef.current && voiceJoinInFlightRef.current !== currentVoiceChannelIdRef.current) {
            socketRef.current?.send("channel.join", { channelId: currentVoiceChannelIdRef.current });
          }
          // 只有真正进入放映室（已连麦加入该频道）时才在重连后自动补齐 screening.join；
          // 单击选中放映室不等于进入，不能因为重连把人拉进房间。
          if (
            activeChannelIdRef.current &&
            activeChannelRef.current?.type === "screening" &&
            currentVoiceChannelIdRef.current === activeChannelIdRef.current
          ) {
            screeningLog("screening:join:send", { channelId: activeChannelIdRef.current, reason: "socket-ready" });
            socketRef.current?.send("screening.join", { channelId: activeChannelIdRef.current });
          }
          break;
        }
        case "presence.snapshot": {
          const snapshotPayload = payload as SocketEventMap["presence.snapshot"];
          const nextMembers = new Map<number, PresenceMember>();
          snapshotPayload.members.forEach((member) => {
            nextMembers.set(member.user.id, member);
          });
          setCurrentVoiceChannelId(snapshotPayload.channelId);
          setVoiceMembers(nextMembers);
          setOnlineCounts((prev) => ({ ...prev, [String(snapshotPayload.channelId)]: nextMembers.size }));
          void rtcRef.current?.handlePresenceSnapshot(snapshotPayload.members);
          void refreshPresence();
          break;
        }
        case "member.joined": {
          const joinedPayload = payload as SocketEventMap["member.joined"];
          if (joinedPayload.user?.id) {
            void soundManager.play("join");
          }
          setVoiceMembers((prev) => {
            const next = new Map(prev);
            next.set(joinedPayload.user.id, joinedPayload as PresenceMember);
            setOnlineCounts((counts) => ({ ...counts, [String(joinedPayload.channelId)]: next.size }));
            return next;
          });
          void rtcRef.current?.handleMemberJoined(joinedPayload as PresenceMember);
          void refreshPresence();
          break;
        }
        case "member.left": {
          const leftPayload = payload as SocketEventMap["member.left"];
          if (leftPayload.userId) {
            void soundManager.play("leave");
          }
          setVoiceMembers((prev) => {
            const next = new Map(prev);
            next.delete(leftPayload.userId);
            setOnlineCounts((counts) => ({ ...counts, [String(leftPayload.channelId)]: next.size }));
            return next;
          });
          rtcRef.current?.handleMemberLeft(leftPayload.userId);
          void refreshPresence();
          break;
        }
        case "chat.message": {
          const chatPayload = payload as SocketEventMap["chat.message"];
          if (chatPayload.messageType === "chat" && chatPayload.channelId === activeChannelIdRef.current) {
            void soundManager.play("chat");
          }
          if (chatPayload.channelId === activeChannelIdRef.current) {
            setMessages((prev) => [...prev, chatPayload]);
          }
          break;
        }
        case "voice.state": {
          const voiceStatePayload = payload as SocketEventMap["voice.state"];
          if (voiceStatePayload.userId === currentUserRef.current?.id) {
            setMicEnabled(Boolean(voiceStatePayload.micEnabled));
          }
          setVoiceMembers((prev) => {
            const next = new Map(prev);
            const current = next.get(voiceStatePayload.userId);
            if (current) {
              next.set(voiceStatePayload.userId, { ...current, micEnabled: voiceStatePayload.micEnabled });
            }
            return next;
          });
          if (voiceStatePayload.userId) {
            rtcRef.current?.handleVoiceState(voiceStatePayload.userId, Boolean(voiceStatePayload.micEnabled));
          }
          break;
        }
        case "screen.state": {
          const screenStatePayload = payload as SocketEventMap["screen.state"];
          if (screenStatePayload.userId === currentUserRef.current?.id) {
            setScreenSharing(Boolean(screenStatePayload.screenSharing));
          }
          setVoiceMembers((prev) => {
            const next = new Map(prev);
            const current = next.get(screenStatePayload.userId);
            if (current) {
              next.set(screenStatePayload.userId, { ...current, screenSharing: screenStatePayload.screenSharing });
            }
            return next;
          });
          if (screenStatePayload.userId) {
            rtcRef.current?.handleScreenState(screenStatePayload.userId, Boolean(screenStatePayload.screenSharing));
          }
          break;
        }
        case "screening.snapshot": {
          const screeningSnapshotPayload = payload as SocketEventMap["screening.snapshot"];
          screeningLog("screening:snapshot:received", {
            channelId: screeningSnapshotPayload.state.channelId,
            itemId: screeningSnapshotPayload.state.currentItemId,
            currentUrl: screeningSnapshotPayload.state.currentUrl,
          });
          setScreeningSnapshot(screeningSnapshotPayload);
          setScreeningChannelMembers((prev) => ({
            ...prev,
            [String(screeningSnapshotPayload.state.channelId)]: (screeningSnapshotPayload.viewers || []).map((viewer) => viewer.user),
          }));
          void refreshPresence();
          break;
        }
        case "screening.playlist.updated": {
          const playlistPayload = payload as SocketEventMap["screening.playlist.updated"];
          setScreeningSnapshot((prev) => (prev ? { ...prev, playlist: playlistPayload.playlist || [] } : prev));
          break;
        }
        case "screening.play":
        case "screening.pause":
        case "screening.seek":
        case "screening.tick":
        case "screening.rate": {
          const screeningStatePayload = payload as ScreeningState;
          setScreeningSnapshot((prev) => (prev ? { ...prev, state: screeningStatePayload } : prev));
          break;
        }
        case "screen.sync_request":
        case "media.sync_request":
        case "rtc.offer":
        case "rtc.answer":
        case "rtc.ice_candidate":
          void rtcRef.current?.handleSignal(
            type as Parameters<RTCController["handleSignal"]>[0],
            payload as Parameters<RTCController["handleSignal"]>[1],
          );
          break;
        case "error": {
          const errorPayload = payload as SocketEventMap["error"];
          setStatus(String(errorPayload.message || "实时事件出错"));
          pushNotice("error", "实时事件出错", String(errorPayload.message || "实时事件出错"));
          break;
        }
        default:
          break;
      }
    },
    [
      activeChannelIdRef,
      activeChannelRef,
      currentUserRef,
      currentVoiceChannelIdRef,
      pushNotice,
      refreshPresence,
      rtcRef,
      screeningLog,
      setCurrentVoiceChannelId,
      setMessages,
      setMicEnabled,
      setOnlineCounts,
      setScreenSharing,
      setScreeningChannelMembers,
      setScreeningSnapshot,
      setStatus,
      setVoiceMembers,
      socketRef,
      voiceJoinInFlightRef,
      voiceLog,
    ],
  );

  useEffect(() => {
    socketEventHandlerRef.current = handleSocketEventImpl;
  }, [handleSocketEventImpl]);

  /**
   * 稳定事件壳：避免事件处理实现变化触发 WS 生命周期重建。
   */
  const handleSocketEvent = useCallback((type: string, payload: unknown) => {
    socketEventHandlerRef.current(type, payload);
  }, []);

  useEffect(() => {
    socketStatusHandlerRef.current = (connected: boolean) => {
      voiceLog("socket:status", { connected, domainId });
      setWsConnected((prev) => (prev === connected ? prev : connected));
      setStatus((prev) => {
        const next = connected ? "WS 已连接" : "WS 重连中";
        return prev === next ? prev : next;
      });
    };
  }, [domainId, setStatus, setWsConnected, voiceLog]);

  /**
   * 稳定状态壳：仅传递状态变化，不让回调引用抖动影响连接生命周期。
   */
  const handleSocketStatus = useCallback((connected: boolean) => {
    socketStatusHandlerRef.current(connected);
  }, []);

  useEffect(() => {
    if (!sessionToken || !userId || !domainId) return;

    const socket = new SocketClient(sessionToken, domainId, handleSocketEvent, handleSocketStatus);

    socketRef.current = socket;
    socket.connect();

    rtcRef.current = new RTCController(
      socket,
      () => currentVoiceChannelIdRef.current,
      () => currentUserRef.current,
      () => membersRef.current,
      () => voiceMembersRef.current,
      () => iceServersRef.current,
      (media) => setRemoteMedia(new Map(media)),
      (diagnostics) => setPeerDiagnostics(new Map(diagnostics)),
      (stream) => setLocalAudioStream(stream),
      (stream) => setLocalScreenStream(stream),
      (sharing) => setAudioOnlySharing(sharing),
      (kind, title, message) => {
        setStatus(message);
        pushNotice(kind, title, message);
      },
    );

    return () => {
      const voiceChannelId = currentVoiceChannelIdRef.current;
      const screeningChannelId = activeScreeningChannelIdRef.current;
      if (voiceChannelId) {
        void rtcRef.current?.leaveVoice();
      }
      socket.close({
        type: "session.leave",
        payload: {
          channelId: voiceChannelId,
          screeningChannelId,
        },
      });
      socketRef.current = null;
      rtcRef.current = null;
      setPeerDiagnostics(new Map());
    };
  }, [
    domainId,
    handleSocketEvent,
    handleSocketStatus,
    sessionToken,
    userId,
    currentVoiceChannelIdRef,
    activeScreeningChannelIdRef,
    currentUserRef,
    membersRef,
    voiceMembersRef,
    iceServersRef,
    setRemoteMedia,
    setPeerDiagnostics,
    setLocalAudioStream,
    setLocalScreenStream,
    setAudioOnlySharing,
    setStatus,
    pushNotice,
    rtcRef,
    socketRef,
  ]);

  useEffect(() => {
    if (!rtcRef.current) return;
    void rtcRef.current.setAudioInputDevice(selectedAudioInputId);
    void rtcRef.current.setNoiseSuppression(noiseSuppressionEnabled);
  }, [noiseSuppressionEnabled, rtcRef, selectedAudioInputId]);
}

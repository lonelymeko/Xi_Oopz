import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { Channel, DomainMember, Message, PresenceMember, User } from "../types";

/**
 * 页面 UI 副作用 Hook 参数。
 */
type UseLiveUiEffectsOptions = {
  sessionToken: string | null;
  user: User | null;
  activeChannel: Channel | null;
  currentVoiceChannelId: number | null;
  voiceMembers: Map<number, PresenceMember>;
  bootstrapMembers: DomainMember[];
  bootstrapStunServers: RTCIceServer[];
  verificationCooldown: number;
  deferredMessages: Message[];
  showProfileMenu: boolean;
  showEmojiPicker: boolean;
  maximizedScreenKey: string | null;
  screenPreviewKeys: string[];
  clearAllNoticeTimers: () => void;
  setVerificationCooldown: Dispatch<SetStateAction<number>>;
  setAudioPrewarming: (value: boolean) => void;
  setShowProfileMenu: (value: boolean) => void;
  setShowEmojiPicker: (value: boolean) => void;
  setMaximizedScreenKey: (value: string | null) => void;
  activeChannelIdRef: MutableRefObject<number | null>;
  activeChannelRef: MutableRefObject<Channel | null>;
  currentVoiceChannelIdRef: MutableRefObject<number | null>;
  voiceMembersRef: MutableRefObject<Map<number, PresenceMember>>;
  membersRef: MutableRefObject<DomainMember[]>;
  currentUserRef: MutableRefObject<User | null>;
  iceServersRef: MutableRefObject<RTCIceServer[]>;
  startupAudioStreamRef: MutableRefObject<MediaStream | null>;
  messageListRef: MutableRefObject<HTMLDivElement | null>;
  profileMenuRef: MutableRefObject<HTMLDivElement | null>;
  emojiPickerRef: MutableRefObject<HTMLDivElement | null>;
  audioSettingsCloseTimerRef: MutableRefObject<number | null>;
};

/**
 * 页面 UI 副作用 Hook：统一管理滚动、弹层关闭与清理逻辑。
 */
export function useLiveUiEffects(options: UseLiveUiEffectsOptions) {
  const {
    sessionToken,
    user,
    activeChannel,
    currentVoiceChannelId,
    voiceMembers,
    bootstrapMembers,
    bootstrapStunServers,
    verificationCooldown,
    deferredMessages,
    showProfileMenu,
    showEmojiPicker,
    maximizedScreenKey,
    screenPreviewKeys,
    clearAllNoticeTimers,
    setVerificationCooldown,
    setAudioPrewarming,
    setShowProfileMenu,
    setShowEmojiPicker,
    setMaximizedScreenKey,
    activeChannelIdRef,
    activeChannelRef,
    currentVoiceChannelIdRef,
    voiceMembersRef,
    membersRef,
    currentUserRef,
    iceServersRef,
    startupAudioStreamRef,
    messageListRef,
    profileMenuRef,
    emojiPickerRef,
    audioSettingsCloseTimerRef,
  } = options;

  useEffect(() => {
    if (sessionToken) return;
    setAudioPrewarming(false);
  }, [sessionToken, setAudioPrewarming]);

  useEffect(() => {
    activeChannelIdRef.current = activeChannel?.id || null;
    activeChannelRef.current = activeChannel;
  }, [activeChannel, activeChannelIdRef, activeChannelRef]);

  useEffect(() => {
    currentVoiceChannelIdRef.current = currentVoiceChannelId;
  }, [currentVoiceChannelId, currentVoiceChannelIdRef]);

  useEffect(() => {
    voiceMembersRef.current = voiceMembers;
  }, [voiceMembers, voiceMembersRef]);

  useEffect(() => {
    currentUserRef.current = user;
    membersRef.current = bootstrapMembers;
    iceServersRef.current = bootstrapStunServers;
  }, [bootstrapMembers, bootstrapStunServers, currentUserRef, iceServersRef, membersRef, user]);

  useEffect(() => {
    if (verificationCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setVerificationCooldown((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [setVerificationCooldown, verificationCooldown]);

  useEffect(() => {
    return () => {
      clearAllNoticeTimers();
      startupAudioStreamRef.current?.getTracks().forEach((track) => track.stop());
      startupAudioStreamRef.current = null;
    };
  }, [clearAllNoticeTimers, startupAudioStreamRef]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const container = messageListRef.current;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeChannel?.id, deferredMessages, messageListRef]);

  useEffect(() => {
    if (!showProfileMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!profileMenuRef.current) return;
      if (profileMenuRef.current.contains(event.target as Node)) return;
      setShowProfileMenu(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [profileMenuRef, setShowProfileMenu, showProfileMenu]);

  useEffect(() => {
    if (!showEmojiPicker) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!emojiPickerRef.current) return;
      if (emojiPickerRef.current.contains(event.target as Node)) return;
      setShowEmojiPicker(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [emojiPickerRef, setShowEmojiPicker, showEmojiPicker]);

  useEffect(() => {
    const timer = audioSettingsCloseTimerRef.current;
    return () => {
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [audioSettingsCloseTimerRef]);

  useEffect(() => {
    if (!maximizedScreenKey) return;
    if (!screenPreviewKeys.includes(maximizedScreenKey)) {
      setMaximizedScreenKey(null);
    }
  }, [maximizedScreenKey, screenPreviewKeys, setMaximizedScreenKey]);
}

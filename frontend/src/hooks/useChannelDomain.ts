import { startTransition, type MutableRefObject } from "react";

import { liveFacade } from "../services/liveFacade";
import type { Channel, Message } from "../types";

/**
 * 频道领域 Hook 参数。
 */
type UseChannelDomainOptions = {
  session: import("../types/live").Session | null;
  bootstrap: import("../types").BootstrapResponse | null;
  activeChannel: Channel | null;
  firstTextChannel: Channel | null;
  currentVoiceChannelId: number | null;
  screenSharing: boolean;
  setActiveChannel: (value: Channel | null) => void;
  setMessages: (value: Message[] | ((current: Message[]) => Message[])) => void;
  setStatus: (value: string) => void;
  setMessageDraft: (value: string | ((current: string) => string)) => void;
  setShowEmojiPicker: (value: boolean | ((current: boolean) => boolean)) => void;
  setVoiceTargetChannelId: (value: number | null) => void;
  setScreenSharing: (value: boolean) => void;
  setScreeningSnapshot: (value: import("../types").ScreeningSnapshot | null) => void;
  setScreeningJoinEpoch: (value: number | ((current: number) => number)) => void;
  screeningJoinDedupRef: MutableRefObject<{ channelId: number | null; until: number }>;
  activeChannelIdRef: MutableRefObject<number | null>;
  messageInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  rtcRef: MutableRefObject<{ stopScreenShare: (silent: boolean) => Promise<void> } | null>;
  socketRef: MutableRefObject<{ send: (type: string, payload: unknown) => void } | null>;
  showError: (error: unknown, title: string, fallback: string) => string;
  screeningLog: (label: string, extra?: Record<string, unknown>) => void;
  leaveVoice: () => Promise<void>;
  joinVoice: (channelId?: number) => Promise<void>;
  leaveScreeningChannel: (nextActive: Channel | null) => Promise<void>;
};

/**
 * 频道领域 Hook：集中管理频道切换、消息发送与输入增强。
 */
export function useChannelDomain(options: UseChannelDomainOptions) {
  const {
    session,
    bootstrap,
    activeChannel,
    firstTextChannel,
    currentVoiceChannelId,
    screenSharing,
    setActiveChannel,
    setMessages,
    setStatus,
    setMessageDraft,
    setShowEmojiPicker,
    setVoiceTargetChannelId,
    setScreenSharing,
    setScreeningSnapshot,
    setScreeningJoinEpoch,
    screeningJoinDedupRef,
    activeChannelIdRef,
    messageInputRef,
    rtcRef,
    socketRef,
    showError,
    screeningLog,
    leaveVoice,
    joinVoice,
    leaveScreeningChannel,
  } = options;

  /**
   * 选择频道并根据频道类型执行切换副作用。
   */
  async function selectChannel(channel: Channel) {
    if (!bootstrap || !session) return;

    if (activeChannel?.type === "screening" && activeChannel.id !== channel.id) {
      await leaveScreeningChannel(channel.type === "voice" ? firstTextChannel : null);
    }

    if (channel.type === "voice") {
      setVoiceTargetChannelId(channel.id);
      if (activeChannel?.type === "screening" && firstTextChannel) {
        setActiveChannel(firstTextChannel);
      }
      if (currentVoiceChannelId && currentVoiceChannelId !== channel.id) {
        await leaveVoice();
      }
      setStatus(`已选中语音频道 ${channel.name}，双击进入`);
      return;
    }

    try {
      if (channel.type === "screening" && currentVoiceChannelId && currentVoiceChannelId !== channel.id) {
        await leaveVoice();
      }
      const nextMessages = await liveFacade.fetchChannelMessages(bootstrap.domain.id, channel.id, session.token);
      startTransition(() => {
        setActiveChannel(channel);
        setMessages(nextMessages);
      });
      if (channel.type === "screening") {
        const now = Date.now();
        if (screeningJoinDedupRef.current.channelId === channel.id && screeningJoinDedupRef.current.until > now) {
          return;
        }
        screeningJoinDedupRef.current = { channelId: channel.id, until: now + 900 };
        if (screenSharing) {
          await rtcRef.current?.stopScreenShare(false);
          setScreenSharing(false);
        }
        screeningLog("screening:join:send", { channelId: channel.id, reason: "select-channel" });
        setScreeningJoinEpoch((value) => value + 1);
        socketRef.current?.send("screening.join", { channelId: channel.id });
        if (currentVoiceChannelId !== channel.id) {
          await joinVoice(channel.id);
        } else {
          setVoiceTargetChannelId(channel.id);
        }
        setStatus(`已进入放映室 ${channel.name}`);
      } else {
        setScreeningSnapshot(null);
      }
    } catch (error) {
      console.error(error);
      setStatus("切换频道失败");
      showError(error, "切换频道失败", "请稍后重试");
    }
  }

  /**
   * 发送消息并在短延迟后刷新消息列表。
   */
  async function sendMessage(body: string) {
    if (!activeChannel || !bootstrap || !session) return;
    const nextBody = body.trim();
    if (!nextBody) return;

    socketRef.current?.send("chat.send", {
      channelId: activeChannel.id,
      body: nextBody,
    });
    setMessageDraft("");
    setShowEmojiPicker(false);

    window.setTimeout(() => {
      if (!bootstrap || !session || activeChannelIdRef.current !== activeChannel.id) return;
      void liveFacade
        .fetchChannelMessages(bootstrap.domain.id, activeChannel.id, session.token)
        .then((nextMessages) => {
          if (activeChannelIdRef.current === activeChannel.id) {
            setMessages(nextMessages);
          }
        })
        .catch((error) => {
          console.error(error);
        });
    }, 240);
  }

  /**
   * 在输入框末尾追加表情并保持焦点。
   */
  function appendEmoji(emoji: string) {
    setMessageDraft((value) => `${value}${emoji}`);
    window.requestAnimationFrame(() => {
      messageInputRef.current?.focus();
    });
  }

  /**
   * 进入语音频道（双击行为）。
   */
  async function enterVoiceChannel(channel: Channel) {
    if (channel.type !== "voice") return;
    if (activeChannel?.type === "screening") {
      await leaveScreeningChannel(firstTextChannel);
    }
    setVoiceTargetChannelId(channel.id);
    if (currentVoiceChannelId === channel.id) {
      setStatus(`已在 ${channel.name} 中`);
      return;
    }
    await joinVoice(channel.id);
  }

  return {
    selectChannel,
    sendMessage,
    appendEmoji,
    enterVoiceChannel,
  };
}

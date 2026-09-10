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

    let leftScreeningRoom = false;
    if (activeChannel?.type === "screening" && activeChannel.id !== channel.id) {
      await leaveScreeningChannel(channel.type === "voice" ? firstTextChannel : null);
      leftScreeningRoom = true;
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
      const nextMessages = await liveFacade.fetchChannelMessages(bootstrap.domain.id, channel.id, session.token);
      startTransition(() => {
        setActiveChannel(channel);
        setMessages(nextMessages);
      });

      if (channel.type !== "screening") {
        setScreeningSnapshot(null);
        return;
      }

      // 选中不等于进入：放映室与语音频道保持一致，单击只选中，双击（enterVoiceChannel）才真正进入。
      // 已经在该放映室里时保持现状，避免把自己正在看的快照清掉。
      if (currentVoiceChannelId === channel.id) {
        setStatus(`已在放映室 ${channel.name} 中`);
        return;
      }
      if (!leftScreeningRoom && currentVoiceChannelId) {
        // 从语音频道切到放映室：先退出语音，和「选中语音频道」的行为一致。
        await leaveVoice();
      }
      setScreeningSnapshot(null);
      setStatus(`已选中放映室 ${channel.name}，双击进入`);
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
   * 进入放映室（双击行为）：发送 screening.join 并连麦，与语音频道进入方式保持一致。
   */
  async function enterScreeningChannel(channel: Channel) {
    if (channel.type !== "screening") return;
    if (currentVoiceChannelId === channel.id) {
      setStatus(`已在放映室 ${channel.name} 中`);
      return;
    }
    // 单击已经切过 activeChannel 时这里是空操作；直接双击其它放映室时兜底先退出旧房间。
    if (activeChannel?.type === "screening" && activeChannel.id !== channel.id) {
      await leaveScreeningChannel(firstTextChannel);
    }
    const now = Date.now();
    if (screeningJoinDedupRef.current.channelId === channel.id && screeningJoinDedupRef.current.until > now) {
      return;
    }
    screeningJoinDedupRef.current = { channelId: channel.id, until: now + 900 };
    try {
      if (screenSharing) {
        await rtcRef.current?.stopScreenShare(false);
        setScreenSharing(false);
      }
      screeningLog("screening:join:send", { channelId: channel.id, reason: "enter-channel" });
      setScreeningJoinEpoch((value) => value + 1);
      socketRef.current?.send("screening.join", { channelId: channel.id });
      await joinVoice(channel.id);
      setStatus(`已进入放映室 ${channel.name}`);
    } catch (error) {
      console.error(error);
      setStatus("进入放映室失败");
      showError(error, "进入放映室失败", "请稍后重试");
    }
  }

  /**
   * 进入频道（双击行为）：语音频道走连麦，放映室走 screening.join + 连麦。
   */
  async function enterVoiceChannel(channel: Channel) {
    if (channel.type === "screening") {
      await enterScreeningChannel(channel);
      return;
    }
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

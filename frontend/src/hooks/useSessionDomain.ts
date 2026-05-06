import { useCallback, useRef, useState, type MutableRefObject } from "react";

import { liveFacade } from "../services/liveFacade";
import { clearSession, saveSession } from "../services/session";
import type {
  BootstrapResponse,
  Channel,
  DomainPresenceResponse,
  Message,
  OnlineUserPresence,
  PeerConnectionDiagnostics,
  PresenceMember,
  RemoteMedia,
  User,
} from "../types";
import type { AuthMode, Session } from "../types/live";

type UseSessionDomainOptions = {
  session: Session | null;
  bootstrap: BootstrapResponse | null;
  setSession: (value: Session | null) => void;
  setUser: (value: User | null) => void;
  setBootstrap: (value: BootstrapResponse | null) => void;
  setActiveChannel: (value: Channel | null) => void;
  setMessages: (value: Message[]) => void;
  setVoiceTargetChannelId: (value: number | null) => void;
  setOnlineCounts: (value: Record<string, number>) => void;
  setScreeningSnapshot: (value: null) => void;
  setStatus: (value: string) => void;
  setCurrentVoiceChannelId: (value: number | null) => void;
  setVoiceMembers: (value: Map<number, PresenceMember>) => void;
  setRemoteMedia: (value: Map<number, RemoteMedia>) => void;
  setPeerDiagnostics: (value: Map<number, PeerConnectionDiagnostics>) => void;
  setOnlineUsers: (value: Map<number, OnlineUserPresence>) => void;
  setVoiceChannelMembers: (value: Record<string, PresenceMember[]>) => void;
  setScreeningChannelMembers: (value: Record<string, User[]>) => void;
  setDeafened: (value: boolean) => void;
  setMicEnabled: (value: boolean) => void;
  setScreenSharing: (value: boolean) => void;
  setLocalAudioStream: (value: MediaStream | null) => void;
  setLocalScreenStream: (value: MediaStream | null) => void;
  setMaximizedScreenKey: (value: string | null) => void;
  setMessageDraft: (value: string) => void;
  setShowEmojiPicker: (value: boolean) => void;
  setShowAudioSettings: (value: boolean) => void;
  setShowProfileMenu: (value: boolean) => void;
  socketRef: MutableRefObject<{ close: () => void } | null>;
  rtcRef: MutableRefObject<{ leaveVoice: () => Promise<void> } | null>;
  pushNotice: (kind: "error" | "info", title: string, message: string) => void;
  showError: (error: unknown, title: string, fallback: string) => string;
  showInfo: (title: string, message: string) => void;
  resolveErrorMessage: (error: unknown, fallback: string) => string;
};

/**
 * 会话领域 Hook：集中管理鉴权、域切换与频道创建动作。
 */
export function useSessionDomain(options: UseSessionDomainOptions) {
  const {
    session,
    bootstrap,
    setSession,
    setUser,
    setBootstrap,
    setActiveChannel,
    setMessages,
    setVoiceTargetChannelId,
    setOnlineCounts,
    setScreeningSnapshot,
    setStatus,
    setCurrentVoiceChannelId,
    setVoiceMembers,
    setRemoteMedia,
    setPeerDiagnostics,
    setOnlineUsers,
    setVoiceChannelMembers,
    setScreeningChannelMembers,
    setDeafened,
    setMicEnabled,
    setScreenSharing,
    setLocalAudioStream,
    setLocalScreenStream,
    setMaximizedScreenKey,
    setMessageDraft,
    setShowEmojiPicker,
    setShowAudioSettings,
    setShowProfileMenu,
    socketRef,
    rtcRef,
    pushNotice,
    showError,
    showInfo,
    resolveErrorMessage,
  } = options;

  const [authMode, setAuthMode] = useState<AuthMode>("register");
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [verificationCodeInput, setVerificationCodeInput] = useState("");
  const [submittingAuth, setSubmittingAuth] = useState(false);
  const [sendingVerificationCode, setSendingVerificationCode] = useState(false);
  const [verificationCooldown, setVerificationCooldown] = useState(0);
  const [creatingDomain, setCreatingDomain] = useState(false);
  const [domainNameInput, setDomainNameInput] = useState("");
  const [domainDescriptionInput, setDomainDescriptionInput] = useState("");
  const [channelComposerType, setChannelComposerType] = useState<"text" | "voice" | "screening" | null>(null);
  const [channelNameInput, setChannelNameInput] = useState("");
  const [channelTopicInput, setChannelTopicInput] = useState("");
  const [submittingDomain, setSubmittingDomain] = useState(false);
  const [submittingChannel, setSubmittingChannel] = useState(false);
  const hydratingRef = useRef(false);
  const bootstrapInFlightRef = useRef<Promise<void> | null>(null);
  const bootstrapRequestKeyRef = useRef("");
  const bootstrapRequestVersionRef = useRef(0);

  /**
   * 注销并回收本地会话状态。
   */
  const logout = useCallback(() => {
    socketRef.current?.close();
    clearSession();
    setSession(null);
    setUser(null);
    setBootstrap(null);
    setActiveChannel(null);
    setMessages([]);
    setVoiceMembers(new Map());
    setRemoteMedia(new Map());
    setPeerDiagnostics(new Map());
    setOnlineCounts({});
    setOnlineUsers(new Map());
    setVoiceChannelMembers({});
    setScreeningChannelMembers({});
    setCurrentVoiceChannelId(null);
    setDeafened(false);
    setMicEnabled(true);
    setScreenSharing(false);
    setLocalAudioStream(null);
    setLocalScreenStream(null);
    setMaximizedScreenKey(null);
    setMessageDraft("");
    setShowEmojiPicker(false);
    setShowAudioSettings(false);
    setShowProfileMenu(false);
    setVoiceTargetChannelId(null);
    setScreeningSnapshot(null);
    setStatus("等待初始化");
  }, [
    setActiveChannel,
    setBootstrap,
    setCurrentVoiceChannelId,
    setDeafened,
    setLocalAudioStream,
    setLocalScreenStream,
    setMaximizedScreenKey,
    setMessageDraft,
    setMessages,
    setMicEnabled,
    setOnlineCounts,
    setOnlineUsers,
    setPeerDiagnostics,
    setRemoteMedia,
    setScreenSharing,
    setScreeningChannelMembers,
    setScreeningSnapshot,
    setSession,
    setShowAudioSettings,
    setShowEmojiPicker,
    setShowProfileMenu,
    setStatus,
    setUser,
    setVoiceChannelMembers,
    setVoiceMembers,
    setVoiceTargetChannelId,
    socketRef,
  ]);

  /**
   * 刷新会话用户信息。
   */
  const hydrateSession = useCallback(async () => {
    if (!session) return;
    if (hydratingRef.current) return;
    hydratingRef.current = true;
    try {
      const currentUser = await liveFacade.fetchMe(session.token);
      setUser(currentUser);
    } catch (error) {
      console.error(error);
      logout();
      setStatus("登录状态已失效，请重新登录");
      showError(error, "登录状态失效", "登录状态已失效，请重新登录");
    } finally {
      hydratingRef.current = false;
    }
  }, [logout, session, setStatus, setUser, showError]);

  /**
   * 拉取域引导数据并完成页面初始化状态。
   */
  const bootstrapData = useCallback(
    async (channelId?: number, domainId?: number) => {
      if (!session) return;
      const requestKey = `${session.token}|${domainId ?? "default"}|${channelId ?? "default"}`;
      if (bootstrapInFlightRef.current && bootstrapRequestKeyRef.current === requestKey) {
        await bootstrapInFlightRef.current;
        return;
      }
      bootstrapRequestVersionRef.current += 1;
      const requestVersion = bootstrapRequestVersionRef.current;

      const runner = (async () => {
        try {
          const data = await liveFacade.fetchBootstrap(session.token, channelId, domainId);
          if (requestVersion !== bootstrapRequestVersionRef.current) {
            return;
          }
          const channels = (data.categories || []).flatMap((category) => category.channels);
          const firstTextChannel = channels.find((channel) => channel.type === "text") || null;
          const firstVoiceChannel = channels.find((channel) => channel.type === "voice") || null;
          const preferredActiveChannel = data.activeChannel || firstTextChannel || channels[0] || null;
          setBootstrap(data);
          setUser(data.user);
          setActiveChannel(preferredActiveChannel);
          setMessages(data.messages);
          setVoiceTargetChannelId(firstVoiceChannel?.id || null);
          setOnlineCounts(data.onlineCounts || {});
          if (preferredActiveChannel?.type !== "screening") {
            setScreeningSnapshot(null);
          }

          try {
            const presence: DomainPresenceResponse = await liveFacade.fetchDomainPresence(data.domain.id, session.token);
            const nextOnlineUsers = new Map<number, OnlineUserPresence>();
            for (const entry of presence.onlineUsers || []) {
              nextOnlineUsers.set(entry.user.id, entry);
            }
            setOnlineUsers(nextOnlineUsers);
            if (presence.onlineCounts) {
              setOnlineCounts({ ...data.onlineCounts, ...presence.onlineCounts });
            }
          } catch {
            // presence fetch failure is non-fatal
          }

          setStatus("页面已就绪");
        } catch (error) {
          if (requestVersion !== bootstrapRequestVersionRef.current) {
            return;
          }
          console.error(error);
          setStatus("初始化失败，请检查服务与数据库");
          showError(error, "初始化失败", "请检查服务与数据库");
        } finally {
          if (bootstrapRequestKeyRef.current === requestKey) {
            bootstrapInFlightRef.current = null;
            bootstrapRequestKeyRef.current = "";
          }
        }
      })();

      bootstrapRequestKeyRef.current = requestKey;
      bootstrapInFlightRef.current = runner;
      try {
        await runner;
      } finally {
        if (bootstrapRequestKeyRef.current === requestKey && bootstrapInFlightRef.current === runner) {
          bootstrapInFlightRef.current = null;
          bootstrapRequestKeyRef.current = "";
        }
      }
    },
    [
      session,
      setActiveChannel,
      setBootstrap,
      setMessages,
      setOnlineCounts,
      setScreeningSnapshot,
      setStatus,
      setUser,
      setVoiceTargetChannelId,
      showError,
    ],
  );

  /**
   * 提交登录/注册动作。
   */
  async function submitAuth() {
    if (!emailInput.trim() || !passwordInput.trim()) {
      const message = "请输入邮箱和密码";
      setStatus(message);
      pushNotice("error", "认证信息不完整", message);
      return;
    }
    if (authMode === "register" && !displayNameInput.trim()) {
      const message = "请输入昵称";
      setStatus(message);
      pushNotice("error", "注册信息不完整", message);
      return;
    }
    if (authMode === "register" && !verificationCodeInput.trim()) {
      const message = "请输入邮箱验证码";
      setStatus(message);
      pushNotice("error", "注册信息不完整", message);
      return;
    }

    setSubmittingAuth(true);
    try {
      const result =
        authMode === "register"
          ? await liveFacade.registerAccount({
              displayName: displayNameInput.trim(),
              email: emailInput.trim(),
              password: passwordInput,
              code: verificationCodeInput.trim(),
            })
          : await liveFacade.loginAccount({
              email: emailInput.trim(),
              password: passwordInput,
            });

      saveSession(result);
      setSession(result);
      setUser(result.user);
      setDisplayNameInput("");
      setEmailInput("");
      setPasswordInput("");
      setVerificationCodeInput("");
      setVerificationCooldown(0);
      setStatus(authMode === "register" ? "注册成功，正在进入频道" : "登录成功");
      showInfo(authMode === "register" ? "注册成功" : "登录成功", authMode === "register" ? "账号已创建，正在进入频道" : "欢迎回来");
    } catch (error) {
      console.error(error);
      setStatus(resolveErrorMessage(error, "认证失败"));
      showError(error, authMode === "register" ? "注册失败" : "登录失败", "认证失败");
    } finally {
      setSubmittingAuth(false);
    }
  }

  /**
   * 请求邮箱验证码。
   */
  async function requestVerificationCode() {
    if (!emailInput.trim()) {
      const message = "请先输入邮箱";
      setStatus(message);
      pushNotice("error", "无法发送验证码", message);
      return;
    }

    setSendingVerificationCode(true);
    try {
      const result = await liveFacade.sendVerificationCode({ email: emailInput.trim() });
      setVerificationCooldown(result.cooldown || 60);
      setStatus(result.emailDebug ? "验证码已生成，当前环境未启用邮件发送，请查看服务端日志" : result.message || "验证码已发送");
      showInfo("验证码已发送", result.emailDebug ? "当前环境未启用邮件发送，请查看服务端日志" : result.message || "请检查你的邮箱收件箱");
    } catch (error) {
      console.error(error);
      setStatus(resolveErrorMessage(error, "验证码发送失败"));
      showError(error, "验证码发送失败", "请稍后重试");
    } finally {
      setSendingVerificationCode(false);
    }
  }

  /**
   * 切换当前域并重置本地实时状态。
   */
  const switchDomain = useCallback(
    async (domainId: number) => {
      if (!bootstrap || bootstrap.domain.id === domainId) return;
      await rtcRef.current?.leaveVoice();
      setCurrentVoiceChannelId(null);
      setVoiceMembers(new Map());
      setRemoteMedia(new Map());
      setVoiceChannelMembers({});
      setScreeningChannelMembers({});
      setOnlineCounts({});
      setMessages([]);
      setScreenSharing(false);
      setLocalAudioStream(null);
      setLocalScreenStream(null);
      setMaximizedScreenKey(null);
      setMessageDraft("");
      setShowEmojiPicker(false);
      setShowAudioSettings(false);
      setShowProfileMenu(false);
      setVoiceTargetChannelId(null);
      setStatus("正在切换域...");
      await bootstrapData(undefined, domainId);
    },
    [
      bootstrap,
      bootstrapData,
      rtcRef,
      setCurrentVoiceChannelId,
      setLocalAudioStream,
      setLocalScreenStream,
      setMaximizedScreenKey,
      setMessageDraft,
      setMessages,
      setOnlineCounts,
      setRemoteMedia,
      setScreenSharing,
      setScreeningChannelMembers,
      setShowAudioSettings,
      setShowEmojiPicker,
      setShowProfileMenu,
      setStatus,
      setVoiceChannelMembers,
      setVoiceMembers,
      setVoiceTargetChannelId,
    ],
  );

  /**
   * 提交创建域动作。
   */
  async function submitCreateDomain() {
    if (!session) return;
    if (!domainNameInput.trim()) {
      const message = "请输入域名称";
      setStatus(message);
      pushNotice("error", "创建域失败", message);
      return;
    }
    setSubmittingDomain(true);
    try {
      const domain = await liveFacade.createDomain(session.token, {
        name: domainNameInput.trim(),
        description: domainDescriptionInput.trim() || "新的团队域。",
      });
      setCreatingDomain(false);
      setDomainNameInput("");
      setDomainDescriptionInput("");
      await switchDomain(domain.id);
      setStatus("域创建成功");
      showInfo("域创建成功", `已创建域 ${domain.name}`);
    } catch (error) {
      console.error(error);
      setStatus(resolveErrorMessage(error, "创建域失败"));
      showError(error, "创建域失败", "请稍后重试");
    } finally {
      setSubmittingDomain(false);
    }
  }

  /**
   * 根据频道类型推断可用分组。
   */
  function resolveCategoryForType(type: "text" | "voice" | "screening") {
    const categories = bootstrap?.categories || [];
    const matchByChannel = categories.find((category) => category.channels.some((channel) => channel.type === type));
    if (matchByChannel) return matchByChannel;
    const matchByName = categories.find((category) =>
      type === "text"
        ? /text/i.test(category.name) || /文字/.test(category.name)
        : type === "voice"
          ? /voice/i.test(category.name) || /语音/.test(category.name)
          : /screen/i.test(category.name) || /放映|观影|screening/i.test(category.name),
    );
    return matchByName || null;
  }

  /**
   * 提交创建频道动作。
   */
  async function submitCreateChannel() {
    if (!session || !bootstrap || !channelComposerType) return;
    if (!channelNameInput.trim()) {
      const message = "请输入频道名称";
      setStatus(message);
      pushNotice("error", "创建频道失败", message);
      return;
    }
    setSubmittingChannel(true);
    try {
      let category = resolveCategoryForType(channelComposerType);
      if (!category) {
        category = await liveFacade.createCategory(bootstrap.domain.id, session.token, {
          name: channelComposerType === "text" ? "TEXT CHANNELS" : channelComposerType === "voice" ? "VOICE CHANNELS" : "SCREENING ROOMS",
        });
      }
      const channel = await liveFacade.createChannel(bootstrap.domain.id, session.token, {
        categoryId: category.id,
        name: channelNameInput.trim(),
        type: channelComposerType,
        topic:
          channelTopicInput.trim() ||
          (channelComposerType === "text"
            ? "新的文字频道。"
            : channelComposerType === "voice"
              ? "新的语音频道。"
              : "新的放映室，可同步播放直链视频。"),
        maxMembers: channelComposerType === "voice" ? 16 : channelComposerType === "screening" ? 24 : 0,
      });
      setChannelComposerType(null);
      setChannelNameInput("");
      setChannelTopicInput("");
      await bootstrapData(channel.id, bootstrap.domain.id);
      setStatus(`${channelComposerType === "text" ? "文字" : channelComposerType === "voice" ? "语音" : "放映室"}频道创建成功`);
      showInfo(
        "频道创建成功",
        `已创建${channelComposerType === "text" ? "文字" : channelComposerType === "voice" ? "语音" : "放映室"}频道 ${channel.name}`,
      );
    } catch (error) {
      console.error(error);
      setStatus(resolveErrorMessage(error, "创建频道失败"));
      showError(error, "创建频道失败", "请稍后重试");
    } finally {
      setSubmittingChannel(false);
    }
  }

  return {
    authMode,
    setAuthMode,
    displayNameInput,
    setDisplayNameInput,
    emailInput,
    setEmailInput,
    passwordInput,
    setPasswordInput,
    verificationCodeInput,
    setVerificationCodeInput,
    submittingAuth,
    sendingVerificationCode,
    verificationCooldown,
    setVerificationCooldown,
    creatingDomain,
    setCreatingDomain,
    domainNameInput,
    setDomainNameInput,
    domainDescriptionInput,
    setDomainDescriptionInput,
    channelComposerType,
    setChannelComposerType,
    channelNameInput,
    setChannelNameInput,
    channelTopicInput,
    setChannelTopicInput,
    submittingDomain,
    submittingChannel,
    hydrateSession,
    bootstrapData,
    submitAuth,
    requestVerificationCode,
    switchDomain,
    submitCreateDomain,
    submitCreateChannel,
    logout,
  };
}

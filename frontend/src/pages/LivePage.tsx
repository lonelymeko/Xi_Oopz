import { useDeferredValue, useEffect, useMemo, useRef, useState, useCallback } from "react";

import { ChannelSidebar } from "../components/live/ChannelSidebar";
import { LiveMainPanel } from "../components/live/LiveMainPanel";
import { LiveOverlays } from "../components/live/LiveOverlays";
import { useChannelDomain } from "../hooks/useChannelDomain";
import { useLiveAudioBootstrap } from "../hooks/useLiveAudioBootstrap";
import { useLiveDerivedState } from "../hooks/useLiveDerivedState";
import { useLiveLogger } from "../hooks/useLiveLogger";
import { useLiveRuntime } from "../hooks/useLiveRuntime";
import { useLiveUiEffects } from "../hooks/useLiveUiEffects";
import { useNoticeDomain } from "../hooks/useNoticeDomain";
import { useScreeningDomain } from "../hooks/useScreeningDomain";
import { useSessionDomain } from "../hooks/useSessionDomain";
import { useVoiceDomain } from "../hooks/useVoiceDomain";
import { RTCController } from "../rtc";
import { liveFacade } from "../services/liveFacade";
import { loadSession } from "../services/session";
import { SocketClient } from "../socket";
import type {
  BootstrapResponse,
  Channel,
  DomainMember,
  Message,
  OnlineUserPresence,
  PeerConnectionDiagnostics,
  PresenceMember,
  RemoteMedia,
  ScreeningSnapshot,
  User,
} from "../types";
import type { AudioInputOption, ScreenSharePreset, Session } from "../types/live";

const EMOJI_GROUPS: Array<{ label: string; items: string[] }> = [
  { label: "常用", items: ["😀", "😂", "🤣", "😊", "😍", "🥰", "😭", "😅", "🤔", "😎"] },
  { label: "互动", items: ["👍", "👎", "👏", "🙏", "💪", "👌", "🤝", "👀", "🎉", "❤️"] },
  { label: "气氛", items: ["🔥", "✨", "💯", "🚀", "🎮", "🎵", "☕", "🍕", "🥳", "🌈"] },
];

export function LivePage() {
  const [session, setSession] = useState<Session | null>(() => loadSession<Session>());
  const [user, setUser] = useState<User | null>(() => loadSession<Session>()?.user || null);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const deferredMessages = useDeferredValue(messages);
  const [voiceMembers, setVoiceMembers] = useState<Map<number, PresenceMember>>(new Map());
  const [remoteMedia, setRemoteMedia] = useState<Map<number, RemoteMedia>>(new Map());
  const [peerDiagnostics, setPeerDiagnostics] = useState<Map<number, PeerConnectionDiagnostics>>(new Map());
  const [onlineCounts, setOnlineCounts] = useState<Record<string, number>>({});
  const [onlineUsers, setOnlineUsers] = useState<Map<number, OnlineUserPresence>>(new Map());
  const [voiceChannelMembers, setVoiceChannelMembers] = useState<Record<string, PresenceMember[]>>({});
  const [currentVoiceChannelId, setCurrentVoiceChannelId] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [status, setStatus] = useState("等待初始化");
  const [micEnabled, setMicEnabled] = useState(true);
  const [deafened, setDeafened] = useState(false);
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const [showHeadphoneSettings, setShowHeadphoneSettings] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [audioInputs, setAudioInputs] = useState<AudioInputOption[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState("");
  const [audioDevicesLoading, setAudioDevicesLoading] = useState(true);
  const [audioPrewarming, setAudioPrewarming] = useState(false);
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(true);
  const [remoteVolume, setRemoteVolume] = useState(72);
  const [screenSharing, setScreenSharing] = useState(false);
  const [audioOnlySharing, setAudioOnlySharing] = useState(false);
  const [showScreenShareSheet, setShowScreenShareSheet] = useState(false);
  const [screenSharePreset, setScreenSharePreset] = useState<ScreenSharePreset>({ surface: "tab", audioMode: "share" });
  const [messageDraft, setMessageDraft] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [localAudioStream, setLocalAudioStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [maximizedScreenKey, setMaximizedScreenKey] = useState<string | null>(null);
  const [voiceTargetChannelId, setVoiceTargetChannelId] = useState<number | null>(null);
  const [screeningSnapshot, setScreeningSnapshot] = useState<ScreeningSnapshot | null>(null);
  const clearScreeningSnapshot = useCallback(() => setScreeningSnapshot(null), [setScreeningSnapshot]);
  const [screeningChannelMembers, setScreeningChannelMembers] = useState<Record<string, User[]>>({});
  const [screeningUrlInput, setScreeningUrlInput] = useState("");
  const [screeningTitleInput, setScreeningTitleInput] = useState("");
  const [screeningJoinEpoch, setScreeningJoinEpoch] = useState(0);

  const socketRef = useRef<SocketClient | null>(null);
  const rtcRef = useRef<RTCController | null>(null);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const audioSettingsCloseTimerRef = useRef<number | null>(null);
  const headphoneSettingsCloseTimerRef = useRef<number | null>(null);
  const audioBootstrapStartedRef = useRef(false);
  const joinTraceRef = useRef<{ id: number; startedAt: number; channelId: number } | null>(null);
  const leaveTraceRef = useRef<{ id: number; startedAt: number; channelId: number | null } | null>(null);
  const voiceTraceCounterRef = useRef(0);
  const activeChannelIdRef = useRef<number | null>(null);
  const activeScreeningChannelIdRef = useRef<number | null>(null);
  const activeChannelRef = useRef<Channel | null>(null);
  const currentVoiceChannelIdRef = useRef<number | null>(null);
  const voiceMembersRef = useRef<Map<number, PresenceMember>>(new Map());
  const membersRef = useRef<DomainMember[]>([]);
  const currentUserRef = useRef<User | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const startupAudioStreamRef = useRef<MediaStream | null>(null);
  const voiceJoinInFlightRef = useRef<number | null>(null);
  const voiceLeaveInFlightRef = useRef(false);
  const screeningJoinDedupRef = useRef<{ channelId: number | null; until: number }>({ channelId: null, until: 0 });

  const audioSetupPending = audioDevicesLoading || audioPrewarming;
  const { notices, pushNotice, dismissNotice, resolveErrorMessage, showError, showInfo, clearAllNoticeTimers } = useNoticeDomain();
  const { voiceLog, screeningLog } = useLiveLogger();
  const {
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
    refreshPresence,
  } = useSessionDomain({
    session,
    bootstrap,
    setSession,
    setUser,
    setBootstrap,
    setActiveChannel,
    setMessages,
    setVoiceTargetChannelId,
    setOnlineCounts,
    setScreeningSnapshot: clearScreeningSnapshot,
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
  });

  const categories = useMemo(() => bootstrap?.categories || [], [bootstrap?.categories]);
  const {
    firstTextChannel,
    currentVoiceChannel,
    chatChannel,
    activeScreeningChannel,
    selectedVoiceCount,
    canManageDomain,
    screeningViewerMembers,
    onlineMembers,
    offlineMembers,
    screenPreviewKeys,
    maximizedScreen,
    voiceMembersList,
    channelNameById,
  } = useLiveDerivedState({
    bootstrap,
    activeChannel,
    currentVoiceChannelId,
    voiceChannelMembers,
    voiceMembers,
    onlineUsers,
    screeningSnapshot,
    user,
    localScreenStream,
    remoteMedia,
    maximizedScreenKey,
  });

  useEffect(() => {
    activeScreeningChannelIdRef.current = activeScreeningChannel?.id || null;
  }, [activeScreeningChannel?.id]);

  const {
    joinVoice,
    leaveVoice,
    toggleMic,
    toggleDeafen,
    handleAudioInputChange,
    handleNoiseSuppressionChange,
    openAudioSettings,
    scheduleCloseAudioSettings: scheduleCloseAudioSettingsInternal,
    openHeadphoneSettings: openHeadphoneSettingsInternal,
    scheduleCloseHeadphoneSettings: scheduleCloseHeadphoneSettingsInternal,
  } = useVoiceDomain({
    currentVoiceChannelId,
    voiceTargetChannelId,
    selectedAudioInputId,
    noiseSuppressionEnabled,
    deafened,
    micEnabled,
    audioInputs,
    setSelectedAudioInputId,
    setNoiseSuppressionEnabled,
    setShowAudioSettings,
    setStatus,
    setCurrentVoiceChannelId,
    setVoiceTargetChannelId,
    setMicEnabled,
    setDeafened,
    setScreenSharing,
    setVoiceMembers,
    setRemoteMedia,
    setLocalAudioStream,
    setLocalScreenStream,
    setMaximizedScreenKey,
    setAudioInputs,
    setAudioPrewarming,
    socketRef,
    rtcRef,
    joinTraceRef,
    leaveTraceRef,
    voiceTraceCounterRef,
    voiceJoinInFlightRef,
    voiceLeaveInFlightRef,
    audioSettingsCloseTimerRef,
    headphoneSettingsCloseTimerRef,
    showError,
    resolveErrorMessage,
    voiceLog,
    refreshPresence,
  });

  const { leaveScreeningChannel, toggleScreenShare, confirmScreenShare, toggleAudioOnlyShare } = useScreeningDomain({
    activeChannelRef,
    currentVoiceChannelIdRef,
    currentVoiceChannel,
    currentVoiceChannelId,
    firstTextChannel,
    screenSharing,
    screenSharePreset,
    audioOnlySharing,
    rtcRef,
    socketRef,
    screeningJoinDedupRef,
    setScreenSharing,
    setShowScreenShareSheet,
    setScreeningSnapshot,
    setScreeningJoinEpoch,
    setActiveChannel,
    setStatus,
    pushNotice,
    showError,
    screeningLog,
    leaveVoice,
    refreshPresence,
  });

  const { selectChannel, sendMessage, appendEmoji, enterVoiceChannel } = useChannelDomain({
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
  });

  /**
   * 打开耳机设置面板。
   */
  function openHeadphoneSettings() {
    openHeadphoneSettingsInternal(setShowHeadphoneSettings);
  }

  /**
   * 延迟关闭耳机设置面板。
   */
  function scheduleCloseHeadphoneSettings() {
    scheduleCloseHeadphoneSettingsInternal(setShowHeadphoneSettings);
  }

  /**
   * 延迟关闭音频设置面板。
   */
  function scheduleCloseAudioSettings() {
    scheduleCloseAudioSettingsInternal(setShowAudioSettings);
  }

  useLiveUiEffects({
    sessionToken: session?.token || null,
    user,
    activeChannel,
    currentVoiceChannelId,
    voiceMembers,
    bootstrapMembers: bootstrap?.members || [],
    bootstrapStunServers: bootstrap?.stunServers || [],
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
  });

  useLiveAudioBootstrap({
    sessionToken: session?.token || null,
    userId: user?.id || null,
    domainId: bootstrap?.domain.id || null,
    localAudioStream,
    showError,
    setStatus,
    setAudioDevicesLoading,
    setAudioPrewarming,
    setAudioInputs,
    setSelectedAudioInputId,
    rtcRef,
    startupAudioStreamRef,
    audioBootstrapStartedRef,
  });

  useLiveRuntime({
    setAudioOnlySharing,
    sessionToken: session?.token || null,
    userId: user?.id || null,
    domainId: bootstrap?.domain.id || null,
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
    pushNotice,
    voiceLog,
    screeningLog,
    refreshPresence,
  });

  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;

    /**
     * 初始化会话与引导数据，避免并行触发重复请求。
     */
    const runInit = async () => {
      await hydrateSession();
      if (cancelled) return;
      await bootstrapData();
    };

    void runInit();

    return () => {
      cancelled = true;
    };
  }, [bootstrapData, hydrateSession, session?.token]);

  useEffect(() => {
    if (!session || !bootstrap || !chatChannel) return;
    if (activeChannel?.type !== "voice" || currentVoiceChannelId) return;
    void liveFacade
      .fetchChannelMessages(bootstrap.domain.id, chatChannel.id, session.token)
      .then((nextMessages) => {
        setMessages(nextMessages);
      })
      .catch((error) => {
        console.error(error);
      });
  }, [activeChannel?.type, bootstrap, chatChannel, currentVoiceChannelId, session]);

  return (
    <div className="app-shell">
      <ChannelSidebar
        bootstrap={bootstrap}
        user={user}
        activeChannel={activeChannel}
        firstTextChannel={firstTextChannel}
        canManageDomain={canManageDomain}
        categories={categories}
        currentVoiceChannelId={currentVoiceChannelId}
        voiceTargetChannelId={voiceTargetChannelId}
        onlineCounts={onlineCounts}
        voiceChannelMembers={voiceChannelMembers}
        screeningChannelMembers={screeningChannelMembers}
        micEnabled={micEnabled}
        deafened={deafened}
        audioSetupPending={audioSetupPending}
        audioDevicesLoading={audioDevicesLoading}
        audioPrewarming={audioPrewarming}
        selectedAudioInputId={selectedAudioInputId}
        audioInputs={audioInputs}
        noiseSuppressionEnabled={noiseSuppressionEnabled}
        remoteVolume={remoteVolume}
        showAudioSettings={showAudioSettings}
        showHeadphoneSettings={showHeadphoneSettings}
        showProfileMenu={showProfileMenu}
        currentVoiceChannelAvailable={Boolean(currentVoiceChannelId)}
        setCreatingDomain={setCreatingDomain}
        setShowProfileMenu={setShowProfileMenu}
        setChannelComposerType={setChannelComposerType}
        setRemoteVolume={setRemoteVolume}
        switchDomain={switchDomain}
        selectChannel={selectChannel}
        enterVoiceChannel={enterVoiceChannel}
        toggleMic={toggleMic}
        toggleDeafen={toggleDeafen}
        audioOnlySharing={audioOnlySharing}
        toggleAudioOnlyShare={toggleAudioOnlyShare}
        leaveVoice={leaveVoice}
        handleAudioInputChange={handleAudioInputChange}
        handleNoiseSuppressionChange={handleNoiseSuppressionChange}
        openAudioSettings={openAudioSettings}
        scheduleCloseAudioSettings={scheduleCloseAudioSettings}
        openHeadphoneSettings={openHeadphoneSettings}
        scheduleCloseHeadphoneSettings={scheduleCloseHeadphoneSettings}
        logout={logout}
        profileMenuRef={profileMenuRef}
      />
      <LiveMainPanel
        bootstrap={bootstrap}
        user={user}
        activeScreeningChannel={activeScreeningChannel}
        currentVoiceChannel={currentVoiceChannel}
        currentVoiceChannelId={currentVoiceChannelId}
        selectedVoiceCount={selectedVoiceCount}
        wsConnected={wsConnected}
        status={status}
        screenSharing={screenSharing}
        voiceMembersList={voiceMembersList}
        voiceMembers={voiceMembers}
        remoteMedia={remoteMedia}
        localAudioStream={localAudioStream}
        localScreenStream={localScreenStream}
        peerDiagnostics={peerDiagnostics}
        screeningJoinEpoch={screeningJoinEpoch}
        screeningSnapshot={screeningSnapshot}
        screeningUrlInput={screeningUrlInput}
        screeningTitleInput={screeningTitleInput}
        chatChannel={chatChannel}
        deferredMessages={deferredMessages}
        messageDraft={messageDraft}
        showEmojiPicker={showEmojiPicker}
        emojiGroups={EMOJI_GROUPS}
        screeningViewerMembers={screeningViewerMembers}
        onlineMembers={onlineMembers}
        offlineMembers={offlineMembers}
        onlineUsers={onlineUsers}
        channelNameById={channelNameById}
        deafened={deafened}
        micEnabled={micEnabled}
        remoteVolume={remoteVolume}
        messageListRef={messageListRef}
        messageInputRef={messageInputRef}
        emojiPickerRef={emojiPickerRef}
        setMessageDraft={setMessageDraft}
        setShowEmojiPicker={setShowEmojiPicker}
        setScreeningUrlInput={setScreeningUrlInput}
        setScreeningTitleInput={setScreeningTitleInput}
        setMaximizedScreenKey={setMaximizedScreenKey}
        toggleScreenShare={toggleScreenShare}
        appendEmoji={appendEmoji}
        sendMessage={sendMessage}
        onScreeningReplace={(url, title) => {
          if (!activeScreeningChannel) return;
          socketRef.current?.send("screening.url.replace", { channelId: activeScreeningChannel.id, url, title });
          setScreeningUrlInput("");
          setScreeningTitleInput("");
        }}
        onScreeningAppend={(url, title) => {
          if (!activeScreeningChannel) return;
          socketRef.current?.send("screening.url.add", { channelId: activeScreeningChannel.id, url, title });
          setScreeningUrlInput("");
          setScreeningTitleInput("");
        }}
        onScreeningRemove={(itemId) => {
          if (!activeScreeningChannel) return;
          socketRef.current?.send("screening.url.remove", { channelId: activeScreeningChannel.id, itemId });
        }}
        onScreeningPlaybackEvent={(type, payload) => {
          if (!activeScreeningChannel) return;
          socketRef.current?.send(type, { channelId: activeScreeningChannel.id, ...payload });
        }}
        onScreeningError={(title, message) => pushNotice("error", title, message)}
      />
      <LiveOverlays
        session={session}
        creatingDomain={creatingDomain}
        channelComposerType={channelComposerType}
        maximizdScreen={maximizedScreen}
        showScreenShareSheet={showScreenShareSheet}
        screenSharePreset={screenSharePreset}
        notices={notices}
        authMode={authMode}
        displayNameInput={displayNameInput}
        emailInput={emailInput}
        verificationCodeInput={verificationCodeInput}
        passwordInput={passwordInput}
        submittingAuth={submittingAuth}
        sendingVerificationCode={sendingVerificationCode}
        verificationCooldown={verificationCooldown}
        domainNameInput={domainNameInput}
        domainDescriptionInput={domainDescriptionInput}
        submittingDomain={submittingDomain}
        channelNameInput={channelNameInput}
        channelTopicInput={channelTopicInput}
        submittingChannel={submittingChannel}
        setAuthMode={setAuthMode}
        setDisplayNameInput={setDisplayNameInput}
        setEmailInput={setEmailInput}
        setVerificationCodeInput={setVerificationCodeInput}
        setPasswordInput={setPasswordInput}
        setCreatingDomain={setCreatingDomain}
        setDomainNameInput={setDomainNameInput}
        setDomainDescriptionInput={setDomainDescriptionInput}
        setChannelComposerType={setChannelComposerType}
        setChannelNameInput={setChannelNameInput}
        setChannelTopicInput={setChannelTopicInput}
        setMaximizedScreenKey={setMaximizedScreenKey}
        setShowScreenShareSheet={setShowScreenShareSheet}
        setScreenSharePreset={setScreenSharePreset}
        submitAuth={submitAuth}
        requestVerificationCode={requestVerificationCode}
        submitCreateDomain={submitCreateDomain}
        submitCreateChannel={submitCreateChannel}
        confirmScreenShare={confirmScreenShare}
        dismissNotice={dismissNotice}
      />
    </div>
  );
}

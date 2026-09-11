import { useState, type RefObject } from "react";

import { MemberSection, RemoteAudioLayer, ScreenStage, VoiceAvatarOrb } from "./voiceAndMember";
import { ScreeningPlaylistSection, ScreeningRoomPanel } from "./screening";
import {
  AudioShareIcon,
  ChatIcon,
  DownloadIcon,
  ExpandIcon,
  HashIcon,
  HomeIcon,
  ListIcon,
  MenuIcon,
  PhoneIcon,
  PlusIcon,
  ReturnIcon,
  ScreenOffIcon,
  ScreenShareIcon,
  SearchIcon,
  SendIcon,
  SmileIcon,
  TagIcon,
  VoiceChannelIcon,
} from "./icons";
import { escapeHTML, formatTime, initials } from "../../utils/live";
import type { DownloadNoticeEvent } from "../../types/live";
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
} from "../../types";

/**
 * 中部主区域与右侧成员栏组件。
 */
export function LiveMainPanel(props: {
  bootstrap: BootstrapResponse | null;
  user: User | null;
  activeScreeningChannel: Channel | null;
  currentVoiceChannel: Channel | null;
  currentVoiceChannelId: number | null;
  selectedVoiceCount: number;
  wsConnected: boolean;
  status: string;
  screenSharing: boolean;
  audioOnlySharing: boolean;
  voiceMembersList: PresenceMember[];
  voiceMembers: Map<number, PresenceMember>;
  remoteMedia: Map<number, RemoteMedia>;
  localAudioStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  peerDiagnostics: Map<number, PeerConnectionDiagnostics>;
  screeningJoinEpoch: number;
  screeningJoined: boolean;
  screeningSnapshot: ScreeningSnapshot | null;
  screeningUrlInput: string;
  screeningTitleInput: string;
  chatChannel: Channel | null;
  deferredMessages: Message[];
  messageDraft: string;
  showEmojiPicker: boolean;
  emojiGroups: Array<{ label: string; items: string[] }>;
  screeningViewerMembers: DomainMember[];
  onlineMembers: DomainMember[];
  offlineMembers: DomainMember[];
  onlineUsers: Map<number, OnlineUserPresence>;
  channelNameById: Map<number, string>;
  deafened: boolean;
  micEnabled: boolean;
  remoteVolume: number;
  messageListRef: RefObject<HTMLDivElement | null>;
  messageInputRef: RefObject<HTMLTextAreaElement | null>;
  emojiPickerRef: RefObject<HTMLDivElement | null>;
  setMessageDraft: (value: string | ((current: string) => string)) => void;
  setShowEmojiPicker: (value: boolean | ((current: boolean) => boolean)) => void;
  setScreeningUrlInput: (value: string) => void;
  setScreeningTitleInput: (value: string) => void;
  setMaximizedScreenKey: (value: string | null) => void;
  toggleScreenShare: () => Promise<void>;
  toggleAudioOnlyShare: () => Promise<void>;
  appendEmoji: (emoji: string) => void;
  sendMessage: (body: string) => Promise<void>;
  onScreeningReplace: (url: string, title: string) => void;
  onScreeningAppend: (url: string, title: string) => void;
  onScreeningRemove: (itemId: string) => void;
  onScreeningPlaybackEvent: (type: string, payload: Record<string, unknown>) => void;
  onScreeningError: (title: string, message: string) => void;
  onDownloadNotice: (event: DownloadNoticeEvent) => void;
}) {
  const {
    bootstrap,
    user,
    activeScreeningChannel,
    currentVoiceChannel,
    currentVoiceChannelId,
    selectedVoiceCount,
    wsConnected,
    status,
    screenSharing,
    audioOnlySharing,
    voiceMembersList,
    voiceMembers,
    remoteMedia,
    localAudioStream,
    localScreenStream,
    peerDiagnostics,
    screeningJoinEpoch,
    screeningJoined,
    screeningSnapshot,
    screeningUrlInput,
    screeningTitleInput,
    chatChannel,
    deferredMessages,
    messageDraft,
    showEmojiPicker,
    emojiGroups,
    screeningViewerMembers,
    onlineMembers,
    offlineMembers,
    onlineUsers,
    channelNameById,
    deafened,
    remoteVolume,
    micEnabled,
    messageListRef,
    messageInputRef,
    emojiPickerRef,
    setMessageDraft,
    setShowEmojiPicker,
    setScreeningUrlInput,
    setScreeningTitleInput,
    setMaximizedScreenKey,
    toggleScreenShare,
    toggleAudioOnlyShare,
    appendEmoji,
    sendMessage,
    onScreeningReplace,
    onScreeningAppend,
    onScreeningRemove,
    onScreeningPlaybackEvent,
    onScreeningError,
    onDownloadNotice,
  } = props;

  const onlineMemberIds = new Set(onlineUsers.keys());

  // 语音区：共享画面统一在上方 ScreenStage 展示，头像列表保持不动，点头像切换查看谁的共享。
  const [activeShareKey, setActiveShareKey] = useState<string | null>(null);
  const shareItems = voiceMembersList
    .map((member) => {
      const isSelf = member.user.id === user?.id;
      const stream = isSelf
        ? localScreenStream
        : remoteMedia.get(member.user.id)?.screenStream || null;
      return {
        member,
        isSelf,
        stream,
        key: isSelf ? `local-${member.user.id}` : `remote-${member.user.id}`,
      };
    })
    .filter((item) => item.member.screenSharing && item.stream);
  const activeShare =
    shareItems.find((item) => item.key === activeShareKey) ?? shareItems[0] ?? null;

  return (
    <>
      <main className={`main-panel ${activeScreeningChannel ? "main-panel--screening" : ""}`}>
        <RemoteAudioLayer remoteMedia={remoteMedia} selfUserId={user?.id || 0} deafened={deafened} remoteVolume={remoteVolume} />
        <div className="top-utility-bar">
          <div className="top-utility-bar__left">
            <button className="utility-circle">
              <PhoneIcon />
            </button>
            <button className="utility-circle">
              <ChatIcon />
            </button>
            <label className="search-box">
              <SearchIcon />
              <input type="text" placeholder="搜索你感兴趣的域" />
            </label>
          </div>
          <div className="top-utility-bar__right">
            <button className="membership-pill">开通会员</button>
            <button className="utility-ghost">
              <DownloadIcon />
            </button>
            <button className="utility-ghost">
              <MenuIcon />
            </button>
          </div>
        </div>

        {currentVoiceChannel && !activeScreeningChannel ? (
          <section className="voice-presence-dock">
            <div className="voice-presence-dock__title">
              <div>
                <div className="voice-presence-dock__heading">
                  <VoiceChannelIcon />
                  <strong>{currentVoiceChannel.name}</strong>
                  <span>
                    {selectedVoiceCount.toString().padStart(2, "0")}/{currentVoiceChannel.maxMembers || 50}
                  </span>
                </div>
                <p>点击共享预览可放大，讲话时头像边框会高亮。</p>
              </div>
              <div className="voice-presence-dock__actions">
                <span className={`connection-badge ${wsConnected ? "connection-badge--online" : ""}`}>{status}</span>
                <button className="action-pill">邀请/分享</button>
                <button
                  className={`round-action ${audioOnlySharing ? "round-action--active" : ""}`}
                  title={audioOnlySharing ? "停止共享音频" : "只共享音频（不共享画面）"}
                  aria-label={audioOnlySharing ? "停止共享音频" : "只共享音频"}
                  aria-pressed={audioOnlySharing}
                  disabled={!currentVoiceChannelId}
                  onClick={() => void toggleAudioOnlyShare()}
                >
                  <AudioShareIcon />
                </button>
                <button
                  className={`round-action ${screenSharing ? "round-action--active" : ""}`}
                  title={screenSharing ? "停止屏幕共享" : "开始屏幕共享"}
                  aria-label={screenSharing ? "停止屏幕共享" : "开始屏幕共享"}
                  disabled={!currentVoiceChannelId}
                  onClick={() => void toggleScreenShare()}
                >
                  {screenSharing ? <ScreenOffIcon /> : <ScreenShareIcon />}
                </button>
              </div>
            </div>
            {activeShare?.stream ? (
              <ScreenStage
                stream={activeShare.stream}
                title={`${activeShare.member.user.displayName}${activeShare.isSelf ? "（你）" : ""} 的屏幕`}
                onMaximize={() => setMaximizedScreenKey(activeShare.key)}
              />
            ) : null}
            <div className="voice-presence-dock__avatars">
              {voiceMembersList.length ? (
                voiceMembersList.map((member) => {
                  const isSelf = member.user.id === user?.id;
                  const shareKey = isSelf ? `local-${member.user.id}` : `remote-${member.user.id}`;
                  const sharingWithStream = shareItems.some((item) => item.key === shareKey);
                  return (
                    <VoiceAvatarOrb
                      key={member.user.id}
                      user={member.user}
                      stream={isSelf ? localAudioStream : remoteMedia.get(member.user.id)?.audioStream || null}
                      micEnabled={isSelf ? micEnabled : member.micEnabled}
                      screenSharing={member.screenSharing}
                      isCurrentUser={isSelf}
                      diagnostics={peerDiagnostics.get(member.user.id)}
                      onSelectShare={sharingWithStream ? () => setActiveShareKey(shareKey) : undefined}
                      activeShare={activeShare?.key === shareKey}
                    />
                  );
                })
              ) : (
                <div className="empty-state empty-state--small">暂无在线语音成员</div>
              )}
            </div>
          </section>
        ) : null}

        {activeScreeningChannel ? (
          <ScreeningRoomPanel
            key={`${activeScreeningChannel.id}-${screeningJoinEpoch}`}
            channel={activeScreeningChannel}
            snapshot={screeningSnapshot}
            currentUser={user}
            joinEpoch={screeningJoinEpoch}
            joined={screeningJoined}
            urlInput={screeningUrlInput}
            titleInput={screeningTitleInput}
            onUrlInputChange={setScreeningUrlInput}
            onTitleInputChange={setScreeningTitleInput}
            onReplace={({ url, title }) => onScreeningReplace(url, title)}
            onAppend={({ url, title }) => onScreeningAppend(url, title)}
            onPlaybackEvent={onScreeningPlaybackEvent}
            onError={onScreeningError}
            onDownloadNotice={onDownloadNotice}
          />
        ) : null}

        {activeScreeningChannel ? (
          <div className="screening-playlist-mobile">
            <ScreeningPlaylistSection playlist={screeningSnapshot?.playlist || []} onRemove={onScreeningRemove} />
          </div>
        ) : null}

        <section className={`chat-panel ${activeScreeningChannel ? "chat-panel--screening" : ""}`}>
          {chatChannel?.type === "screening" ? null : (
            <div className="chat-panel__toolbar">
              <div className="chat-panel__title">
                <div className="chat-panel__title-icon">{chatChannel?.type === "text" ? <HomeIcon /> : <HashIcon />}</div>
                <div>
                  <h3>{chatChannel?.name || "主页"}</h3>
                  <span>{chatChannel?.topic || bootstrap?.domain.description || "域内消息会显示在这里。"}</span>
                </div>
              </div>
              <div className="chat-panel__icons">
                <button className="plain-icon-button">
                  <SendIcon />
                </button>
                <button className="plain-icon-button">
                  <TagIcon />
                </button>
                <button className="plain-icon-button">
                  <ListIcon />
                </button>
              </div>
            </div>
          )}
          <div className="message-list" ref={messageListRef}>
            {!deferredMessages.length ? (
              <div className="empty-state">这里还没有消息。可以先发一句，或者直接进入语音房。</div>
            ) : (
              deferredMessages.map((message) => (
                <article key={message.id} className={`message-row ${message.messageType === "system" ? "message-row--system" : ""}`}>
                  <div className="avatar" style={{ background: message.userAvatarColor }}>
                    {initials(message.userDisplayName)}
                  </div>
                  <div className="message-body">
                    <div className="message-meta">
                      <strong>{message.userDisplayName}</strong>
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                    <p dangerouslySetInnerHTML={{ __html: escapeHTML(message.body) }} />
                  </div>
                </article>
              ))
            )}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage(messageDraft);
            }}
          >
            <div className="composer__box">
              <div className="composer__input-wrap">
                <textarea
                  ref={messageInputRef}
                  name="message"
                  placeholder={`发送至频道 ${chatChannel?.name || "主页"}`}
                  rows={1}
                  value={messageDraft}
                  onChange={(event) => setMessageDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage(messageDraft);
                    }
                  }}
                />
                {showEmojiPicker ? (
                  <div className="emoji-picker" ref={emojiPickerRef}>
                    {emojiGroups.map((group) => (
                      <div key={group.label} className="emoji-picker__group">
                        <div className="emoji-picker__label">{group.label}</div>
                        <div className="emoji-picker__grid">
                          {group.items.map((emoji) => (
                            <button key={emoji} type="button" className="emoji-picker__item" onClick={() => appendEmoji(emoji)}>
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="composer__actions">
                <button className="plain-icon-button" type="button">
                  <ReturnIcon />
                </button>
                <button
                  className={`plain-icon-button ${showEmojiPicker ? "plain-icon-button--active" : ""}`}
                  type="button"
                  onClick={() => setShowEmojiPicker((value) => !value)}
                >
                  <SmileIcon />
                </button>
                <button className="plain-icon-button" type="button">
                  <PlusIcon />
                </button>
                <button className="plain-icon-button" type="button">
                  <ExpandIcon />
                </button>
                <button className="composer__send-button" type="submit" disabled={!messageDraft.trim()}>
                  发送
                </button>
              </div>
            </div>
          </form>
        </section>
      </main>

      <aside className="member-sidebar">
        <div className="member-sidebar__header">
          <div className="eyebrow">MEMBERS</div>
          <div className="member-sidebar__title-row">
            <div className="member-sidebar__channel-tools">
              <button className="plain-icon-button">
                <SendIcon />
              </button>
              <button className="plain-icon-button">
                <TagIcon />
              </button>
              <button className="plain-icon-button">
                <ListIcon />
              </button>
            </div>
            <div className="member-sidebar__summary">
              <span>{bootstrap?.domain.name}</span>
              <span> - {(bootstrap?.members || []).filter((member) => onlineMemberIds.has(member.id)).length}</span>
            </div>
            <button className="plain-icon-button">
              <SearchIcon />
            </button>
          </div>
        </div>

        <div className="member-list">
          {activeScreeningChannel ? (
            <ScreeningPlaylistSection playlist={screeningSnapshot?.playlist || []} onRemove={onScreeningRemove} />
          ) : null}
          {activeScreeningChannel ? (
            <MemberSection
              title={`${screeningViewerMembers.length} 人正在观看 ${activeScreeningChannel.name}`}
              members={screeningViewerMembers}
              voiceMembers={voiceMembers}
              onlineUsers={onlineUsers}
              channelNameById={channelNameById}
              showCount={false}
              localAudioStream={localAudioStream}
              remoteMedia={remoteMedia}
              currentUserId={user?.id || 0}
              currentUserMicEnabled={micEnabled}
              showVoiceState
              peerDiagnostics={peerDiagnostics}
            />
          ) : null}
          <MemberSection
            title="在线"
            members={onlineMembers}
            voiceMembers={voiceMembers}
            onlineUsers={onlineUsers}
            channelNameById={channelNameById}
            peerDiagnostics={peerDiagnostics}
          />
          <MemberSection
            title="离线"
            members={offlineMembers}
            voiceMembers={voiceMembers}
            onlineUsers={onlineUsers}
            channelNameById={channelNameById}
            peerDiagnostics={peerDiagnostics}
          />
        </div>
      </aside>
    </>
  );
}

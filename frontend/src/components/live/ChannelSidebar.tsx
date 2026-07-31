import type { RefObject } from "react";

import {
  CopyIcon,
  HangupIcon,
  HashIcon,
  HeadphoneIcon,
  HomeIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  PlayIcon,
  VoiceChannelIcon,
} from "./icons";
import type { AudioInputOption } from "../../types/live";
import type { BootstrapResponse, Channel, PresenceMember, User } from "../../types";
import { initials } from "../../utils/live";

const FRONTEND_DEBUG_VERSION = 5;

/**
 * 左侧服务器与频道栏组件。
 */
export function ChannelSidebar(props: {
  bootstrap: BootstrapResponse | null;
  user: User | null;
  activeChannel: Channel | null;
  firstTextChannel: Channel | null;
  canManageDomain: boolean;
  categories: BootstrapResponse["categories"];
  currentVoiceChannelId: number | null;
  voiceTargetChannelId: number | null;
  onlineCounts: Record<string, number>;
  voiceChannelMembers: Record<string, PresenceMember[]>;
  screeningChannelMembers: Record<string, User[]>;
  micEnabled: boolean;
  deafened: boolean;
  audioSetupPending: boolean;
  audioDevicesLoading: boolean;
  audioPrewarming: boolean;
  selectedAudioInputId: string;
  audioInputs: AudioInputOption[];
  noiseSuppressionEnabled: boolean;
  remoteVolume: number;
  showAudioSettings: boolean;
  showHeadphoneSettings: boolean;
  showProfileMenu: boolean;
  currentVoiceChannelAvailable: boolean;
  setCreatingDomain: (value: boolean) => void;
  setShowProfileMenu: (value: boolean | ((current: boolean) => boolean)) => void;
  setChannelComposerType: (value: "text" | "voice" | "screening" | null) => void;
  setRemoteVolume: (value: number) => void;
  switchDomain: (domainId: number) => Promise<void>;
  selectChannel: (channel: Channel) => Promise<void>;
  enterVoiceChannel: (channel: Channel) => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleDeafen: () => Promise<void>;
  leaveVoice: () => Promise<void>;
  handleAudioInputChange: (deviceId: string) => Promise<void>;
  handleNoiseSuppressionChange: (enabled: boolean) => Promise<void>;
  openAudioSettings: () => void;
  scheduleCloseAudioSettings: () => void;
  openHeadphoneSettings: () => void;
  scheduleCloseHeadphoneSettings: () => void;
  logout: () => void;
  profileMenuRef: RefObject<HTMLDivElement | null>;
}) {
  const {
    bootstrap,
    user,
    activeChannel,
    firstTextChannel,
    canManageDomain,
    categories,
    currentVoiceChannelId,
    voiceTargetChannelId,
    onlineCounts,
    voiceChannelMembers,
    screeningChannelMembers,
    micEnabled,
    deafened,
    audioSetupPending,
    audioDevicesLoading,
    audioPrewarming,
    selectedAudioInputId,
    audioInputs,
    noiseSuppressionEnabled,
    remoteVolume,
    showAudioSettings,
    showHeadphoneSettings,
    showProfileMenu,
    currentVoiceChannelAvailable,
    setCreatingDomain,
    setShowProfileMenu,
    setChannelComposerType,
    setRemoteVolume,
    switchDomain,
    selectChannel,
    enterVoiceChannel,
    toggleMic,
    toggleDeafen,
    leaveVoice,
    handleAudioInputChange,
    handleNoiseSuppressionChange,
    openAudioSettings,
    scheduleCloseAudioSettings,
    openHeadphoneSettings,
    scheduleCloseHeadphoneSettings,
    logout,
    profileMenuRef,
  } = props;

  return (
    <>
      <aside className="server-rail">
        <div className="brand">
          Oopz<span>.</span>
        </div>
        <div className="server-icons">
          {(bootstrap?.domains || []).map((domain) => (
            <button
              key={domain.id}
              className={`server-icon ${bootstrap?.domain.id === domain.id ? "server-icon--active" : ""}`}
              title={`${domain.name} · ${domain.role === "owner" ? "域主" : domain.role === "member" ? "成员" : "可见未加入"}`}
              onClick={() => void switchDomain(domain.id)}
            >
              {initials(domain.name)}
            </button>
          ))}
          <button className="server-icon server-icon--plus" title="创建域" onClick={() => setCreatingDomain(true)}>
            +
          </button>
        </div>
      </aside>

      <aside className="channel-sidebar">
        <div className="mobile-domain-strip">
          <div className="mobile-domain-strip__scroll">
            {(bootstrap?.domains || []).map((domain) => (
              <button
                key={domain.id}
                className={`mobile-domain-chip ${bootstrap?.domain.id === domain.id ? "mobile-domain-chip--active" : ""}`}
                onClick={() => void switchDomain(domain.id)}
              >
                <span className="mobile-domain-chip__avatar">{initials(domain.name)}</span>
                <span className="mobile-domain-chip__name">{domain.name}</span>
              </button>
            ))}
            <button className="mobile-domain-chip mobile-domain-chip--create" onClick={() => setCreatingDomain(true)}>
              <span className="mobile-domain-chip__avatar">+</span>
              <span className="mobile-domain-chip__name">创建域</span>
            </button>
          </div>
        </div>

        <div className="sidebar-topbar">
          <div className="sidebar-topbar__controls">
            <div className="sidebar-control-pill">
              <div className="mic-settings-anchor" onMouseEnter={openAudioSettings} onMouseLeave={scheduleCloseAudioSettings}>
                <button
                  className={`sidebar-icon-button ${micEnabled ? "" : "sidebar-icon-button--danger"} ${audioSetupPending ? "sidebar-icon-button--loading" : ""}`}
                  title={micEnabled ? "关闭麦克风" : "打开麦克风"}
                  aria-label={micEnabled ? "关闭麦克风" : "打开麦克风"}
                  onClick={() => void toggleMic()}
                >
                  {micEnabled ? <MicIcon /> : <MicOffIcon />}
                  {audioSetupPending ? <span className="sidebar-icon-button__spinner" aria-hidden="true" /> : null}
                </button>
                {showAudioSettings ? (
                  <div className="audio-settings-panel" onMouseEnter={openAudioSettings} onMouseLeave={scheduleCloseAudioSettings}>
                    <div className="audio-settings-panel__status">
                      <span
                        className={`audio-settings-panel__status-dot ${audioSetupPending ? "audio-settings-panel__status-dot--loading" : ""}`}
                      />
                      <strong>
                        {audioDevicesLoading ? "正在加载音频设备..." : audioPrewarming ? "正在预热麦克风..." : "音频设备已就绪"}
                      </strong>
                    </div>
                    <div className="audio-settings-panel__slider">
                      <input type="range" min="0" max="100" defaultValue="52" aria-label="麦克风灵敏度" />
                    </div>
                    <div className="audio-settings-panel__line" />
                    <label className="audio-settings-field">
                      <span>输入设备</span>
                      <select value={selectedAudioInputId} onChange={(event) => void handleAudioInputChange(event.target.value)}>
                        {audioInputs.length ? (
                          audioInputs.map((input) => (
                            <option key={input.deviceId} value={input.deviceId}>
                              {input.label}
                            </option>
                          ))
                        ) : (
                          <option value="">未检测到麦克风</option>
                        )}
                      </select>
                    </label>
                    <label className="audio-switch-row">
                      <div>
                        <strong>AI 智能降噪</strong>
                        <span>启用浏览器噪音抑制</span>
                      </div>
                      <button
                        type="button"
                        className={`switch-button ${noiseSuppressionEnabled ? "switch-button--active" : ""}`}
                        onClick={() => void handleNoiseSuppressionChange(!noiseSuppressionEnabled)}
                      >
                        <span />
                      </button>
                    </label>
                    <label className="audio-switch-row">
                      <div>
                        <strong>麦克风增强</strong>
                        <span>自动增益与回声消除</span>
                      </div>
                      <button type="button" className="switch-button switch-button--active" disabled>
                        <span />
                      </button>
                    </label>
                  </div>
                ) : null}
              </div>
              <div className="mic-settings-anchor" onMouseEnter={openHeadphoneSettings} onMouseLeave={scheduleCloseHeadphoneSettings}>
                <button
                  className={`sidebar-icon-button ${deafened ? "sidebar-icon-button--danger" : ""}`}
                  title={deafened ? "关闭耳机静听" : "开启耳机静听"}
                  aria-label={deafened ? "关闭耳机静听" : "开启耳机静听"}
                  onClick={() => void toggleDeafen()}
                >
                  <HeadphoneIcon />
                </button>
                {showHeadphoneSettings ? (
                  <div className="audio-settings-panel" onMouseEnter={openHeadphoneSettings} onMouseLeave={scheduleCloseHeadphoneSettings}>
                    <div className="audio-settings-panel__status">
                      <span className={`audio-settings-panel__status-dot ${deafened ? "" : "audio-settings-panel__status-dot--loading"}`} />
                      <strong>{deafened ? "耳机静听已开启" : "远端声音输出中"}</strong>
                    </div>
                    <div className="audio-settings-panel__slider">
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={remoteVolume}
                        aria-label="远端音量"
                        onChange={(event) => setRemoteVolume(Number(event.target.value))}
                      />
                    </div>
                    <div className="audio-settings-panel__line" />
                    <label className="audio-switch-row">
                      <div>
                        <strong>耳机静听</strong>
                        <span>开启后听不到任何人，并自动关闭麦克风</span>
                      </div>
                      <button
                        type="button"
                        className={`switch-button ${deafened ? "switch-button--active" : ""}`}
                        onClick={() => void toggleDeafen()}
                      >
                        <span />
                      </button>
                    </label>
                  </div>
                ) : null}
              </div>
              <button
                className="sidebar-icon-button sidebar-icon-button--danger"
                title="挂断通话"
                aria-label="挂断通话"
                disabled={!currentVoiceChannelAvailable}
                onClick={() => void leaveVoice()}
              >
                <HangupIcon />
              </button>
            </div>
          </div>
          <div className="profile-menu-wrap" ref={profileMenuRef}>
            <button className="profile-chip" onClick={() => setShowProfileMenu((value) => !value)} title="账号菜单" aria-label="账号菜单">
              <span className="profile-chip__version">v{FRONTEND_DEBUG_VERSION}</span>
              <div className="profile-chip__avatar" style={{ background: user?.avatarColor || "#556" }}>
                {initials(user?.displayName)}
              </div>
              <span className="profile-chip__dot" />
            </button>
            {showProfileMenu ? (
              <div className="profile-menu">
                <div className="profile-menu__identity">
                  <strong>{user?.displayName || "Guest"}</strong>
                  <span>{user?.email || user?.handle || "当前账号"}</span>
                </div>
                <button
                  className="profile-menu__item profile-menu__item--danger"
                  onClick={() => {
                    setShowProfileMenu(false);
                    logout();
                  }}
                >
                  退出登录
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="domain-card">
          <div className="domain-card__header">
            <div>
              <h1>{bootstrap?.domain.name || "Oopz Live"}</h1>
              <div className="domain-id-row">
                <span>ID: {bootstrap?.domain.id || "--"}</span>
                <button className="tiny-icon-button" title="复制域 ID" aria-label="复制域 ID">
                  <CopyIcon />
                </button>
              </div>
            </div>
            <button className="tiny-icon-button" title="更多选项" aria-label="更多选项">
              <MoreIcon />
            </button>
          </div>
          <div className="domain-banner">
            <div className="domain-banner__badge">{bootstrap?.domain.name || "Oopz"}</div>
          </div>
          <button
            className={`home-button ${activeChannel?.id === firstTextChannel?.id ? "home-button--active" : ""}`}
            onClick={() => (firstTextChannel ? void selectChannel(firstTextChannel) : undefined)}
          >
            <HomeIcon />
            <span>主页</span>
          </button>
          {canManageDomain ? (
            <div className="domain-owner-actions">
              <button className="action-pill" onClick={() => setChannelComposerType("text")}>
                + 文字频道
              </button>
              <button className="action-pill" onClick={() => setChannelComposerType("voice")}>
                + 语音频道
              </button>
              <button className="action-pill" onClick={() => setChannelComposerType("screening")}>
                + 放映室
              </button>
            </div>
          ) : null}
        </div>

        <section className="channel-list-section">
          <div className="channel-tree">
            {categories.map((category) => (
              <div key={category.id} className="channel-group">
                <div className="channel-group__title">{category.name}</div>
                {category.channels.map((channel) => (
                  <div key={channel.id} className="channel-item-wrap">
                    <button
                      className={`channel-item ${
                        channel.type === "text"
                          ? activeChannel?.id === channel.id
                            ? "channel-item--active"
                            : ""
                          : currentVoiceChannelId === channel.id || voiceTargetChannelId === channel.id
                            ? "channel-item--active"
                            : ""
                      }`}
                      onClick={() => void selectChannel(channel)}
                      onDoubleClick={() => void enterVoiceChannel(channel)}
                    >
                      <span>
                        {channel.type === "voice" ? <VoiceChannelIcon /> : channel.type === "screening" ? <PlayIcon /> : <HashIcon />}
                      </span>
                      <span className="channel-item__name">{channel.name}</span>
                      {channel.type === "voice" ? (
                        <span className="channel-item__meta">
                          {onlineCounts[String(channel.id)] || 0}/{channel.maxMembers}
                        </span>
                      ) : null}
                    </button>
                    {channel.type === "voice" && (voiceChannelMembers[String(channel.id)] || []).length ? (
                      <div className="channel-presence-list">
                        {(voiceChannelMembers[String(channel.id)] || []).slice(0, 4).map((member) => (
                          <div key={member.user.id} className="channel-presence-pill">
                            <div className="channel-presence-pill__avatar" style={{ background: member.user.avatarColor }}>
                              {initials(member.user.displayName)}
                            </div>
                            <span>{member.user.displayName}</span>
                          </div>
                        ))}
                        {(voiceChannelMembers[String(channel.id)] || []).length > 4 ? (
                          <div className="channel-presence-more">+{(voiceChannelMembers[String(channel.id)] || []).length - 4}</div>
                        ) : null}
                      </div>
                    ) : channel.type === "screening" && (screeningChannelMembers[String(channel.id)] || []).length ? (
                      <div className="channel-presence-list">
                        {(screeningChannelMembers[String(channel.id)] || []).slice(0, 4).map((member) => (
                          <div key={member.id} className="channel-presence-pill">
                            <div className="channel-presence-pill__avatar" style={{ background: member.avatarColor }}>
                              {initials(member.displayName)}
                            </div>
                            <span>{member.displayName}</span>
                          </div>
                        ))}
                        {(screeningChannelMembers[String(channel.id)] || []).length > 4 ? (
                          <div className="channel-presence-more">+{(screeningChannelMembers[String(channel.id)] || []).length - 4}</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      </aside>
    </>
  );
}

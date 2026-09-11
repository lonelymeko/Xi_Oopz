import { useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";

import { useSpeakingState } from "../../hooks/useSpeakingState";
import type { DomainMember, OnlineUserPresence, PeerConnectionDiagnostics, PresenceMember, RemoteMedia, User } from "../../types";
import { formatPeerDiagnostics, initials } from "../../utils/live";
import type { ScreenPreview } from "../../types/live";
import { ScreenShareIcon } from "./icons";

/**
 * 成员列表区块与成员行组件。
 */
/**
 * 成员分组渲染组件。
 */
export function MemberSection({
  title,
  members,
  voiceMembers,
  onlineUsers,
  channelNameById,
  showCount = true,
  localAudioStream,
  remoteMedia,
  currentUserId = 0,
  currentUserMicEnabled = true,
  showVoiceState = false,
  peerDiagnostics,
}: {
  title: string;
  members: DomainMember[];
  voiceMembers: Map<number, PresenceMember>;
  onlineUsers: Map<number, OnlineUserPresence>;
  channelNameById: Map<number, string>;
  showCount?: boolean;
  localAudioStream?: MediaStream | null;
  remoteMedia?: Map<number, RemoteMedia>;
  currentUserId?: number;
  currentUserMicEnabled?: boolean;
  showVoiceState?: boolean;
  peerDiagnostics: Map<number, PeerConnectionDiagnostics>;
}) {
  const sortedMembers = [...members].sort((left, right) => {
    if (left.role !== right.role) {
      if (left.role === "owner") return -1;
      if (right.role === "owner") return 1;
    }
    return left.displayName.localeCompare(right.displayName, "zh-CN");
  });

  return (
    <section className="member-section">
      <h4>{showCount ? `${title} · ${members.length}` : title}</h4>
      {members.length ? (
        sortedMembers.map((member) => {
          const presence = voiceMembers.get(member.id);
          const online = onlineUsers.get(member.id);
          return (
            <MemberRowItem
              key={member.id}
              member={member}
              presence={presence}
              online={online}
              channelNameById={channelNameById}
              localAudioStream={localAudioStream || null}
              remoteMedia={remoteMedia || null}
              currentUserId={currentUserId}
              currentUserMicEnabled={currentUserMicEnabled}
              showVoiceState={showVoiceState}
              diagnostics={peerDiagnostics.get(member.id)}
            />
          );
        })
      ) : (
        <div className="empty-state empty-state--small">暂无成员</div>
      )}
    </section>
  );
}

/**
 * 单个成员行渲染组件。
 */
export function MemberRowItem({
  member,
  presence,
  online,
  channelNameById,
  localAudioStream,
  remoteMedia,
  currentUserId,
  currentUserMicEnabled,
  showVoiceState,
  diagnostics,
}: {
  member: DomainMember;
  presence?: PresenceMember;
  online?: OnlineUserPresence;
  channelNameById: Map<number, string>;
  localAudioStream: MediaStream | null;
  remoteMedia: Map<number, RemoteMedia> | null;
  currentUserId: number;
  currentUserMicEnabled: boolean;
  showVoiceState: boolean;
  diagnostics?: PeerConnectionDiagnostics;
}) {
  const stream = member.id === currentUserId ? localAudioStream : remoteMedia?.get(member.id)?.audioStream || null;
  const micState = member.id === currentUserId ? currentUserMicEnabled : Boolean(presence?.micEnabled);
  const speaking = useSpeakingState(stream, micState);

  return (
    <div className="member-row">
      <div className={`avatar ${speaking ? "avatar--speaking" : ""}`} style={{ background: member.avatarColor }}>
        {initials(member.displayName)}
      </div>
      <div className="member-row__content">
        <strong>
          {member.displayName}
          {member.role === "owner" ? <span className="member-role-badge">域主</span> : null}
        </strong>
        <span>
          {showVoiceState && presence
            ? `${micState ? "开麦" : "静音"}${online ? ` · 域 ${online.domainId} · 正在 ${channelNameById.get(presence.channelId) || "房间"}` : ""}`
            : presence
              ? `${online?.domainId ? `域 ${online.domainId}` : "当前域"} · 正在 ${channelNameById.get(presence.channelId) || "语音频道"}`
              : online
                ? online.currentChannelId
                  ? `域 ${online.domainId} · 正在 ${channelNameById.get(online.currentChannelId) || "语音频道"}`
                  : `域 ${online.domainId} · 在线`
                : "离线"}
        </span>
        {diagnostics ? <span className="member-row__diagnostics">{formatPeerDiagnostics(diagnostics)}</span> : null}
      </div>
    </div>
  );
}

/**
 * 语音头像卡片：只显示头像 + 说话高亮 + 共享角标。
 * 共享时**不再把头像换成播放画面**——共享画面统一在列表上方的 ScreenStage 展示，
 * 点击正在共享的人的头像即选中他的共享。
 */
export function VoiceAvatarOrb({
  user,
  stream,
  micEnabled,
  screenSharing,
  isCurrentUser,
  diagnostics,
  onSelectShare,
  activeShare,
}: {
  user: User;
  stream: MediaStream | null;
  micEnabled: boolean;
  screenSharing: boolean;
  isCurrentUser: boolean;
  diagnostics?: PeerConnectionDiagnostics;
  onSelectShare?: () => void;
  activeShare?: boolean;
}) {
  const speaking = useSpeakingState(stream, micEnabled);
  const selectable = screenSharing && Boolean(onSelectShare);

  return (
    <div className={`voice-orb ${screenSharing ? "voice-orb--sharing" : ""} ${activeShare ? "voice-orb--active" : ""}`}>
      <div
        className={`voice-orb__button ${selectable ? "voice-orb__button--preview" : ""}`}
        onClick={selectable ? onSelectShare : undefined}
        role={selectable ? "button" : undefined}
        tabIndex={selectable ? 0 : undefined}
        title={selectable ? `查看 ${user.displayName} 的共享` : undefined}
        onKeyDown={
          selectable
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectShare?.();
                }
              }
            : undefined
        }
      >
        <div
          className={`voice-orb__avatar ${speaking ? "voice-orb__avatar--speaking" : ""} ${screenSharing ? "voice-orb__avatar--sharing" : ""}`}
          style={{ background: user.avatarColor }}
        >
          {initials(user.displayName)}
          {screenSharing ? (
            <span className="voice-orb__share-badge" title="正在共享屏幕">
              <ScreenShareIcon />
            </span>
          ) : null}
        </div>
      </div>
      <strong>{user.displayName}</strong>
      <span>
        {screenSharing
          ? isCurrentUser
            ? "你 · 正在共享"
            : "正在共享，点头像查看"
          : isCurrentUser
            ? micEnabled
              ? "你 · 麦克风开启"
              : "你 · 已静音"
            : micEnabled
              ? "麦克风开启"
              : "已静音"}
      </span>
      {diagnostics ? <span className="voice-orb__diagnostics">{formatPeerDiagnostics(diagnostics)}</span> : null}
    </div>
  );
}

/**
 * 共享视频舞台：语音区上方展示当前选中的共享画面，点"放大查看"走全屏弹层。
 */
export function ScreenStage({
  stream,
  title,
  onMaximize,
}: {
  stream: MediaStream;
  title: string;
  onMaximize?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.srcObject !== stream) {
      element.srcObject = stream;
    }
    element.muted = true;
    element.playsInline = true;
    void element.play().catch(() => undefined);
  }, [stream]);

  return (
    <div className="screen-stage">
      <div className="screen-stage__bar">
        <span className="screen-stage__title">{title}</span>
        {onMaximize ? (
          <button className="action-pill" onClick={onMaximize}>
            放大查看
          </button>
        ) : null}
      </div>
      <div className="screen-stage__view">
        <video ref={videoRef} autoPlay playsInline muted className="screen-stage__video" />
      </div>
    </div>
  );
}

/**
 * 远端音频承载层，负责挂载远端音频流。
 */
export function RemoteAudioLayer({
  remoteMedia,
  selfUserId,
  deafened,
  remoteVolume,
}: {
  remoteMedia: Map<number, RemoteMedia>;
  selfUserId: number;
  deafened: boolean;
  remoteVolume: number;
}) {
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());

  useEffect(() => {
    const activeIds = new Set<string>();

    remoteMedia.forEach((entry, userId) => {
      if (userId === selfUserId) return;
      const streams = [
        { key: `${userId}:voice`, stream: entry.audioStream },
        { key: `${userId}:screen`, stream: entry.displayAudioStream },
      ];
      streams.forEach(({ key, stream }) => {
        if (!stream) return;
        activeIds.add(key);
        const element = audioRefs.current.get(key);
        if (!element) return;
        if (element.srcObject !== stream) {
          element.srcObject = stream;
        }
        element.muted = deafened;
        element.volume = Math.max(0, Math.min(1, remoteVolume / 100));
        void element.play().catch((error) => {
          console.error("remote audio play failed", error);
        });
      });
    });

    audioRefs.current.forEach((element, key) => {
      if (activeIds.has(key)) return;
      element.pause();
      element.srcObject = null;
    });
  }, [deafened, remoteMedia, remoteVolume, selfUserId]);

  return (
    <div className="remote-audio-layer" aria-hidden="true">
      {[...remoteMedia.entries()].flatMap(([userId]) => [
        <audio
          key={`${userId}:voice`}
          ref={(node) => {
            if (node) {
              audioRefs.current.set(`${userId}:voice`, node);
            } else {
              audioRefs.current.delete(`${userId}:voice`);
            }
          }}
          autoPlay
          playsInline
        />,
        <audio
          key={`${userId}:screen`}
          ref={(node) => {
            if (node) {
              audioRefs.current.set(`${userId}:screen`, node);
            } else {
              audioRefs.current.delete(`${userId}:screen`);
            }
          }}
          autoPlay
          playsInline
        />,
      ])}
    </div>
  );
}

/**
 * 屏幕预览弹层组件。
 */
export function ScreenPreviewModal({ screen, onClose }: { screen: ScreenPreview; onClose: () => void }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = screen.stream;
    void videoRef.current.play().catch(() => undefined);
  }, [screen.stream]);

  // 同一个分享可能是手机竖屏投屏（如 9:19.5），也可能是桌面横屏。用视频真实尺寸驱动
  // 舞台容器的长宽比，避免把竖屏画面硬塞进固定 16:9 弹窗、四周留下大面积黑边。
  function syncAspect(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setAspect(video.videoWidth / video.videoHeight);
    }
  }

  async function openSystemFullscreen() {
    if (!frameRef.current) return;
    try {
      await frameRef.current.requestFullscreen();
    } catch (error) {
      console.error(error);
    }
  }

  return (
    <div className="screen-modal">
      <div className="screen-modal__panel" ref={frameRef}>
        <div className="screen-modal__toolbar">
          <div>
            <div className="eyebrow">SCREEN PREVIEW</div>
            <strong>
              {screen.user.displayName}
              {screen.isLocal ? " · 你的共享屏幕" : " · 正在共享屏幕"}
            </strong>
          </div>
          <div className="screen-modal__actions">
            <button className="action-pill" onClick={() => void openSystemFullscreen()}>
              系统全屏
            </button>
            <button className="action-pill" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <div
          className="screen-modal__stage"
          style={aspect ? ({ "--screen-aspect": String(aspect) } as CSSProperties) : undefined}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onLoadedMetadata={syncAspect}
            onResize={syncAspect}
            className="screen-modal__video"
          />
        </div>
      </div>
    </div>
  );
}

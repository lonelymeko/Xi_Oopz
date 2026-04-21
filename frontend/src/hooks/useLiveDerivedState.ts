import { useMemo } from "react";

import type {
  BootstrapResponse,
  Channel,
  DomainMember,
  OnlineUserPresence,
  PresenceMember,
  RemoteMedia,
  ScreeningSnapshot,
  User,
} from "../types";
import type { ScreenPreview } from "../types/live";

/**
 * 派生视图状态 Hook 参数。
 */
type UseLiveDerivedStateOptions = {
  bootstrap: BootstrapResponse | null;
  activeChannel: Channel | null;
  currentVoiceChannelId: number | null;
  voiceChannelMembers: Record<string, PresenceMember[]>;
  voiceMembers: Map<number, PresenceMember>;
  onlineUsers: Map<number, OnlineUserPresence>;
  screeningSnapshot: ScreeningSnapshot | null;
  user: User | null;
  localScreenStream: MediaStream | null;
  remoteMedia: Map<number, RemoteMedia>;
  maximizedScreenKey: string | null;
};

/**
 * 派生视图状态 Hook：集中计算页面渲染所需的派生数据。
 */
export function useLiveDerivedState(options: UseLiveDerivedStateOptions) {
  const {
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
  } = options;

  const categories = useMemo(() => bootstrap?.categories || [], [bootstrap?.categories]);
  const allChannels = useMemo(() => categories.flatMap((category) => category.channels), [categories]);
  const firstTextChannel = useMemo(() => allChannels.find((channel) => channel.type === "text") || null, [allChannels]);
  const currentVoiceChannel = useMemo(
    () => allChannels.find((channel) => channel.id === currentVoiceChannelId) || null,
    [allChannels, currentVoiceChannelId],
  );
  const chatChannel = useMemo(
    () => (activeChannel && activeChannel.type !== "voice" ? activeChannel : firstTextChannel),
    [activeChannel, firstTextChannel],
  );
  const activeScreeningChannel = useMemo(() => (activeChannel?.type === "screening" ? activeChannel : null), [activeChannel]);
  const selectedVoiceCount = useMemo(
    () => (currentVoiceChannelId ? (voiceChannelMembers[String(currentVoiceChannelId)] || []).length || voiceMembers.size : 0),
    [currentVoiceChannelId, voiceChannelMembers, voiceMembers.size],
  );
  const canManageDomain = bootstrap?.currentRole === "owner";

  const onlineMemberIds = useMemo(() => new Set(onlineUsers.keys()), [onlineUsers]);
  const screeningViewerIds = useMemo(
    () => new Set((screeningSnapshot?.viewers || []).map((viewer) => viewer.user.id)),
    [screeningSnapshot?.viewers],
  );

  const screeningViewerMembers: DomainMember[] = useMemo(
    () => (activeScreeningChannel ? (bootstrap?.members || []).filter((member) => screeningViewerIds.has(member.id)) : []),
    [activeScreeningChannel, bootstrap?.members, screeningViewerIds],
  );
  const onlineMembers = useMemo(
    () => (bootstrap?.members || []).filter((member) => onlineMemberIds.has(member.id) && !screeningViewerIds.has(member.id)),
    [bootstrap?.members, onlineMemberIds, screeningViewerIds],
  );
  const offlineMembers = useMemo(
    () => (bootstrap?.members || []).filter((member) => !onlineMemberIds.has(member.id)),
    [bootstrap?.members, onlineMemberIds],
  );

  const screenPreviews: ScreenPreview[] = useMemo(() => {
    const previews: ScreenPreview[] = [];
    if (user && localScreenStream) {
      previews.push({ key: `local-${user.id}`, user, stream: localScreenStream, isLocal: true });
    }
    [...remoteMedia.values()].forEach((entry) => {
      if (!entry.screenStream) return;
      previews.push({ key: `remote-${entry.user.id}`, user: entry.user, stream: entry.screenStream, isLocal: false });
    });
    return previews;
  }, [localScreenStream, remoteMedia, user]);

  const screenPreviewKeys = useMemo(() => screenPreviews.map((item) => item.key), [screenPreviews]);
  const maximizedScreen = useMemo(
    () => screenPreviews.find((item) => item.key === maximizedScreenKey) || null,
    [maximizedScreenKey, screenPreviews],
  );

  const voiceMembersList = useMemo(
    () =>
      [...voiceMembers.values()].sort((left, right) => {
        if (left.user.id === user?.id) return -1;
        if (right.user.id === user?.id) return 1;
        if (left.screenSharing !== right.screenSharing) {
          return Number(right.screenSharing) - Number(left.screenSharing);
        }
        return left.user.displayName.localeCompare(right.user.displayName, "zh-CN");
      }),
    [user?.id, voiceMembers],
  );

  const channelNameById = useMemo(() => {
    const map = new Map<number, string>();
    categories.forEach((category) => {
      category.channels.forEach((channel) => {
        map.set(channel.id, channel.name);
      });
    });
    return map;
  }, [categories]);

  return {
    categories,
    firstTextChannel,
    currentVoiceChannel,
    chatChannel,
    activeScreeningChannel,
    selectedVoiceCount,
    canManageDomain,
    screeningViewerMembers,
    onlineMembers,
    offlineMembers,
    screenPreviews,
    screenPreviewKeys,
    maximizedScreen,
    voiceMembersList,
    channelNameById,
  };
}

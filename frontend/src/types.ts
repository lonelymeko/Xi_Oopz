export type User = {
  id: number;
  handle: string;
  displayName: string;
  email?: string;
  avatarColor: string;
  isGuest: boolean;
  createdAt: string;
};

export type Domain = {
  id: number;
  slug: string;
  name: string;
  description: string;
  accentColor: string;
  createdAt: string;
};

export type DomainSummary = Domain & {
  role: string;
};

export type Channel = {
  id: number;
  domainId: number;
  categoryId?: number;
  name: string;
  type: "text" | "voice" | "screening";
  topic: string;
  position: number;
  maxMembers: number;
};

export type ChannelCategory = {
  id: number;
  domainId: number;
  name: string;
  position: number;
  channels: Channel[];
};

export type DomainMember = User & {
  role: string;
};

export type Message = {
  id: number;
  domainId: number;
  channelId: number;
  userId?: number;
  userDisplayName: string;
  userAvatarColor: string;
  messageType: "chat" | "system";
  body: string;
  metadata?: string;
  createdAt: string;
};

export type PresenceMember = {
  user: User;
  channelId: number;
  micEnabled: boolean;
  screenSharing: boolean;
};

export type OnlineUserPresence = {
  user: User;
  domainId: number;
  currentChannelId: number;
};

export type DomainPresenceResponse = {
  onlineUsers: OnlineUserPresence[];
  voiceMembers: Record<string, PresenceMember[]>;
  screeningMembers: Record<string, ScreeningViewer[]>;
  onlineCounts: Record<string, number>;
};

export type BootstrapResponse = {
  user: User;
  domain: Domain;
  domains: DomainSummary[];
  currentRole: string;
  categories: ChannelCategory[];
  members: DomainMember[];
  messages: Message[];
  onlineCounts: Record<string, number>;
  selectedChannelId: number;
  activeChannel: Channel;
  stunServers: RTCIceServer[];
};

export type ScreeningViewer = {
  user: User;
  ready: boolean;
  joinedAt: string;
  lastPingAt: string;
};

export type ScreeningPlaylistItem = {
  itemId: string;
  url: string;
  title: string;
  addedBy: number;
  addedAt: string;
};

export type ScreeningState = {
  channelId: number;
  controllerUserId: number;
  currentItemId: string;
  currentUrl: string;
  currentTitle: string;
  playbackState: "idle" | "loading" | "ready" | "playing" | "paused" | "ended";
  currentTime: number;
  playbackRate: number;
  updatedAt: string;
  startedAt: string;
  awaitingReady: boolean;
  syncToken: number;
};

export type ScreeningSnapshot = {
  state: ScreeningState;
  viewers: ScreeningViewer[];
  playlist: ScreeningPlaylistItem[];
};

export type RemoteMedia = {
  user: User;
  audioStream: MediaStream | null;
  displayAudioStream: MediaStream | null;
  screenStream: MediaStream | null;
};

export type PeerConnectionDiagnostics = {
  userId: number;
  latencyMs: number | null;
  transport: "lan" | "stun" | "turn" | "unknown";
  retryCount: number;
  recoveryMode: "stable" | "ice-restart" | "relay";
  updatedAt: number;
};

export type AuthResponse = {
  token: string;
  user: User;
};

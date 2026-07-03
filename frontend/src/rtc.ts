import type { DomainMember, PeerConnectionDiagnostics, PresenceMember, RemoteMedia, User } from "./types";
import { SocketClient } from "./socket";

type PeerWrapper = {
  user: User;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  initialOfferOwner: boolean;
  hasBoundLocalTracks: boolean;
  pendingIceCandidates: RTCIceCandidateInit[];
  audioTransceiver: RTCRtpTransceiver;
  displayAudioTransceiver: RTCRtpTransceiver;
  screenTransceiver: RTCRtpTransceiver;
  reconnectAttempts: number;
  reconnectTimer: number | null;
  reconnecting: boolean;
  createdAt: number;
  useRelayOnly: boolean;
  lastKnownTransport: PeerConnectionDiagnostics["transport"];
  statsTimer: number | null;
  stableTimer: number | null;
  outboundRehydrateTimers: number[];
};

type SignalPayload = {
  sourceUserId: number;
  targetUserId: number;
  sdp?: string;
  candidate?: string;
  kind?: "audio" | "screen";
  reason?: string;
  relayOnly?: boolean;
};

type MediaSyncKind = "audio" | "screen";

export type ScreenShareSurface = "tab" | "screen";
export type ScreenAudioMode = "off" | "share";
export type ScreenShareOptions = {
  surface: ScreenShareSurface;
  audioMode: ScreenAudioMode;
};
export class RTCController {
  private static readonly MEDIA_RECONNECT_DELAY_MS = 1500;
  private static readonly MEDIA_RECONNECT_MAX_ATTEMPTS = 5;
  private static readonly PEER_DISCONNECT_GRACE_MS = 5000;
  private static readonly PEER_RECONNECT_DELAY_MS = 2000;
  private static readonly PEER_RECONNECT_MAX_ATTEMPTS = 4;
  private static readonly TURN_DISCONNECT_GRACE_MS = 1000;
  private static readonly ICE_RESTART_TIMEOUT_MS = 4000;
  private static readonly PEER_STATS_INTERVAL_MS = 3000;
  private static readonly ICE_GATHERING_EVAL_DELAY_MS = 800;
  private static readonly PEER_STABLE_RESET_MS = 8000;
  private static readonly OUTBOUND_REHYDRATE_DELAYS_MS = [300, 1200];
  private static readonly PEER_ESTABLISH_GRACE_MS = 8000;
  private static readonly ESTABLISH_REEVAL_DELAY_MS = 2000;
  private static readonly RESET_GLARE_WINDOW_MS = 3000;
  private static readonly POLITE_RECREATE_EXTRA_DELAY_MS = 1500;
  private static readonly MAX_PEER_REBUILDS = 3;
  private static readonly OUTAGE_NOTICE_INTERVAL_MS = 30000;

  private localAudioStream: MediaStream | null = null;
  private localMicStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;
  private prewarmedAudioStream: MediaStream | null = null;
  private audioAcquirePromise: Promise<MediaStream> | null = null;
  private prewarmReleaseTimer: number | null = null;
  private peers = new Map<number, PeerWrapper>();
  private peerEnsurePromises = new Map<number, Promise<PeerWrapper>>();
  private remoteMedia = new Map<number, RemoteMedia>();
  private mediaReconnectAttempts = new Map<string, number>();
  private mediaReconnectTimers = new Map<string, number>();
  private peerDisconnectTimers = new Map<number, number>();
  private peerRebuildCounts = new Map<number, number>();
  private failedPeers = new Set<number>();
  private lastResetSentAt = new Map<number, number>();
  private outageNoticeAt = new Map<number, number>();
  private audioInputDeviceId = "";
  private noiseSuppressionEnabled = true;
  private micEnabled = true;
  private screenAudioEnabled = false;
  private voiceSessionActive = false;
  private mixContext: AudioContext | null = null;
  private mixDestination: MediaStreamAudioDestinationNode | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micGainNode: GainNode | null = null;
  private screenSourceNode: MediaStreamAudioSourceNode | null = null;
  private screenGainNode: GainNode | null = null;

  private log(_label: string, _extra?: Record<string, unknown>) {}

  constructor(
    private readonly socket: SocketClient,
    private readonly getCurrentVoiceChannelId: () => number | null,
    private readonly getCurrentUser: () => User | null,
    private readonly getMembers: () => DomainMember[],
    private readonly getVoiceMembers: () => Map<number, PresenceMember>,
    private readonly getIceServers: () => RTCIceServer[],
    private readonly onMediaChanged: (media: Map<number, RemoteMedia>) => void,
    private readonly onDiagnosticsChanged: (diagnostics: Map<number, PeerConnectionDiagnostics>) => void,
    private readonly onLocalAudioChanged: (stream: MediaStream | null) => void,
    private readonly onLocalScreenChanged: (stream: MediaStream | null) => void,
    private readonly onNotice: (kind: "info" | "error", title: string, message: string) => void,
  ) {}

  private diagnostics = new Map<number, PeerConnectionDiagnostics>();

  async joinVoice(channelId: number) {
    const startedAt = performance.now();
    this.voiceSessionActive = true;
    this.log("joinVoice:start", { channelId });
    this.log("ice:config", {
      channelId,
      all: this.describeIceServers(this.getIceServers()),
      relay: this.describeIceServers(this.getRelayIceServers()),
    });
    await this.ensureAudio();
    this.log("joinVoice:audio-ready", { channelId, elapsedMs: Math.round(performance.now() - startedAt) });
    this.socket.send("channel.join", { channelId });
    this.log("joinVoice:channel.join-sent", { channelId, elapsedMs: Math.round(performance.now() - startedAt) });
  }

  async leaveVoice() {
    const startedAt = performance.now();
    this.voiceSessionActive = false;
    this.log("leaveVoice:start", { channelId: this.getCurrentVoiceChannelId() });
    this.socket.send("channel.leave", { channelId: this.getCurrentVoiceChannelId() });
    this.closeAllPeers();
    this.teardownAudioMix();
    this.stopTrackGroup(this.localAudioStream);
    this.stopTrackGroup(this.localMicStream);
    this.stopTrackGroup(this.prewarmedAudioStream);
    this.stopTrackGroup(this.localScreenStream);
    this.localAudioStream = null;
    this.localMicStream = null;
    this.prewarmedAudioStream = null;
    this.localScreenStream = null;
    this.screenAudioEnabled = false;
    this.peerEnsurePromises.clear();
    this.clearPrewarmReleaseTimer();
    this.onLocalAudioChanged(null);
    this.onLocalScreenChanged(null);
    this.log("leaveVoice:completed", { elapsedMs: Math.round(performance.now() - startedAt) });
  }

  async toggleMic(enabled: boolean) {
    this.micEnabled = enabled;
    await this.syncLocalAudioState();
    await this.refreshLocalTracksOnPeers();
  }

  async setAudioInputDevice(deviceId: string) {
    if (this.audioInputDeviceId === deviceId) {
      return;
    }
    this.audioInputDeviceId = deviceId;
    this.discardPrewarmedAudio("device-changed");
    if (!this.localAudioStream) return;
    await this.refreshAudioInput();
  }

  async setNoiseSuppression(enabled: boolean) {
    if (this.noiseSuppressionEnabled === enabled) {
      return;
    }
    this.noiseSuppressionEnabled = enabled;
    this.discardPrewarmedAudio("noise-suppression-changed");
    if (!this.localAudioStream) return;
    await this.refreshAudioInput();
  }

  async prewarmAudio() {
    try {
      const stream = await this.getOrAcquireAudioStream();
      if (this.localAudioStream) {
        return this.localAudioStream;
      }
      if (this.prewarmedAudioStream && this.prewarmedAudioStream !== stream) {
        this.stopTrackGroup(stream);
        this.schedulePrewarmRelease();
        return this.prewarmedAudioStream;
      }
      this.prewarmedAudioStream = stream;
      this.schedulePrewarmRelease();
      return stream;
    } catch (error) {
      throw error;
    }
  }

  primePrewarmedAudio(stream: MediaStream) {
    if (this.localAudioStream === stream || this.prewarmedAudioStream === stream) {
      this.clearPrewarmReleaseTimer();
      return;
    }
    if (this.prewarmedAudioStream && this.prewarmedAudioStream !== stream) {
      this.stopTrackGroup(this.prewarmedAudioStream);
    }
    this.prewarmedAudioStream = stream;
    this.clearPrewarmReleaseTimer();
    this.schedulePrewarmRelease();
  }

  async startScreenShare(options: ScreenShareOptions) {
    if (this.localScreenStream) return;
    const supported = navigator.mediaDevices.getSupportedConstraints() as MediaTrackSupportedConstraints & {
      restrictOwnAudio?: boolean;
    };
    const shareAudio = options.audioMode === "share";
    const displayOptions: Record<string, unknown> = {
      video: true,
      audio: false,
    };

    if (options.surface === "tab") {
      displayOptions.preferCurrentTab = true;
      displayOptions.selfBrowserSurface = "include";
      displayOptions.systemAudio = "exclude";
      if (shareAudio) {
        const audioConstraints: Record<string, unknown> = {
          suppressLocalAudioPlayback: true,
        };
        if (supported.restrictOwnAudio) {
          audioConstraints.restrictOwnAudio = true;
        }
        displayOptions.audio = audioConstraints;
      }
    } else {
      displayOptions.selfBrowserSurface = "exclude";
      displayOptions.systemAudio = shareAudio ? "include" : "exclude";
      if (shareAudio) {
        const audioConstraints: Record<string, unknown> = {
          suppressLocalAudioPlayback: true,
        };
        if (supported.restrictOwnAudio) {
          audioConstraints.restrictOwnAudio = true;
        }
        displayOptions.audio = audioConstraints;
      }
    }

    this.localScreenStream = await navigator.mediaDevices.getDisplayMedia(displayOptions as DisplayMediaStreamOptions);
    this.onLocalScreenChanged(this.localScreenStream);
    this.screenAudioEnabled = this.hasLiveScreenAudio();

    const [screenTrack] = this.localScreenStream.getVideoTracks();
    screenTrack?.addEventListener("ended", () => {
      void this.stopScreenShare(true);
    });

    this.localScreenStream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        this.screenAudioEnabled = this.hasLiveScreenAudio();
        void this.syncLocalAudioState();
      });
    });

    await this.syncLocalAudioState();
    await this.applyLocalTracksToAllPeers();
  }

  async stopScreenShare(notifyServer: boolean) {
    if (!this.localScreenStream) return;
    this.stopTrackGroup(this.localScreenStream);
    this.localScreenStream = null;
    this.screenAudioEnabled = false;
    this.onLocalScreenChanged(null);
    await this.syncLocalAudioState();
    await this.applyLocalTracksToAllPeers();

    if (notifyServer && this.getCurrentVoiceChannelId()) {
      this.socket.send("screen.state", {
        channelId: this.getCurrentVoiceChannelId(),
        screenSharing: false,
      });
    }
  }

  async handlePresenceSnapshot(members: PresenceMember[]) {
    if (!this.voiceSessionActive) return;
    const startedAt = performance.now();
    const selfId = this.getCurrentUser()?.id;
    const seen = new Set<number>();

    for (const member of members) {
      if (member.user.id === selfId) continue;
      seen.add(member.user.id);
      if (this.failedPeers.has(member.user.id)) continue;
      const shouldOffer = selfId != null && selfId < member.user.id;
      await this.ensurePeer(member.user, shouldOffer);
      this.ensureMediaFlow(member.user.id, "audio", "presence.snapshot");
      this.ensureMediaFlow(member.user.id, "screen", "presence.snapshot");
    }

    for (const [userId] of this.peers) {
      if (!seen.has(userId)) {
        this.handleMemberLeft(userId);
      }
    }

    this.log("joinVoice:audio-ready", { channelId: this.getCurrentVoiceChannelId(), elapsedMs: Math.round(performance.now() - startedAt) });
  }

  async handleMemberJoined(member: PresenceMember) {
    if (!this.voiceSessionActive) return;
    if (member.user.id === this.getCurrentUser()?.id) return;
    // 对方重新进入频道视为新一轮连接，解除历史重连失败标记
    this.failedPeers.delete(member.user.id);
    this.peerRebuildCounts.delete(member.user.id);
    const selfId = this.getCurrentUser()?.id;
    const shouldOffer = selfId != null && selfId < member.user.id;
    await this.ensurePeer(member.user, shouldOffer);
    this.ensureMediaFlow(member.user.id, "audio", "member.joined");
    this.ensureMediaFlow(member.user.id, "screen", "member.joined");
  }

  handleMemberLeft(userId: number) {
    if (!this.voiceSessionActive) return;
    this.failedPeers.delete(userId);
    this.peerRebuildCounts.delete(userId);
    this.outageNoticeAt.delete(userId);
    this.destroyPeer(userId);
  }

  async handleSignal(type: string, payload: SignalPayload) {
    if (!this.voiceSessionActive && type !== "rtc.reset") {
      return;
    }
    try {
      const peerUser = this.lookupUser(payload.sourceUserId);
      if (!peerUser) return;

      if (type === "rtc.reset") {
        if (!this.voiceSessionActive) {
          return;
        }
        // reset 对撞决胜：断线时双方常同时发起 recreate+reset，若不裁决会互相销毁
        // 对方刚重建好的 PeerConnection，形成 reset 乒乓。规则与完美协商一致：
        // impolite 方（id 小）刚发过 reset 时忽略对方的 reset，自己的重建胜出；
        // polite 方无条件服从对方的 reset。
        const selfIsImpolite = (this.getCurrentUser()?.id ?? 0) < peerUser.id;
        const sentAt = this.lastResetSentAt.get(peerUser.id);
        if (selfIsImpolite && sentAt != null && performance.now() - sentAt < RTCController.RESET_GLARE_WINDOW_MS) {
          this.log("reconnect:reset-glare-ignored", { userId: peerUser.id, reason: payload.reason || "remote-reset" });
          return;
        }
        this.log("reconnect:reset-received", { userId: peerUser.id, reason: payload.reason || "remote-reset", relayOnly: Boolean(payload.relayOnly) });
        await this.recreatePeer(peerUser.id, payload.reason || "remote-reset", false, Boolean(payload.relayOnly));
        return;
      }

      const wrapper = await this.ensurePeer(peerUser, false);

      if ((type === "screen.sync_request" && this.localScreenStream) || type === "media.sync_request") {
        const requestedKind: MediaSyncKind =
          type === "screen.sync_request" ? "screen" : payload.kind === "audio" ? "audio" : "screen";
        if (requestedKind === "screen" && !this.localScreenStream) {
          return;
        }
        await this.refreshLocalOutboundForNegotiation(wrapper);
        await this.sendOffer(wrapper);
        return;
      }

      if (type === "rtc.offer" && payload.sdp) {
        const readyForOffer =
          !wrapper.makingOffer &&
          (wrapper.pc.signalingState === "stable" || wrapper.isSettingRemoteAnswerPending);
        const offerCollision = !readyForOffer;

        wrapper.ignoreOffer = !wrapper.polite && offerCollision;
        if (wrapper.ignoreOffer) {
          this.log("signal:offer:ignored", { userId: wrapper.user.id });
          return;
        }

        wrapper.isSettingRemoteAnswerPending = false;
        await wrapper.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        await this.refreshLocalOutboundForNegotiation(wrapper);
        await this.flushPendingIceCandidates(wrapper);
        await wrapper.pc.setLocalDescription();
        this.socket.send("rtc.answer", {
          channelId: this.getCurrentVoiceChannelId(),
          targetUserId: payload.sourceUserId,
          sdp: wrapper.pc.localDescription?.sdp,
        });
        return;
      }

      if (type === "rtc.answer" && payload.sdp) {
        if (wrapper.pc.signalingState !== "have-local-offer") {
          this.log("signal:answer:ignored", {
            userId: wrapper.user.id,
            signalingState: wrapper.pc.signalingState,
          });
          return;
        }
        wrapper.isSettingRemoteAnswerPending = true;
        await wrapper.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        wrapper.isSettingRemoteAnswerPending = false;
        await this.flushPendingIceCandidates(wrapper);
        return;
      }

      if (type === "rtc.ice_candidate" && payload.candidate) {
        const candidate = JSON.parse(payload.candidate) as RTCIceCandidateInit;
        if (!wrapper.pc.remoteDescription) {
          wrapper.pendingIceCandidates.push(candidate);
          return;
        }
        await wrapper.pc.addIceCandidate(candidate);
      }
    } catch (error) {
      console.error(error);
      this.log("signal:error", {
        type,
        sourceUserId: payload.sourceUserId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureAudio() {
    if (this.localAudioStream) return this.localAudioStream;
    const startedAt = performance.now();
    this.log("ensureAudio:getUserMedia:start", {
      deviceId: this.audioInputDeviceId || "auto",
      noiseSuppressionEnabled: this.noiseSuppressionEnabled,
      hasPrewarmedStream: Boolean(this.prewarmedAudioStream),
    });
    this.localMicStream = await this.getOrAcquireAudioStream();
    if (this.prewarmedAudioStream === this.localMicStream) {
      this.log("ensureAudio:reused-prewarmed-stream");
      this.prewarmedAudioStream = null;
    }
    this.clearPrewarmReleaseTimer();
    await this.rebuildOutboundAudio();
    this.log("ensureAudio:getUserMedia:completed", { elapsedMs: Math.round(performance.now() - startedAt) });
    return this.localAudioStream;
  }

  private async refreshAudioInput() {
    const startedAt = performance.now();
    this.log("refreshAudioInput:start", {
      deviceId: this.audioInputDeviceId || "auto",
      noiseSuppressionEnabled: this.noiseSuppressionEnabled,
      peers: this.peers.size,
    });
    const nextStream = await this.acquireAudioStream();

    this.stopTrackGroup(this.localMicStream);
    this.localMicStream = nextStream;
    this.prewarmedAudioStream = null;
    this.clearPrewarmReleaseTimer();
    await this.rebuildOutboundAudio();

    await this.applyLocalTracksToAllPeers();
    this.log("refreshAudioInput:completed", { peers: this.peers.size, elapsedMs: Math.round(performance.now() - startedAt) });
  }

  private getOrAcquireAudioStream() {
    if (this.localMicStream) {
      return Promise.resolve(this.localMicStream);
    }
    if (this.prewarmedAudioStream) {
      return Promise.resolve(this.prewarmedAudioStream);
    }
    if (this.audioAcquirePromise) {
      return this.audioAcquirePromise;
    }
    const nextPromise = this.acquireAudioStream().finally(() => {
      if (this.audioAcquirePromise === nextPromise) {
        this.audioAcquirePromise = null;
      }
    });
    this.audioAcquirePromise = nextPromise;
    return nextPromise;
  }

  private async acquireAudioStream() {
    const startedAt = performance.now();
    const advancedConstraints = this.buildPreferredAudioConstraints();
    this.log("acquireAudioStream:advanced:start", {
      explicitDeviceId: this.getExplicitAudioDeviceId() || null,
      noiseSuppressionEnabled: this.noiseSuppressionEnabled,
    });

    return await new Promise<MediaStream>((resolve, reject) => {
      let settled = false;
      let fallbackStarted = false;
      let failures = 0;
      let lastError: unknown = null;
      let fallbackTimer: number | null = window.setTimeout(() => {
        fallbackTimer = null;
        startFallback("timeout");
      }, 1200);

      const finishWithSuccess = (source: "advanced" | "fallback", stream: MediaStream) => {
        if (settled) {
          this.stopTrackGroup(stream);
          return;
        }
        settled = true;
        if (fallbackTimer) {
          window.clearTimeout(fallbackTimer);
        }
        stream.getAudioTracks().forEach((track) => {
          track.enabled = this.micEnabled;
        });
        this.log(`acquireAudioStream:${source}:completed`, {
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        resolve(stream);
      };

      const finishWithFailure = (source: "advanced" | "fallback", error: unknown) => {
        lastError = error;
        failures += 1;
        this.log(`acquireAudioStream:${source}:failed`, {
          message: error instanceof Error ? error.message : String(error),
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        if (source === "advanced" && !fallbackStarted) {
          startFallback("advanced-failed");
          return;
        }
        if (settled) return;
        if ((fallbackStarted && failures >= 2) || (!fallbackStarted && failures >= 1)) {
          if (fallbackTimer) {
            window.clearTimeout(fallbackTimer);
          }
          reject(lastError instanceof Error ? lastError : new Error(String(lastError)));
        }
      };

      const startFallback = (reason: "timeout" | "advanced-failed") => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        if (fallbackTimer) {
          window.clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        this.log("acquireAudioStream:fallback:start", {
          reason,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        navigator.mediaDevices
          .getUserMedia({ audio: true, video: false })
          .then((stream) => finishWithSuccess("fallback", stream))
          .catch((error) => finishWithFailure("fallback", error));
      };

      navigator.mediaDevices
        .getUserMedia({
          audio: advancedConstraints,
          video: false,
        })
        .then((stream) => finishWithSuccess("advanced", stream))
        .catch((error) => finishWithFailure("advanced", error));
    });
  }

  private buildPreferredAudioConstraints(): MediaTrackConstraints {
    return {
      deviceId: this.getExplicitAudioDeviceId() ? { exact: this.getExplicitAudioDeviceId() } : undefined,
      noiseSuppression: this.noiseSuppressionEnabled,
      echoCancellation: true,
      autoGainControl: true,
    };
  }

  private getExplicitAudioDeviceId() {
    if (!this.audioInputDeviceId) return "";
    if (this.audioInputDeviceId === "default" || this.audioInputDeviceId === "communications") return "";
    return this.audioInputDeviceId;
  }

  private schedulePrewarmRelease() {
    this.clearPrewarmReleaseTimer();
    if (!this.prewarmedAudioStream || this.localAudioStream) return;
    this.prewarmReleaseTimer = window.setTimeout(() => {
      if (!this.prewarmedAudioStream || this.localAudioStream) return;
      this.stopTrackGroup(this.prewarmedAudioStream);
      this.prewarmedAudioStream = null;
      this.prewarmReleaseTimer = null;
    }, 30000);
  }

  private clearPrewarmReleaseTimer() {
    if (!this.prewarmReleaseTimer) return;
    window.clearTimeout(this.prewarmReleaseTimer);
    this.prewarmReleaseTimer = null;
  }

  private discardPrewarmedAudio(_reason: string) {
    if (!this.prewarmedAudioStream) return;
    this.stopTrackGroup(this.prewarmedAudioStream);
    this.prewarmedAudioStream = null;
    this.clearPrewarmReleaseTimer();
  }

  private ensureAudioMix() {
    if (this.mixContext && this.mixDestination) {
      return;
    }
    const Context = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) {
      throw new Error("当前浏览器不支持 Web Audio 混音");
    }
    this.mixContext = new Context();
    this.mixDestination = this.mixContext.createMediaStreamDestination();
    this.localAudioStream = this.mixDestination.stream;
    this.onLocalAudioChanged(this.localAudioStream);
  }

  private teardownAudioMix() {
    this.micSourceNode?.disconnect();
    this.micGainNode?.disconnect();
    this.screenSourceNode?.disconnect();
    this.screenGainNode?.disconnect();
    this.micSourceNode = null;
    this.micGainNode = null;
    this.screenSourceNode = null;
    this.screenGainNode = null;
    if (this.mixContext) {
      void this.mixContext.close().catch(() => undefined);
    }
    this.mixContext = null;
    this.mixDestination = null;
  }

  private hasLiveScreenAudio() {
    return Boolean(this.localScreenStream?.getAudioTracks().some((track) => track.readyState === "live"));
  }

  private updateMixGains() {
    if (this.micGainNode) {
      this.micGainNode.gain.value = this.micEnabled ? 1 : 0;
    }
    if (this.screenGainNode) {
      this.screenGainNode.gain.value = this.screenAudioEnabled ? 1 : 0;
    }
    this.localAudioStream?.getAudioTracks().forEach((track) => {
      track.enabled = this.micEnabled || this.screenAudioEnabled;
    });
  }

  private async rebuildOutboundAudio() {
    this.ensureAudioMix();
    if (!this.mixContext || !this.mixDestination) {
      return;
    }
    if (this.mixContext.state === "suspended") {
      await this.mixContext.resume().catch(() => undefined);
    }

    this.micSourceNode?.disconnect();
    this.micGainNode?.disconnect();
    this.screenSourceNode?.disconnect();
    this.screenGainNode?.disconnect();
    this.micSourceNode = null;
    this.micGainNode = null;
    this.screenSourceNode = null;
    this.screenGainNode = null;

    const micTrack = this.localMicStream?.getAudioTracks()[0] || null;
    if (micTrack) {
      micTrack.enabled = true;
      this.micSourceNode = this.mixContext.createMediaStreamSource(new MediaStream([micTrack]));
      this.micGainNode = this.mixContext.createGain();
      this.micSourceNode.connect(this.micGainNode);
      this.micGainNode.connect(this.mixDestination);
    }

    const screenTrack = this.localScreenStream?.getAudioTracks()[0] || null;
    this.screenAudioEnabled = Boolean(screenTrack && screenTrack.readyState === "live");
    if (screenTrack) {
      this.screenSourceNode = this.mixContext.createMediaStreamSource(new MediaStream([screenTrack]));
      this.screenGainNode = this.mixContext.createGain();
      this.screenSourceNode.connect(this.screenGainNode);
      this.screenGainNode.connect(this.mixDestination);
    }

    this.updateMixGains();
    this.onLocalAudioChanged(this.localAudioStream);
  }

  private async syncLocalAudioState() {
    const hasMic = Boolean(this.localMicStream?.getAudioTracks().some((track) => track.readyState === "live"));
    const hasMixedAudio = Boolean(this.localAudioStream?.getAudioTracks().some((track) => track.readyState === "live"));
    const hasScreenAudio = this.hasLiveScreenAudio();

    // 屏幕共享音频也是“本端正在发送的音频源”。之前这里只看麦克风和混音流，
    // 在“关麦但共享屏幕声音”的场景下，TURN 重连后的协商路径可能直接跳过
    // rebuildOutboundAudio()，导致对端连接恢复但收不到本端音频。
    if (!hasMic && !hasMixedAudio && !hasScreenAudio) {
      return;
    }
    await this.rebuildOutboundAudio();
    this.updateMixGains();
  }

  private async refreshLocalOutboundForNegotiation(wrapper: PeerWrapper) {
    // TURN 断线后重建 PeerConnection 时，ICE/DTLS 可能已经恢复，但 RTCRtpSender
    // 仍然持有断线前的旧 audio track，表现为“连接成功但单向无声”。用户手动关麦再开麦
    // 能恢复，就是因为 toggleMic 会重建 outbound audio 并 replaceTrack。这里在
    // offer/answer/recreate 前主动执行同等刷新，只刷新当前状态下应该发送的麦克风或
    // 屏幕共享音频，不改变用户的开麦/静音选择。
    await this.syncLocalAudioState();
    await this.bindLocalTracks(wrapper, true);
  }

  private async forceRefreshLocalOutboundAfterReconnect(wrapper: PeerWrapper, reason: string, renegotiate: boolean) {
    if (!this.voiceSessionActive || !this.peers.has(wrapper.user.id)) {
      return;
    }

    // TURN/ICE 重连后的强制发送端修复。
    //
    // 线上现象是：第二次重连后 PeerConnection 已经 connected，但电脑仍听不到手机；
    // 手机手动关麦再开麦后恢复。这个行为说明频道状态和信令不是根因，真正恢复声音的是
    // toggleMic 触发的 rebuildOutboundAudio + replaceTrack。重连流程里如果只在 offer/answer
    // 前刷新一次，时机可能早于浏览器底层 sender 重新可用，第二次 TURN 重连仍会留下
    // “sender.track 看起来存在，但 RTP 实际不发包”的状态。
    //
    // 因此 connected 后再延迟执行 force replace：先 replaceTrack(null)，再挂回当前最新的
    // 麦克风/屏幕共享混音轨和屏幕视频轨，强制浏览器重建发送管线。这里不调用 toggleMic，
    // 不改变用户静音状态；屏幕共享音频也通过 syncLocalAudioState() 纳入混音轨。
    await this.syncLocalAudioState();
    await this.bindLocalTracks(wrapper, true, { forceReplace: true });

    const channelId = this.getCurrentVoiceChannelId();
    if (channelId) {
      this.socket.send("voice.state", {
        channelId,
        micEnabled: this.micEnabled,
      });
      if (this.localScreenStream) {
        this.socket.send("screen.state", {
          channelId,
          screenSharing: true,
        });
      }
    }

    if (renegotiate && wrapper.initialOfferOwner && wrapper.pc.signalingState === "stable") {
      this.log("reconnect:outbound-rehydrate", { userId: wrapper.user.id, reason });
      await this.sendOffer(wrapper);
    }
  }

  private scheduleOutboundRehydrateAfterReconnect(wrapper: PeerWrapper, source: string) {
    if (!this.voiceSessionActive || !this.peers.has(wrapper.user.id)) {
      return;
    }

    // connectionState 和 iceConnectionState 在同一次恢复里可能连续触发。
    // 同一个 peer 只保留最新一轮延迟刷新，避免多轮 replaceTrack / offer 互相打架。
    this.clearOutboundRehydrateTimers(wrapper);
    wrapper.outboundRehydrateTimers = RTCController.OUTBOUND_REHYDRATE_DELAYS_MS.map((delayMs, index) =>
      window.setTimeout(() => {
        void this.forceRefreshLocalOutboundAfterReconnect(
          wrapper,
          `${source}-${delayMs}`,
          index === RTCController.OUTBOUND_REHYDRATE_DELAYS_MS.length - 1,
        );
      }, delayMs),
    );
  }

  private clearOutboundRehydrateTimers(wrapper: PeerWrapper) {
    wrapper.outboundRehydrateTimers.forEach((timer) => window.clearTimeout(timer));
    wrapper.outboundRehydrateTimers = [];
  }

  // ensurePeer 确保与目标用户的 RTCPeerConnection 存在，并按需绑定本地轨道。
  private async ensurePeer(user: User, initialOfferOwner: boolean, relayOnly = false) {
    const existing = this.peers.get(user.id);
    if (existing) {
      if (relayOnly && !existing.useRelayOnly) {
        this.destroyPeer(user.id);
      } else {
        if (["failed", "closed"].includes(existing.pc.connectionState)) {
          this.destroyPeer(user.id);
        } else {
          this.clearPeerReconnect(existing);
          if (initialOfferOwner) {
            existing.initialOfferOwner = true;
            await this.refreshLocalOutboundForNegotiation(existing);
          }
          return existing;
        }
      }
    }

    const pending = this.peerEnsurePromises.get(user.id);
    if (pending) {
      const ensured = await pending;
      if (initialOfferOwner && !ensured.initialOfferOwner) {
        ensured.initialOfferOwner = true;
        await this.refreshLocalOutboundForNegotiation(ensured);
        await this.sendOffer(ensured);
      }
      return ensured;
    }

    const createPromise = this.createPeer(user, initialOfferOwner, relayOnly);
    this.peerEnsurePromises.set(user.id, createPromise);
    try {
      return await createPromise;
    } finally {
      if (this.peerEnsurePromises.get(user.id) === createPromise) {
        this.peerEnsurePromises.delete(user.id);
      }
    }
  }

  private async createPeer(user: User, initialOfferOwner: boolean, relayOnly: boolean) {
    const currentUser = this.getCurrentUser();
    if (!currentUser) {
      throw new Error("missing current user");
    }

    const pc = new RTCPeerConnection({
      iceServers: relayOnly ? this.getRelayIceServers() : this.getIceServers(),
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceTransportPolicy: relayOnly ? "relay" : "all",
    });
    const audioTransceiver = pc.addTransceiver("audio", { direction: "recvonly" });
    const displayAudioTransceiver = pc.addTransceiver("audio", { direction: "recvonly" });
    const screenTransceiver = pc.addTransceiver("video", { direction: "recvonly" });

    const wrapper: PeerWrapper = {
      user,
      pc,
      polite: currentUser.id > user.id,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      initialOfferOwner,
      hasBoundLocalTracks: false,
      pendingIceCandidates: [],
      audioTransceiver,
      displayAudioTransceiver,
      screenTransceiver,
      reconnectAttempts: 0,
      reconnectTimer: null,
      reconnecting: false,
      createdAt: performance.now(),
      useRelayOnly: relayOnly,
      lastKnownTransport: relayOnly ? "turn" : "unknown",
      statsTimer: null,
      stableTimer: null,
      outboundRehydrateTimers: [],
    };

    pc.addEventListener("icecandidate", (event) => {
      if (!event.candidate) {
        this.log("ice:gathering-complete", {
          userId: user.id,
          relayOnly,
          iceGatheringState: pc.iceGatheringState,
        });
        window.setTimeout(() => {
          void this.evaluatePeerConnectivity(user.id, "ice-no-usable-candidate");
        }, RTCController.ICE_GATHERING_EVAL_DELAY_MS);
        return;
      }
      this.log("ice:candidate", {
        userId: user.id,
        relayOnly,
        type: event.candidate.type || "unknown",
        protocol: event.candidate.protocol || "unknown",
      });
      this.socket.send("rtc.ice_candidate", {
        channelId: this.getCurrentVoiceChannelId(),
        targetUserId: user.id,
        candidate: JSON.stringify(event.candidate.toJSON()),
      });
    });

    pc.addEventListener("track", (event) => {
      this.log("track:received", { userId: user.id, kind: event.track.kind, streams: event.streams.length });
      const current = this.remoteMedia.get(user.id) || {
        user,
        audioStream: null,
        displayAudioStream: null,
        screenStream: null,
      };

      if (event.track.kind === "audio") {
        if (event.transceiver === wrapper.displayAudioTransceiver) {
          current.displayAudioStream = new MediaStream([event.track]);
          this.clearMediaReconnect(user.id, "screen");
        } else {
          current.audioStream = new MediaStream([event.track]);
          this.clearMediaReconnect(user.id, "audio");
        }
      }
      if (event.track.kind === "video") {
        current.screenStream = event.streams[0] || new MediaStream([event.track]);
        this.clearMediaReconnect(user.id, "screen");
      }

      event.track.addEventListener("ended", () => {
        const media = this.remoteMedia.get(user.id);
        if (!media) return;
        if (event.track.kind === "audio") {
          if (event.transceiver === wrapper.displayAudioTransceiver) {
            media.displayAudioStream = null;
            this.ensureMediaFlow(user.id, "screen", "remote-track-ended");
          } else {
            media.audioStream = null;
            this.ensureMediaFlow(user.id, "audio", "remote-track-ended");
          }
        } else if (event.track.kind === "video") {
          media.screenStream = null;
          this.ensureMediaFlow(user.id, "screen", "remote-track-ended");
        }
        this.remoteMedia.set(user.id, media);
        this.onMediaChanged(new Map(this.remoteMedia));
      });

      event.track.addEventListener("mute", () => {
        if (event.track.kind === "audio") {
          this.ensureMediaFlow(user.id, event.transceiver === wrapper.displayAudioTransceiver ? "screen" : "audio", "remote-track-muted");
        } else if (event.track.kind === "video") {
          this.ensureMediaFlow(user.id, "screen", "remote-track-muted");
        }
      });

      this.remoteMedia.set(user.id, current);
      this.onMediaChanged(new Map(this.remoteMedia));
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        void this.handlePeerConnected(wrapper);
        this.scheduleOutboundRehydrateAfterReconnect(wrapper, `ice-${pc.iceConnectionState}`);
        return;
      }
      if (pc.iceConnectionState === "disconnected") {
        this.cancelStableReset(wrapper);
        this.schedulePeerReconnect(
          user.id,
          wrapper.useRelayOnly || wrapper.lastKnownTransport === "turn" ? RTCController.TURN_DISCONNECT_GRACE_MS : RTCController.PEER_RECONNECT_DELAY_MS,
          "ice-disconnected",
        );
        return;
      }
      if (pc.iceConnectionState === "failed") {
        this.cancelStableReset(wrapper);
        this.schedulePeerReconnect(user.id, 0, "ice-failed");
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") {
        void this.handlePeerConnected(wrapper);
        this.scheduleOutboundRehydrateAfterReconnect(wrapper, "connection-connected");
        return;
      }
      if (pc.connectionState === "disconnected") {
        this.cancelStableReset(wrapper);
        this.schedulePeerDisconnectCleanup(user.id);
        this.ensureMediaFlow(user.id, "audio", "peer-disconnected");
        this.ensureMediaFlow(user.id, "screen", "peer-disconnected");
        this.schedulePeerReconnect(
          user.id,
          wrapper.useRelayOnly || wrapper.lastKnownTransport === "turn" ? RTCController.TURN_DISCONNECT_GRACE_MS : RTCController.PEER_RECONNECT_DELAY_MS,
          "peer-disconnected",
        );
        return;
      }
      if (pc.connectionState === "failed") {
        this.cancelStableReset(wrapper);
        this.schedulePeerReconnect(user.id, 0, "peer-failed");
        return;
      }
      if (pc.connectionState === "closed") {
        this.handleMemberLeft(user.id);
      }
    });

    this.peers.set(user.id, wrapper);
    if (initialOfferOwner) {
      await this.refreshLocalOutboundForNegotiation(wrapper);
      await this.sendOffer(wrapper);
    }
    this.log("peer:created", { userId: user.id, shouldOffer: initialOfferOwner });
    return wrapper;
  }

  private async bindLocalTracks(wrapper: PeerWrapper, includeLocalTracks: boolean, options: { forceReplace?: boolean } = {}) {
    const [audioTrack] = includeLocalTracks ? this.localAudioStream?.getAudioTracks() || [] : [];
    const [screenTrack] = includeLocalTracks ? this.localScreenStream?.getVideoTracks() || [] : [];

    if (options.forceReplace) {
      await wrapper.audioTransceiver.sender.replaceTrack(null);
      await wrapper.displayAudioTransceiver.sender.replaceTrack(null);
      await wrapper.screenTransceiver.sender.replaceTrack(null);
    }

    await wrapper.audioTransceiver.sender.replaceTrack(audioTrack || null);
    wrapper.audioTransceiver.direction = audioTrack ? "sendrecv" : "recvonly";

    await wrapper.displayAudioTransceiver.sender.replaceTrack(null);
    wrapper.displayAudioTransceiver.direction = "recvonly";

    await wrapper.screenTransceiver.sender.replaceTrack(screenTrack || null);
    wrapper.screenTransceiver.direction = screenTrack ? "sendrecv" : "recvonly";

    wrapper.hasBoundLocalTracks = includeLocalTracks;
  }

  private async handlePeerConnected(wrapper: PeerWrapper) {
    this.clearPeerReconnect(wrapper, false);
    this.clearPeerDisconnectTimer(wrapper.user.id);
    this.scheduleStableReset(wrapper);
    this.startPeerStats(wrapper);
  }

  private async refreshLocalTracksOnPeers() {
    await Promise.all(
      Array.from(this.peers.values()).map(async (wrapper) => {
        await this.refreshLocalOutboundForNegotiation(wrapper);
      }),
    );
  }

  private async applyLocalTracksToAllPeers() {
    await Promise.all(
      Array.from(this.peers.values()).map(async (wrapper) => {
        await this.refreshLocalOutboundForNegotiation(wrapper);
        if (wrapper.initialOfferOwner) {
          await this.sendOffer(wrapper);
        }
      }),
    );
  }

  private async sendOffer(wrapper: PeerWrapper) {
    const pc = wrapper.pc;
    if (wrapper.makingOffer) {
      return;
    }
    if (pc.signalingState !== "stable") {
      return;
    }
    const startedAt = performance.now();
    try {
      wrapper.makingOffer = true;
      await this.refreshLocalOutboundForNegotiation(wrapper);
      this.log("negotiate:start", { userId: wrapper.user.id });
      await pc.setLocalDescription();
      this.socket.send("rtc.offer", {
        channelId: this.getCurrentVoiceChannelId(),
        targetUserId: wrapper.user.id,
        sdp: pc.localDescription?.sdp,
      });
      this.log("negotiate:offer-sent", {
        userId: wrapper.user.id,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      console.error(error);
      this.onNotice("error", "实时通信异常", "WebRTC 协商失败，请刷新后重试");
    } finally {
      wrapper.makingOffer = false;
    }
  }

  private async flushPendingIceCandidates(wrapper: PeerWrapper) {
    if (!wrapper.pc.remoteDescription || !wrapper.pendingIceCandidates.length) return;
    const queued = [...wrapper.pendingIceCandidates];
    wrapper.pendingIceCandidates = [];
    for (const candidate of queued) {
      try {
        await wrapper.pc.addIceCandidate(candidate);
      } catch (error) {
        if (!wrapper.ignoreOffer) {
          console.error(error);
        }
      }
    }
  }

  private closeAllPeers() {
    for (const key of this.mediaReconnectTimers.keys()) {
      const [rawUserId, kind] = key.split(":");
      this.clearMediaReconnect(Number(rawUserId), kind as MediaSyncKind);
    }
    for (const userId of this.peerDisconnectTimers.keys()) {
      this.clearPeerDisconnectTimer(userId);
    }
    for (const wrapper of this.peers.values()) {
      this.clearPeerReconnect(wrapper);
      this.clearOutboundRehydrateTimers(wrapper);
      wrapper.pc.close();
    }
    this.peers.clear();
    this.remoteMedia.clear();
    this.peerRebuildCounts.clear();
    this.failedPeers.clear();
    this.lastResetSentAt.clear();
    this.outageNoticeAt.clear();
    this.onMediaChanged(new Map(this.remoteMedia));
  }

  private stopTrackGroup(stream: MediaStream | null) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  private lookupUser(userId: number) {
    const voiceUser = this.getVoiceMembers().get(userId)?.user;
    if (voiceUser) return voiceUser;
    return this.getMembers().find((member) => member.id === userId) || null;
  }

  handleScreenState(userId: number, screenSharing: boolean) {
    if (!this.voiceSessionActive) return;
    if (!screenSharing) {
      this.clearMediaReconnect(userId, "screen");
      return;
    }
    this.ensureMediaFlow(userId, "screen", "screen.state");
  }

  handleVoiceState(userId: number, micEnabled: boolean) {
    if (!this.voiceSessionActive) return;
    if (!micEnabled) {
      this.clearMediaReconnect(userId, "audio");
      return;
    }
    this.ensureMediaFlow(userId, "audio", "voice.state");
  }

  private ensureMediaFlow(userId: number, kind: MediaSyncKind, reason: string) {
    if (!this.voiceSessionActive) return;
    if (!this.getCurrentVoiceChannelId()) return;
    if (userId === this.getCurrentUser()?.id) return;
    if (this.failedPeers.has(userId)) return;
    const voiceMember = this.getVoiceMembers().get(userId);
    if (!voiceMember) return;
    if (kind === "screen" && !voiceMember.screenSharing) return;
    const media = this.remoteMedia.get(userId);
    const existingStream = kind === "audio" ? media?.audioStream : media?.screenStream;
    if (existingStream) {
      this.clearMediaReconnect(userId, kind);
      return;
    }
    this.requestMediaSync(userId, kind, reason);
  }

  private requestMediaSync(userId: number, kind: MediaSyncKind, reason: string) {
    if (!this.getCurrentVoiceChannelId()) return;
    const voiceMember = this.getVoiceMembers().get(userId);
    if (!voiceMember) {
      this.clearMediaReconnect(userId, kind);
      return;
    }
    if (kind === "screen" && !voiceMember.screenSharing) {
      this.clearMediaReconnect(userId, kind);
      return;
    }
    const reconnectKey = this.mediaReconnectKey(userId, kind);
    const attempt = (this.mediaReconnectAttempts.get(reconnectKey) || 0) + 1;
    if (attempt > RTCController.MEDIA_RECONNECT_MAX_ATTEMPTS) {
      this.clearMediaReconnect(userId, kind);
      return;
    }
    this.mediaReconnectAttempts.set(reconnectKey, attempt);
    this.clearMediaReconnectTimerOnly(reconnectKey);
    this.socket.send("media.sync_request", {
      channelId: this.getCurrentVoiceChannelId(),
      targetUserId: userId,
      kind,
      reason,
      attempt,
    });
    const timer = window.setTimeout(() => {
      this.mediaReconnectTimers.delete(reconnectKey);
      this.requestMediaSync(userId, kind, "retry");
    }, RTCController.MEDIA_RECONNECT_DELAY_MS);
    this.mediaReconnectTimers.set(reconnectKey, timer);
  }

  private clearMediaReconnect(userId: number, kind: MediaSyncKind) {
    const reconnectKey = this.mediaReconnectKey(userId, kind);
    this.clearMediaReconnectTimerOnly(reconnectKey);
    this.mediaReconnectAttempts.delete(reconnectKey);
  }

  private clearMediaReconnectTimerOnly(reconnectKey: string) {
    const timer = this.mediaReconnectTimers.get(reconnectKey);
    if (!timer) return;
    window.clearTimeout(timer);
    this.mediaReconnectTimers.delete(reconnectKey);
  }

  private schedulePeerDisconnectCleanup(userId: number) {
    if (this.peerDisconnectTimers.has(userId)) {
      return;
    }
    const timer = window.setTimeout(() => {
      this.peerDisconnectTimers.delete(userId);
      const wrapper = this.peers.get(userId);
      if (!wrapper) return;
      if (wrapper.pc.connectionState === "disconnected") {
        this.handleMemberLeft(userId);
      }
    }, RTCController.PEER_DISCONNECT_GRACE_MS);
    this.peerDisconnectTimers.set(userId, timer);
  }

  private clearPeerDisconnectTimer(userId: number) {
    const timer = this.peerDisconnectTimers.get(userId);
    if (!timer) return;
    window.clearTimeout(timer);
    this.peerDisconnectTimers.delete(userId);
  }

  private mediaReconnectKey(userId: number, kind: MediaSyncKind) {
    return `${userId}:${kind}`;
  }

  private clearPeerReconnect(wrapper: PeerWrapper, resetAttempts = true) {
    if (wrapper.reconnectTimer) {
      window.clearTimeout(wrapper.reconnectTimer);
      wrapper.reconnectTimer = null;
    }
    if (resetAttempts) {
      wrapper.reconnectAttempts = 0;
    }
    wrapper.reconnecting = false;
  }

  private scheduleStableReset(wrapper: PeerWrapper) {
    this.cancelStableReset(wrapper);
    wrapper.stableTimer = window.setTimeout(() => {
      wrapper.stableTimer = null;
      if (
        wrapper.pc.connectionState === "connected" ||
        wrapper.pc.iceConnectionState === "connected" ||
        wrapper.pc.iceConnectionState === "completed"
      ) {
        wrapper.reconnectAttempts = 0;
        this.peerRebuildCounts.delete(wrapper.user.id);
        this.outageNoticeAt.delete(wrapper.user.id);
      }
    }, RTCController.PEER_STABLE_RESET_MS);
  }

  private cancelStableReset(wrapper: PeerWrapper) {
    if (!wrapper.stableTimer) return;
    window.clearTimeout(wrapper.stableTimer);
    wrapper.stableTimer = null;
  }

  private schedulePeerReconnect(userId: number, delayMs: number, reason: string) {
    if (!this.voiceSessionActive) {
      return;
    }
    if (this.failedPeers.has(userId)) {
      return;
    }
    const wrapper = this.peers.get(userId);
    if (!wrapper || wrapper.reconnecting) {
      return;
    }
    if (wrapper.reconnectTimer) {
      return;
    }
    const nextAttempt = wrapper.reconnectAttempts + 1;
    const turnFallback =
      wrapper.useRelayOnly ||
      wrapper.lastKnownTransport === "turn" ||
      (nextAttempt >= 2 && this.getRelayIceServers().length > 0);
    // polite 方（id 大）多等一拍再重连：正常情况下 impolite 方的 rtc.reset 会先到，
    // 本地这个定时器随 recreate 被清掉，避免双方同时发起重建互相打架。
    const effectiveDelayMs = wrapper.polite ? delayMs + RTCController.POLITE_RECREATE_EXTRA_DELAY_MS : delayMs;
    wrapper.reconnectTimer = window.setTimeout(() => {
      wrapper.reconnectTimer = null;
      void this.attemptPeerReconnect(userId, reason);
    }, effectiveDelayMs);
    this.log("reconnect:scheduled", { userId, delayMs: effectiveDelayMs, reason, attempt: nextAttempt, turnFallback });
    if (this.shouldNotifyOutage(userId)) {
      this.onNotice(
        "info",
        "实时连接重连中",
        turnFallback
          ? `与 ${wrapper.user.displayName} 的连接不稳定，正在使用 TURN 中继重连`
          : `与 ${wrapper.user.displayName} 的连接出现波动，正在自动重连`,
      );
    }
  }

  // 同一 peer 的一轮断线故障期内（30s），重连/切中继类通知只发一次，避免刷屏。
  private shouldNotifyOutage(userId: number) {
    const last = this.outageNoticeAt.get(userId);
    if (last != null && performance.now() - last < RTCController.OUTAGE_NOTICE_INTERVAL_MS) {
      return false;
    }
    this.outageNoticeAt.set(userId, performance.now());
    return true;
  }

  private async attemptPeerReconnect(userId: number, reason: string) {
    if (!this.voiceSessionActive) {
      return;
    }
    const wrapper = this.peers.get(userId);
    if (!wrapper || !this.getCurrentVoiceChannelId()) {
      return;
    }
    if (wrapper.pc.connectionState === "closed") {
      return;
    }

    wrapper.reconnectAttempts += 1;
    wrapper.reconnecting = true;
    const attempt = wrapper.reconnectAttempts;
    const switchingToRelay =
      !wrapper.useRelayOnly && wrapper.lastKnownTransport !== "turn" &&
      (attempt >= 2 && this.getRelayIceServers().length > 0);
    const isTurnConnection = wrapper.useRelayOnly || wrapper.lastKnownTransport === "turn";

    try {
      if (isTurnConnection) {
        // TURN/relay 断线后的单向音视频问题通常不是单纯 candidate 换路，而是旧 PeerConnection
        // 内部的 receiver/transceiver 状态卡住；用户重进频道能恢复，说明可靠恢复点是重建整条 peer。
        // 因此 relay 链路不再走 ICE restart/pulse/stats 叠加补丁，直接通过 rtc.reset 让双方局部重建。
        await this.recreatePeer(userId, reason, true, true);
        return;
      }

      if (
        !switchingToRelay &&
        wrapper.pc.signalingState === "stable" &&
        !wrapper.makingOffer
      ) {
        const offer = await wrapper.pc.createOffer({ iceRestart: true });
        await wrapper.pc.setLocalDescription(offer);
        this.socket.send("rtc.offer", {
          channelId: this.getCurrentVoiceChannelId(),
          targetUserId: wrapper.user.id,
          sdp: wrapper.pc.localDescription?.sdp,
        });
        this.log("reconnect:ice-restart", { userId: wrapper.user.id, attempt, reason, relayOnly: wrapper.useRelayOnly });
        wrapper.reconnecting = false;
        // 此分支只有直连会走到（TURN 已在上面 return），给 ICE restart 留满超时窗口
        this.schedulePeerReconnect(userId, RTCController.ICE_RESTART_TIMEOUT_MS, "ice-restart-timeout");
        return;
      }

      const shouldUseRelayOnly = switchingToRelay || wrapper.useRelayOnly || wrapper.lastKnownTransport === "turn";
      await this.recreatePeer(userId, reason, true, shouldUseRelayOnly);
    } catch (error) {
      console.error(error);
      wrapper.reconnecting = false;
      if (attempt >= RTCController.PEER_RECONNECT_MAX_ATTEMPTS) {
        const shouldUseRelayOnly = wrapper.useRelayOnly || wrapper.lastKnownTransport === "turn";
        await this.recreatePeer(userId, "reconnect-max-attempts", true, shouldUseRelayOnly);
        return;
      }
      this.schedulePeerReconnect(userId, RTCController.PEER_RECONNECT_DELAY_MS, "reconnect-retry");
    }
  }

  private async recreatePeer(userId: number, reason: string, notifyRemote: boolean, relayOnly = false) {
    if (!this.voiceSessionActive) {
      return;
    }
    const wrapper = this.peers.get(userId);
    const user = wrapper?.user || this.lookupUser(userId);
    const currentUser = this.getCurrentUser();
    if (!user || !currentUser || !this.getCurrentVoiceChannelId()) {
      return;
    }

    // 重建预算：稳定期（8s）内会清零；预算耗尽说明链路已不可自动恢复，
    // 进入终态停止循环重建，等对方重新进频道或本人重进频道再恢复。
    const rebuildCount = (this.peerRebuildCounts.get(userId) || 0) + 1;
    if (rebuildCount > RTCController.MAX_PEER_REBUILDS) {
      this.log("reconnect:gave-up", { userId, reason, rebuildCount });
      this.failedPeers.add(userId);
      this.destroyPeer(userId);
      this.onNotice(
        "error",
        "重连失败",
        `与 ${user.displayName} 的连接多次重建失败，已停止自动重连，可尝试重新进入频道`,
      );
      return;
    }
    this.peerRebuildCounts.set(userId, rebuildCount);

    this.log("reconnect:recreate", { userId, reason, notifyRemote, relayOnly, rebuildCount });
    this.destroyPeer(userId);

    if (notifyRemote) {
      this.lastResetSentAt.set(userId, performance.now());
      this.socket.send("rtc.reset", {
        channelId: this.getCurrentVoiceChannelId(),
        targetUserId: userId,
        reason,
        relayOnly,
      });
    }

    const shouldOffer = currentUser.id < user.id;
    if (relayOnly && this.shouldNotifyOutage(userId)) {
      this.onNotice("info", "已切换 TURN 中继", `与 ${user.displayName} 的连接已改用 TURN 中继重建`);
    }
    const nextWrapper = await this.ensurePeer(user, shouldOffer, relayOnly);
    await this.refreshLocalOutboundForNegotiation(nextWrapper);
    nextWrapper.reconnecting = false;
    nextWrapper.reconnectAttempts = relayOnly ? 1 : 0;
    nextWrapper.lastKnownTransport = relayOnly ? "turn" : nextWrapper.lastKnownTransport;
    if (shouldOffer) {
      await this.sendOffer(nextWrapper);
    }
  }

  private destroyPeer(userId: number) {
    this.peerEnsurePromises.delete(userId);
    const wrapper = this.peers.get(userId);
    if (!wrapper) {
      return;
    }
    this.clearPeerReconnect(wrapper);
    this.cancelStableReset(wrapper);
    this.clearOutboundRehydrateTimers(wrapper);
    this.clearPeerDisconnectTimer(userId);
    this.clearMediaReconnect(userId, "audio");
    this.clearMediaReconnect(userId, "screen");
    this.stopPeerStats(wrapper);
    wrapper.pc.close();
    this.peers.delete(userId);
    this.remoteMedia.delete(userId);
    this.diagnostics.delete(userId);
    this.onMediaChanged(new Map(this.remoteMedia));
    this.onDiagnosticsChanged(new Map(this.diagnostics));
  }

  private getRelayIceServers() {
    return this.getIceServers().filter((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => String(url).startsWith("turn:") || String(url).startsWith("turns:"));
    });
  }

  private startPeerStats(wrapper: PeerWrapper) {
    if (wrapper.statsTimer) {
      return;
    }
    const tick = () => {
      void this.collectPeerStats(wrapper);
    };
    tick();
    wrapper.statsTimer = window.setInterval(tick, RTCController.PEER_STATS_INTERVAL_MS);
  }

  private stopPeerStats(wrapper: PeerWrapper) {
    if (!wrapper.statsTimer) {
      return;
    }
    window.clearInterval(wrapper.statsTimer);
    wrapper.statsTimer = null;
  }

  private async collectPeerStats(wrapper: PeerWrapper) {
    try {
      const stats = await wrapper.pc.getStats();
      let selectedPair: RTCStats | null = null;
      let selectedPairId = "";
      const reports = new Map<string, RTCStats>();
      stats.forEach((report) => {
        reports.set(report.id, report);
        if (report.type === "transport") {
          const candidatePairId = (report as RTCTransportStats).selectedCandidatePairId;
          if (candidatePairId) {
            selectedPairId = candidatePairId;
          }
        }
      });
      if (selectedPairId) {
        selectedPair = reports.get(selectedPairId) || null;
      }
      if (!selectedPair) {
        stats.forEach((report) => {
          if (
            report.type === "candidate-pair" &&
            (((report as RTCIceCandidatePairStats).state === "succeeded") ||
              (report as RTCIceCandidatePairStats).nominated)
          ) {
            selectedPair = report;
          }
        });
      }

      const pair = selectedPair as RTCIceCandidatePairStats | null;
      const localCandidate = pair?.localCandidateId ? (reports.get(pair.localCandidateId) as RTCStats | undefined) : undefined;
      const remoteCandidate = pair?.remoteCandidateId ? (reports.get(pair.remoteCandidateId) as RTCStats | undefined) : undefined;
      const localCandidateType = (localCandidate as RTCStats & { candidateType?: string } | undefined)?.candidateType || null;
      const remoteCandidateType = (remoteCandidate as RTCStats & { candidateType?: string } | undefined)?.candidateType || null;
      const transport = this.resolveTransportType(localCandidate, remoteCandidate);
      if (transport !== "unknown") {
        wrapper.lastKnownTransport = transport;
      }
      const latencyMs =
        typeof pair?.currentRoundTripTime === "number"
          ? Math.round(pair.currentRoundTripTime * 1000)
          : typeof pair?.totalRoundTripTime === "number" && typeof pair?.responsesReceived === "number" && pair.responsesReceived > 0
            ? Math.round((pair.totalRoundTripTime / pair.responsesReceived) * 1000)
            : null;

      this.log("ice:selected-pair", {
        userId: wrapper.user.id,
        relayOnly: wrapper.useRelayOnly,
        pairState: pair?.state || null,
        nominated: pair?.nominated ?? null,
        writable: (pair as RTCIceCandidatePairStats & { writable?: boolean } | null)?.writable ?? null,
        localCandidateType,
        remoteCandidateType,
        localCandidateId: pair?.localCandidateId || null,
        remoteCandidateId: pair?.remoteCandidateId || null,
        transport,
        latencyMs,
      });

      this.diagnostics.set(wrapper.user.id, {
        userId: wrapper.user.id,
        latencyMs,
        transport,
        retryCount: wrapper.reconnectAttempts,
        recoveryMode: wrapper.useRelayOnly ? "relay" : wrapper.reconnectAttempts > 0 ? "ice-restart" : "stable",
        updatedAt: Date.now(),
      });
      this.onDiagnosticsChanged(new Map(this.diagnostics));
    } catch (error) {
      console.error(error);
    }
  }

  private describeIceServers(servers: RTCIceServer[]) {
    return servers.map((server) => ({
      urls: Array.isArray(server.urls) ? server.urls : [server.urls],
      username: server.username || null,
      hasCredential: Boolean(server.credential),
    }));
  }

  private async evaluatePeerConnectivity(userId: number, reason: string) {
    if (!this.voiceSessionActive) {
      return;
    }
    const wrapper = this.peers.get(userId);
    if (!wrapper || wrapper.reconnecting || wrapper.reconnectTimer) {
      return;
    }
    if (!this.getCurrentVoiceChannelId()) {
      return;
    }
    if (
      wrapper.pc.connectionState === "connected" ||
      wrapper.pc.iceConnectionState === "connected" ||
      wrapper.pc.iceConnectionState === "completed"
    ) {
      return;
    }

    try {
      const stats = await wrapper.pc.getStats();
      let hasUsablePair = false;
      stats.forEach((report) => {
        if (
          report.type === "candidate-pair" &&
          (((report as RTCIceCandidatePairStats).state === "succeeded") ||
            (report as RTCIceCandidatePairStats).nominated)
        ) {
          hasUsablePair = true;
        }
      });
      if (hasUsablePair) {
        return;
      }
      // 建连宽限期：trickle ICE 下 end-of-candidates 常早于连通性检查完成（TURN 分配更慢），
      // gathering 刚结束时没有 succeeded pair 是正常现象。此时触发重连会把还在握手中的
      // 连接推倒重来（信令非 stable 时甚至直接走 recreate），弱网下可能永远建不起来。
      // 未过宽限期只安排复查，过了宽限期仍无可用 pair 才算真失败。
      const ageMs = performance.now() - wrapper.createdAt;
      if (ageMs < RTCController.PEER_ESTABLISH_GRACE_MS) {
        this.log("ice:no-usable-pair-waiting", { userId, ageMs: Math.round(ageMs), reason });
        window.setTimeout(() => {
          void this.evaluatePeerConnectivity(userId, reason);
        }, RTCController.ESTABLISH_REEVAL_DELAY_MS);
        return;
      }
      this.log("ice:no-usable-pair", {
        userId,
        relayOnly: wrapper.useRelayOnly,
        connectionState: wrapper.pc.connectionState,
        iceConnectionState: wrapper.pc.iceConnectionState,
        reason,
      });
      this.schedulePeerReconnect(userId, 0, reason);
    } catch (error) {
      console.error(error);
    }
  }

  private resolveTransportType(localCandidate?: RTCStats, remoteCandidate?: RTCStats): PeerConnectionDiagnostics["transport"] {
    const localType = (localCandidate as RTCStats & { candidateType?: string } | undefined)?.candidateType;
    const remoteType = (remoteCandidate as RTCStats & { candidateType?: string } | undefined)?.candidateType;
    if (localType === "relay" || remoteType === "relay") {
      return "turn";
    }
    if (localType === "srflx" || localType === "prflx" || remoteType === "srflx" || remoteType === "prflx") {
      return "stun";
    }
    if (localType === "host" || remoteType === "host") {
      return "lan";
    }
    return "unknown";
  }
}

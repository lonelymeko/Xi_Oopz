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
  useRelayOnly: boolean;
  statsTimer: number | null;
  suppressNegotiationNeeded: boolean;
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
const RTC_DEBUG_LABELS = new Set([
  "joinVoice:start",
  "joinVoice:audio-ready",
  "joinVoice:channel.join-sent",
  "leaveVoice:start",
  "leaveVoice:completed",
  "ensureAudio:getUserMedia:start",
  "ensureAudio:reused-prewarmed-stream",
  "ensureAudio:getUserMedia:completed",
  "refreshAudioInput:start",
  "refreshAudioInput:completed",
  "acquireAudioStream:advanced:start",
  "acquireAudioStream:advanced:completed",
  "acquireAudioStream:advanced:failed",
  "acquireAudioStream:fallback:start",
  "acquireAudioStream:fallback:completed",
  "acquireAudioStream:fallback:failed",
  "peer:created",
  "ice:config",
  "ice:candidate",
  "ice:gathering-complete",
  "ice:no-usable-pair",
  "ice:selected-pair",
  "track:received",
  "negotiate:start",
  "negotiate:offer-sent",
  "reconnect:scheduled",
  "reconnect:ice-restart",
  "reconnect:recreate",
  "reconnect:reset-received",
  "signal:offer:ignored",
  "signal:answer:ignored",
  "signal:error",
]);

export class RTCController {
  private static readonly MEDIA_RECONNECT_DELAY_MS = 1500;
  private static readonly MEDIA_RECONNECT_MAX_ATTEMPTS = 5;
  private static readonly PEER_DISCONNECT_GRACE_MS = 5000;
  private static readonly PEER_RECONNECT_DELAY_MS = 2000;
  private static readonly PEER_RECONNECT_MAX_ATTEMPTS = 4;
  private static readonly PEER_STATS_INTERVAL_MS = 3000;
  private static readonly ICE_GATHERING_EVAL_DELAY_MS = 800;

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

  private log(label: string, extra?: Record<string, unknown>) {
    if (!RTC_DEBUG_LABELS.has(label)) {
      return;
    }
    const stamp = new Date().toISOString();
    if (extra) {
      console.info(`[rtc][${stamp}] ${label}`, extra);
      return;
    }
    console.info(`[rtc][${stamp}] ${label}`);
  }

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
    const selfId = this.getCurrentUser()?.id;
    const shouldOffer = selfId != null && selfId < member.user.id;
    await this.ensurePeer(member.user, shouldOffer);
    this.ensureMediaFlow(member.user.id, "audio", "member.joined");
    this.ensureMediaFlow(member.user.id, "screen", "member.joined");
  }

  handleMemberLeft(userId: number) {
    if (!this.voiceSessionActive) return;
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
        this.log("reconnect:reset-received", { userId: peerUser.id, reason: payload.reason || "remote-reset" });
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
        await this.bindLocalTracks(wrapper, true);
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
        await this.bindLocalTracks(wrapper, true);
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
    if (!this.localMicStream && !this.localAudioStream) {
      return;
    }
    await this.rebuildOutboundAudio();
    this.updateMixGains();
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
            await this.bindLocalTracks(existing, true);
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
        await this.bindLocalTracks(ensured, true);
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
      useRelayOnly: relayOnly,
      statsTimer: null,
      suppressNegotiationNeeded: false,
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
        address: event.candidate.address || null,
        port: event.candidate.port || null,
        candidate: event.candidate.candidate,
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
        this.clearPeerReconnect(wrapper);
        this.clearPeerDisconnectTimer(user.id);
        this.startPeerStats(wrapper);
        return;
      }
      if (pc.iceConnectionState === "disconnected") {
        this.schedulePeerReconnect(user.id, RTCController.PEER_RECONNECT_DELAY_MS, "ice-disconnected");
        return;
      }
      if (pc.iceConnectionState === "failed") {
        this.schedulePeerReconnect(user.id, 0, "ice-failed");
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") {
        this.clearPeerReconnect(wrapper);
        this.clearPeerDisconnectTimer(user.id);
        this.startPeerStats(wrapper);
        return;
      }
      if (pc.connectionState === "disconnected") {
        this.schedulePeerDisconnectCleanup(user.id);
        this.ensureMediaFlow(user.id, "audio", "peer-disconnected");
        this.ensureMediaFlow(user.id, "screen", "peer-disconnected");
        this.schedulePeerReconnect(user.id, RTCController.PEER_RECONNECT_DELAY_MS, "peer-disconnected");
        return;
      }
      if (pc.connectionState === "failed") {
        this.schedulePeerReconnect(user.id, 0, "peer-failed");
        return;
      }
      if (pc.connectionState === "closed") {
        this.handleMemberLeft(user.id);
      }
    });

    this.peers.set(user.id, wrapper);
    if (initialOfferOwner) {
      await this.bindLocalTracks(wrapper, true);
      await this.sendOffer(wrapper);
    }
    this.log("peer:created", { userId: user.id, shouldOffer: initialOfferOwner });
    return wrapper;
  }

  private async bindLocalTracks(wrapper: PeerWrapper, includeLocalTracks: boolean) {
    const [audioTrack] = includeLocalTracks ? this.localAudioStream?.getAudioTracks() || [] : [];
    const [screenTrack] = includeLocalTracks ? this.localScreenStream?.getVideoTracks() || [] : [];

    wrapper.suppressNegotiationNeeded = true;
    try {
      await wrapper.audioTransceiver.sender.replaceTrack(audioTrack || null);
      wrapper.audioTransceiver.direction = audioTrack ? "sendrecv" : "recvonly";

      await wrapper.displayAudioTransceiver.sender.replaceTrack(null);
      wrapper.displayAudioTransceiver.direction = "recvonly";

      await wrapper.screenTransceiver.sender.replaceTrack(screenTrack || null);
      wrapper.screenTransceiver.direction = screenTrack ? "sendrecv" : "recvonly";

      wrapper.hasBoundLocalTracks = includeLocalTracks;
    } finally {
      queueMicrotask(() => {
        wrapper.suppressNegotiationNeeded = false;
      });
    }
  }

  private async applyLocalTracksToAllPeers() {
    await Promise.all(
      Array.from(this.peers.values()).map(async (wrapper) => {
        await this.bindLocalTracks(wrapper, true);
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
      wrapper.pc.close();
    }
    this.peers.clear();
    this.remoteMedia.clear();
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

  private clearPeerReconnect(wrapper: PeerWrapper) {
    if (wrapper.reconnectTimer) {
      window.clearTimeout(wrapper.reconnectTimer);
      wrapper.reconnectTimer = null;
    }
    wrapper.reconnectAttempts = 0;
    wrapper.reconnecting = false;
  }

  private schedulePeerReconnect(userId: number, delayMs: number, reason: string) {
    if (!this.voiceSessionActive) {
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
    const turnFallback = wrapper.useRelayOnly || (nextAttempt >= 2 && this.getRelayIceServers().length > 0);
    wrapper.reconnectTimer = window.setTimeout(() => {
      wrapper.reconnectTimer = null;
      void this.attemptPeerReconnect(userId, reason);
    }, delayMs);
    this.log("reconnect:scheduled", { userId, delayMs, reason, attempt: nextAttempt, turnFallback });
    this.onNotice(
      "info",
      "实时连接重连中",
      turnFallback
        ? `与 ${wrapper.user.displayName} 的连接不稳定，正在使用 TURN 中继重连`
        : `与 ${wrapper.user.displayName} 的连接出现波动，正在自动重连`,
    );
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
    const shouldUseRelayOnly = wrapper.useRelayOnly || (attempt >= 2 && this.getRelayIceServers().length > 0);

    try {
      if (
        !shouldUseRelayOnly &&
        attempt < RTCController.PEER_RECONNECT_MAX_ATTEMPTS &&
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
        this.log("reconnect:ice-restart", { userId: wrapper.user.id, attempt, reason });
        wrapper.reconnecting = false;
        this.schedulePeerReconnect(userId, RTCController.PEER_RECONNECT_DELAY_MS, "ice-restart-timeout");
        return;
      }

      await this.recreatePeer(userId, reason, true, shouldUseRelayOnly);
    } catch (error) {
      console.error(error);
      wrapper.reconnecting = false;
      if (attempt >= RTCController.PEER_RECONNECT_MAX_ATTEMPTS) {
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

    this.log("reconnect:recreate", { userId, reason, notifyRemote, relayOnly });
    this.destroyPeer(userId);

    if (notifyRemote) {
      this.socket.send("rtc.reset", {
        channelId: this.getCurrentVoiceChannelId(),
        targetUserId: userId,
        reason,
        relayOnly,
      });
    }

    const shouldOffer = currentUser.id < user.id;
    if (relayOnly) {
      this.onNotice("info", "已切换 TURN 中继", `与 ${user.displayName} 的连接已改用 TURN 中继重建`);
    }
    const nextWrapper = await this.ensurePeer(user, shouldOffer, relayOnly);
    await this.bindLocalTracks(nextWrapper, true);
    nextWrapper.reconnecting = false;
    nextWrapper.reconnectAttempts = 0;
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

import { buildWsUrl } from "./config/runtime";

type SocketFrame = {
  type: string;
  payload: unknown;
};

/**
 * 判断运行时数据是否符合 Socket 帧结构。
 */
function isSocketFrame(value: unknown): value is SocketFrame {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === "string" && "payload" in record;
}

export class SocketClient {
  private socket: WebSocket | null = null;
  private heartbeat: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private lastConnectedState: boolean | null = null;
  private manualClose = false;
  private readonly metrics = {
    connectCount: 0,
    reconnectAttempt: 0,
    lastCloseCode: 0,
    lastCloseReason: "",
    statusTransitionCount: 0,
  };

  constructor(
    private readonly token: string,
    private readonly domainId: number,
    private readonly onEvent: (type: string, payload: unknown) => void,
    private readonly onStatus: (connected: boolean) => void,
  ) {}

  /**
   * 输出运行时 WS 调试日志，仅在开发环境启用。
   */
  private debugLog(label: string, extra?: Record<string, unknown>) {
    if (!import.meta.env.DEV) return;
    if (extra) {
      console.info(`[ws-runtime] ${label}`, extra);
      return;
    }
    console.info(`[ws-runtime] ${label}`);
  }

  /**
   * 推送连接状态变更，重复状态会被忽略。
   */
  private notifyStatus(connected: boolean) {
    if (this.lastConnectedState === connected) return;
    this.lastConnectedState = connected;
    this.metrics.statusTransitionCount += 1;
    this.onStatus(connected);
  }

  /**
   * 读取当前连接诊断指标。
   */
  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * 计算重连等待时长，采用指数退避并限制最大间隔。
   */
  private nextReconnectDelay() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 10000);
    this.reconnectAttempt += 1;
    return delay;
  }

  /**
   * 清理心跳与重连定时器，避免重复触发。
   */
  private clearTimers() {
    if (this.heartbeat) {
      window.clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 安排下一次重连，确保同一时刻最多存在一个重连任务。
   */
  private scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer) return;
    const delay = this.nextReconnectDelay();
    this.metrics.reconnectAttempt = this.reconnectAttempt;
    this.debugLog("reconnect:scheduled", { delay, reconnectAttempt: this.reconnectAttempt });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) {
      return;
    }
    const generation = this.generation + 1;
    this.generation = generation;
    this.manualClose = false;
    this.clearTimers();
    this.metrics.connectCount += 1;
    this.debugLog("connect:start", { generation, connectCount: this.metrics.connectCount, domainId: this.domainId });
    const socket = new WebSocket(buildWsUrl(`/ws?token=${encodeURIComponent(this.token)}&domainId=${this.domainId}`));
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (generation !== this.generation) return;
      this.reconnectAttempt = 0;
      this.metrics.reconnectAttempt = 0;
      this.notifyStatus(true);
      this.debugLog("connect:open", { generation, domainId: this.domainId });
      this.send("hello", {});
      this.heartbeat = window.setInterval(() => this.send("heartbeat", {}), 15000);
    });

    socket.addEventListener("close", (event) => {
      if (generation !== this.generation) return;
      this.metrics.lastCloseCode = event.code;
      this.metrics.lastCloseReason = event.reason || "";
      this.debugLog("connect:close", { generation, code: event.code, reason: event.reason || "", manualClose: this.manualClose });
      this.notifyStatus(false);
      this.clearTimers();
      this.socket = null;
      this.scheduleReconnect();
    });

    socket.addEventListener("message", (event) => {
      if (generation !== this.generation) return;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!isSocketFrame(parsed)) return;
        this.onEvent(parsed.type, parsed.payload);
      } catch (error) {
        console.warn("WS 消息解析失败", error);
      }
    });
  }

  close() {
    this.manualClose = true;
    this.generation += 1;
    this.clearTimers();
    const current = this.socket;
    this.socket = null;
    current?.close();
    this.notifyStatus(false);
    this.debugLog("connect:manual-close");
  }

  send(type: string, payload: unknown) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type, payload }));
  }
}

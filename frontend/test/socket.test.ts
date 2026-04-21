import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SocketClient } from "../src/socket";

type Listener = (event?: { code?: number; reason?: string; data?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  /**
   * 注册事件监听器，模拟浏览器 WebSocket 行为。
   */
  addEventListener(type: string, listener: Listener) {
    const current = this.listeners.get(type) || [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  /**
   * 发送消息，记录到本地数组便于断言。
   */
  send(data: string) {
    this.sent.push(data);
  }

  /**
   * 关闭连接并触发 close 事件。
   */
  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  /**
   * 主动触发 open 事件。
   */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  /**
   * 主动触发 close 事件。
   */
  triggerClose(code = 1006, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  /**
   * 主动触发 message 事件。
   */
  triggerMessage(data: string) {
    this.emit("message", { data });
  }

  private emit(type: string, event: { code?: number; reason?: string; data?: string } = {}) {
    (this.listeners.get(type) || []).forEach((listener) => listener(event));
  }
}

describe("SocketClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("手动 close 后不应继续重连", () => {
    const onStatus = vi.fn();
    const client = new SocketClient("token-a", 3, vi.fn(), onStatus);
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    client.close();
    ws.triggerClose(1000, "manual-close");
    vi.advanceTimersByTime(20_000);

    expect(FakeWebSocket.instances.length).toBe(1);
    expect(onStatus.mock.calls).toEqual([[true], [false]]);
  });

  it("重复 close 事件不应重复发送 false 状态", () => {
    const onStatus = vi.fn();
    const client = new SocketClient("token-b", 8, vi.fn(), onStatus);
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    ws.triggerClose(1006, "network-1");
    ws.triggerClose(1006, "network-2");

    expect(onStatus.mock.calls).toEqual([[true], [false]]);
  });

  it("旧世代连接事件不应污染新连接状态", () => {
    const onStatus = vi.fn();
    const client = new SocketClient("token-c", 12, vi.fn(), onStatus);
    client.connect();
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    ws1.triggerClose(1006, "drop");

    client.connect();
    const ws2 = FakeWebSocket.instances[1];
    ws1.open();
    ws2.open();

    const statusTrueCount = onStatus.mock.calls.filter((call) => call[0] === true).length;
    expect(statusTrueCount).toBe(2);
  });
});

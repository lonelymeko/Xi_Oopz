import { describe, expect, it } from "vitest";

import { clearSession, loadSession, saveSession } from "../src/services/session";

describe("session service", () => {
  it("应支持会话的写入读取与清理", () => {
    clearSession();
    saveSession({ token: "abc", user: { id: 1 } });
    expect(loadSession<{ token: string; user: { id: number } }>()).toEqual({ token: "abc", user: { id: 1 } });
    clearSession();
    expect(loadSession()).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchBootstrap, loginAccount } from "../src/api";

describe("api service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("登录失败时应优先返回接口错误信息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: "凭证无效" }),
      }),
    );

    await expect(loginAccount({ email: "a@b.com", password: "x" })).rejects.toThrow("凭证无效");
  });

  it("应拼接 bootstrap 查询参数", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchBootstrap("token-1", 2, 9);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstArg = fetchMock.mock.calls[0][0] as string;
    expect(firstArg).toContain("/api/bootstrap?");
    expect(firstArg).toContain("channelId=2");
    expect(firstArg).toContain("domainId=9");
  });
});

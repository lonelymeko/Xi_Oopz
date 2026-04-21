import { describe, expect, it } from "vitest";

import { liveFacade } from "../src/services/liveFacade";

/**
 * 门面层基础测试：确保关键能力已对外暴露。
 */
describe("liveFacade", () => {
  it("应暴露基础鉴权与引导能力", () => {
    expect(typeof liveFacade.loginAccount).toBe("function");
    expect(typeof liveFacade.fetchBootstrap).toBe("function");
    expect(typeof liveFacade.fetchDomainPresence).toBe("function");
  });
});

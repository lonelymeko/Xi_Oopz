import { defineConfig } from "vitest/config";

/**
 * Vitest 配置：当前以工具与服务层单测为主。
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});

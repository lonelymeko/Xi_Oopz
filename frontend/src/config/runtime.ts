export type RuntimeConfig = {
  apiBaseUrl: string;
  wsBaseUrl: string;
};

let runtimeConfigCache: RuntimeConfig | null = null;
let runtimeConfigLogged = false;

/**
 * 判断当前是否启用强制直连校验。
 */
function isStrictRuntime(): boolean {
  return import.meta.env.MODE !== "test";
}

/**
 * 去除 URL 末尾斜杠，避免路径拼接出现双斜杠。
 */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * 校验并标准化 HTTP API 基础地址。
 */
function normalizeApiBaseUrl(rawValue: string): string {
  const value = trimTrailingSlash(rawValue.trim());
  if (!value) {
    return "";
  }
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`VITE_API_BASE_URL 非法：${value}，必须以 http:// 或 https:// 开头。`);
  }
  return value;
}

/**
 * 将 HTTP 基础地址转换为 WS 基础地址。
 */
function deriveWsBaseUrlFromApi(apiBaseUrl: string): string {
  if (!apiBaseUrl) {
    if (typeof window !== "undefined" && window.location?.host) {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//${window.location.host}`;
    }
    return "";
  }
  if (apiBaseUrl.startsWith("https://")) {
    return apiBaseUrl.replace("https://", "wss://");
  }
  return apiBaseUrl.replace("http://", "ws://");
}

/**
 * 校验并标准化 WS 基础地址，缺失时由 API 地址推导。
 */
function normalizeWsBaseUrl(rawValue: string, apiBaseUrl: string): string {
  const source = rawValue.trim() ? trimTrailingSlash(rawValue.trim()) : deriveWsBaseUrlFromApi(apiBaseUrl);
  if (!source && !isStrictRuntime()) {
    return "";
  }
  if (!/^wss?:\/\//i.test(source)) {
    throw new Error(`VITE_WS_BASE_URL 非法：${source}，必须以 ws:// 或 wss:// 开头。`);
  }
  return source;
}

/**
 * 解析运行时配置并进行强校验。
 */
function resolveRuntimeConfig(): RuntimeConfig {
  const apiBaseUrl = normalizeApiBaseUrl(String(import.meta.env.VITE_API_BASE_URL || ""));
  const wsBaseUrl = normalizeWsBaseUrl(String(import.meta.env.VITE_WS_BASE_URL || ""), apiBaseUrl);
  return {
    apiBaseUrl,
    wsBaseUrl,
  };
}

/**
 * 获取运行时配置（带缓存），保证全局只解析一次。
 */
export function getRuntimeConfig(): RuntimeConfig {
  if (runtimeConfigCache) return runtimeConfigCache;
  runtimeConfigCache = resolveRuntimeConfig();
  return runtimeConfigCache;
}

/**
 * 拼接 API 绝对地址，禁止传入非斜杠开头路径。
 */
export function buildApiUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`API 路径必须以 / 开头，收到：${path}`);
  }
  const { apiBaseUrl } = getRuntimeConfig();
  if (!apiBaseUrl) return path;
  return `${apiBaseUrl}${path}`;
}

/**
 * 拼接 WS 绝对地址，禁止传入非斜杠开头路径。
 */
export function buildWsUrl(pathWithQuery: string): string {
  if (!pathWithQuery.startsWith("/")) {
    throw new Error(`WS 路径必须以 / 开头，收到：${pathWithQuery}`);
  }
  const { wsBaseUrl } = getRuntimeConfig();
  if (!wsBaseUrl) return pathWithQuery;
  return `${wsBaseUrl}${pathWithQuery}`;
}

/**
 * 仅在开发环境输出一次运行时配置，便于排障确认。
 */
export function logRuntimeConfigOnce() {
  if (!import.meta.env.DEV || runtimeConfigLogged) return;
  const { apiBaseUrl, wsBaseUrl } = getRuntimeConfig();
  console.info("[runtime] 直连配置已生效", { apiBaseUrl, wsBaseUrl });
  runtimeConfigLogged = true;
}

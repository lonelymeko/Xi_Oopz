const STORAGE_KEY = "oopz.live.session";

/**
 * 从本地存储读取会话对象。
 */
export function loadSession<T>(): T | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

/**
 * 将会话对象写入本地存储。
 */
export function saveSession<T>(session: T) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

/**
 * 清理本地存储中的会话对象。
 */
export function clearSession() {
  window.localStorage.removeItem(STORAGE_KEY);
}

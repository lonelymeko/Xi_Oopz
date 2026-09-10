import { useCallback, useRef, useState } from "react";

import type { Notice } from "../types/live";

/**
 * 通知领域 Hook：统一管理通知队列与自动清理。
 */
export function useNoticeDomain() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeIdRef = useRef(0);
  const noticeTimersRef = useRef(new Map<number, number>());

  /**
   * 推送通知并设置自动销毁。
   */
  const pushNotice = useCallback((kind: Notice["kind"], title: string, message: string) => {
    const id = noticeIdRef.current + 1;
    noticeIdRef.current = id;
    setNotices((current) => [...current, { id, kind, title, message }]);
    const timer = window.setTimeout(
      () => {
        setNotices((current) => current.filter((item) => item.id !== id));
        noticeTimersRef.current.delete(id);
      },
      kind === "error" ? 6400 : 4200,
    );
    noticeTimersRef.current.set(id, timer);
  }, []);

  /**
   * 关闭指定通知并释放定时器。
   */
  const dismissNotice = useCallback((id: number) => {
    const timer = noticeTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      noticeTimersRef.current.delete(id);
    }
    setNotices((current) => current.filter((item) => item.id !== id));
  }, []);

  /**
   * 推一条常驻的进度通知（不自动消失），返回 id 供后续更新。
   * 用于下载这类需要持续展示进度的长任务。
   */
  const pushProgressNotice = useCallback((title: string, message: string, progress = 0) => {
    const id = noticeIdRef.current + 1;
    noticeIdRef.current = id;
    setNotices((current) => [...current, { id, kind: "info", title, message, progress }]);
    return id;
  }, []);

  /**
   * 原地更新进度通知的进度与文案（通知不重建，避免闪烁）。
   */
  const updateNoticeProgress = useCallback((id: number, progress: number, message?: string) => {
    setNotices((current) => current.map((item) => (item.id === id ? { ...item, progress, message: message ?? item.message } : item)));
  }, []);

  /**
   * 结束一条进度通知：清掉进度条、转成终态文案并恢复自动消失；
   * `dismiss` 为 true 时直接关闭（例如用户取消下载）。
   */
  const settleNotice = useCallback((id: number, kind: Notice["kind"], title: string, message: string, options?: { dismiss?: boolean }) => {
    const existing = noticeTimersRef.current.get(id);
    if (existing) {
      window.clearTimeout(existing);
      noticeTimersRef.current.delete(id);
    }
    if (options?.dismiss) {
      setNotices((current) => current.filter((item) => item.id !== id));
      return;
    }
    setNotices((current) => current.map((item) => (item.id === id ? { ...item, kind, title, message, progress: null } : item)));
    const timer = window.setTimeout(
      () => {
        setNotices((current) => current.filter((item) => item.id !== id));
        noticeTimersRef.current.delete(id);
      },
      kind === "error" ? 6400 : 4200,
    );
    noticeTimersRef.current.set(id, timer);
  }, []);

  /**
   * 解析错误消息并回退到默认文案。
   */
  const resolveErrorMessage = useCallback((error: unknown, fallback: string) => {
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }
    return fallback;
  }, []);

  /**
   * 推送错误通知并返回最终展示文案。
   */
  const showError = useCallback(
    (error: unknown, title: string, fallback: string) => {
      const message = resolveErrorMessage(error, fallback);
      pushNotice("error", title, message);
      return message;
    },
    [pushNotice, resolveErrorMessage],
  );

  /**
   * 推送普通信息通知。
   */
  const showInfo = useCallback(
    (title: string, message: string) => {
      pushNotice("info", title, message);
    },
    [pushNotice],
  );

  /**
   * 统一清理所有通知定时器。
   */
  const clearAllNoticeTimers = useCallback(() => {
    noticeTimersRef.current.forEach((timer) => {
      window.clearTimeout(timer);
    });
    noticeTimersRef.current.clear();
  }, []);

  return {
    notices,
    pushNotice,
    pushProgressNotice,
    updateNoticeProgress,
    settleNotice,
    dismissNotice,
    resolveErrorMessage,
    showError,
    showInfo,
    clearAllNoticeTimers,
  };
}

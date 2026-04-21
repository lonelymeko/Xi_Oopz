import type { PeerConnectionDiagnostics } from "../types";

/**
 * 将昵称转换为头像首字母。
 */
export function initials(name?: string) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

/**
 * 按中文语义格式化时间展示。
 */
export function formatTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  const timeText = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfTarget.getTime()) / 86400000);

  if (diffDays === 0) return timeText;
  if (diffDays === 1) return `昨天 ${timeText}`;
  if (diffDays === 2) return `前天 ${timeText}`;

  const currentWeekday = (startOfToday.getDay() + 6) % 7;
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - currentWeekday);
  if (startOfTarget >= startOfWeek && diffDays > 2) {
    const weekdayText = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"][(date.getDay() + 6) % 7];
    return `${weekdayText} ${timeText}`;
  }

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月 ${date.getDate()}日 ${timeText}`;
  }

  return `${date.getFullYear()}年 ${date.getMonth() + 1}月 ${date.getDate()}日 ${timeText}`;
}

/**
 * 判断 URL 是否可能为直播流地址。
 */
export function isLikelyLiveScreeningURL(value?: string | null) {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return false;
  return (
    raw.includes("live.bilibili.com") ||
    raw.includes(".m3u8") ||
    raw.includes(".flv") ||
    raw.includes("stream=live") ||
    raw.includes("livestream")
  );
}

/**
 * 格式化网络链路诊断文案。
 */
export function formatPeerDiagnostics(diagnostics: PeerConnectionDiagnostics) {
  const transportText =
    diagnostics.transport === "turn"
      ? "TURN"
      : diagnostics.transport === "stun"
        ? "STUN"
        : diagnostics.transport === "lan"
          ? "局域网"
          : "未知";
  const latencyText = diagnostics.latencyMs != null ? `${diagnostics.latencyMs}ms` : "--";
  return `${transportText} · ${latencyText}`;
}

/**
 * 对聊天内容进行最小 HTML 转义。
 */
export function escapeHTML(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * 选择最优输入设备 ID：优先保留当前设备，其次选择非系统占位设备。
 */
export function pickPreferredAudioInputId(inputs: Array<{ deviceId: string; label: string }>, currentId: string) {
  if (currentId && inputs.some((item) => item.deviceId === currentId)) {
    return currentId;
  }
  return (
    inputs.find((item) => item.deviceId && item.deviceId !== "default" && item.deviceId !== "communications")?.deviceId ||
    inputs.find((item) => item.deviceId)?.deviceId ||
    ""
  );
}

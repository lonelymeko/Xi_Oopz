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
 * 判断 URL 是否明确指向直播流。
 * HLS 的 .m3u8 既可用于直播也可用于点播，不能仅凭扩展名判定为直播。
 */
export function isLikelyLiveScreeningURL(value?: string | null) {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return false;
  return (
    raw.includes("live.bilibili.com") ||
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
 * 把 enumerateDevices 的音频输入设备整理成下拉选项。
 *
 * Chrome 会把系统默认设备额外暴露成 deviceId="default" 的条目，标签形如
 * "默认 - 麦克风阵列"；这里统一改写成"系统默认（设备名）"，让用户能直接看出
 * 当前跟随的是系统设置里的哪一只麦克风。
 */
export function mapAudioInputDevices(devices: MediaDeviceInfo[]): Array<{ deviceId: string; label: string }> {
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => {
      const rawLabel = device.label || `麦克风 ${index + 1}`;
      if (device.deviceId === "default" || device.deviceId === "communications") {
        const prefix = device.deviceId === "default" ? "系统默认" : "通讯默认";
        const deviceName = device.label
          ? device.label.replace(/^(default|communications|默认|通讯设备)\s*[-–—:：]\s*/i, "").trim()
          : "";
        return { deviceId: device.deviceId, label: deviceName ? `${prefix}（${deviceName}）` : prefix };
      }
      return { deviceId: device.deviceId, label: rawLabel };
    });
}

/**
 * 选择默认输入设备 ID：优先保留用户当前选择，否则跟随系统默认麦克风。
 *
 * 浏览器返回的具体设备顺序是内部固定序（看上去像按名称排序），直接取第一个
 * 会选到与系统设置无关的设备。Chrome/Edge 用 deviceId="default" 表达"系统当前
 * 默认"，因此优先选它；Firefox 不暴露该条目，但其枚举首项即系统默认，兜底取首项。
 */
export function pickPreferredAudioInputId(inputs: Array<{ deviceId: string; label: string }>, currentId: string) {
  if (currentId && inputs.some((item) => item.deviceId === currentId)) {
    return currentId;
  }
  return (
    inputs.find((item) => item.deviceId === "default")?.deviceId ||
    inputs.find((item) => item.deviceId === "communications")?.deviceId ||
    inputs.find((item) => item.deviceId)?.deviceId ||
    ""
  );
}

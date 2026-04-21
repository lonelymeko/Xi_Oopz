import React from "react";
import ReactDOM from "react-dom/client";

import "vidstack/define/media-player";
import "vidstack/define/media-outlet";
import "vidstack/define/media-community-skin";
import "vidstack/styles/base.css";
import "vidstack/styles/defaults.css";
import "vidstack/styles/ui/buttons.css";
import "vidstack/styles/ui/sliders.css";
import "vidstack/styles/ui/menus.css";
import "vidstack/styles/ui/tooltips.css";
import "vidstack/styles/ui/buffering.css";
import "vidstack/styles/ui/live.css";
import "vidstack/styles/ui/captions.css";
import "vidstack/styles/community-skin/video.css";

import { App } from "./App";
import { logRuntimeConfigOnce } from "./config/runtime";
import "./styles/index.css";

/**
 * 渲染启动阶段的致命错误，避免页面无反馈空白。
 */
function renderStartupError(message: string) {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;background:#0f1115;color:#f4f6fb;font-family:PingFang SC,Microsoft YaHei,sans-serif;">
      <div style="max-width:720px;padding:20px 24px;border:1px solid rgba(255,255,255,0.12);border-radius:12px;background:rgba(255,255,255,0.04);line-height:1.6;">
        <h2 style="margin:0 0 10px 0;font-size:20px;">前端启动失败</h2>
        <p style="margin:0;">${message}</p>
      </div>
    </div>
  `;
}

try {
  logRuntimeConfigOnce();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  console.error("应用启动失败", error);
  const message = error instanceof Error ? error.message : "运行时配置异常，请检查环境变量后重试。";
  renderStartupError(message);
}

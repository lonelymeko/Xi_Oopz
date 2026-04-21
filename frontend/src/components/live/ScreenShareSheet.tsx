import type { ScreenAudioMode, ScreenShareSurface } from "../../rtc";

type ScreenSharePreset = {
  surface: ScreenShareSurface;
  audioMode: ScreenAudioMode;
};

/**
 * 屏幕共享设置弹层：用于选择共享范围与音频策略。
 */
export function ScreenShareSheet({
  preset,
  onChange,
  onCancel,
  onConfirm,
}: {
  preset: ScreenSharePreset;
  onChange: (next: ScreenSharePreset) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const currentModeLabel = preset.surface === "tab" ? "共享当前标签页音频（推荐）" : "共享系统音频（高风险）";
  const riskText =
    preset.surface === "tab"
      ? "浏览器支持时会尽量启用 restrictOwnAudio 和 suppressLocalAudioPlayback，优先避免把当前通话页自己的声音再录进去。"
      : "系统音频可能把远端通话声、通知声一起共享出去。建议佩戴耳机，或改用“共享标签页音频”。";

  return (
    <div className="screen-share-sheet">
      <div className="screen-share-sheet__backdrop" onClick={onCancel} />
      <div className="screen-share-sheet__panel" role="dialog" aria-modal="true" aria-label="屏幕共享设置">
        <div className="eyebrow">SCREEN SHARE</div>
        <h3>选择共享方式</h3>
        <p className="screen-share-sheet__summary">
          主流会议产品通常优先推荐标签页音频；共享整个屏幕时，只能尽量降低把远端声音也带出去的风险。
        </p>

        <div className="screen-share-sheet__section">
          <strong>共享范围</strong>
          <div className="screen-share-sheet__choices">
            <button
              className={`screen-share-choice ${preset.surface === "tab" ? "screen-share-choice--active" : ""}`}
              onClick={() => onChange({ ...preset, surface: "tab" })}
            >
              <span>浏览器标签页</span>
              <small>适合教程、网页演示，音频控制更稳</small>
            </button>
            <button
              className={`screen-share-choice ${preset.surface === "screen" ? "screen-share-choice--active" : ""}`}
              onClick={() => onChange({ ...preset, surface: "screen" })}
            >
              <span>整个屏幕 / 窗口</span>
              <small>更通用，但共享系统音频时风险更高</small>
            </button>
          </div>
        </div>

        <div className="screen-share-sheet__section">
          <strong>音频</strong>
          <div className="screen-share-sheet__toggle-row">
            <button
              className={`screen-share-chip ${preset.audioMode === "off" ? "screen-share-chip--active" : ""}`}
              onClick={() => onChange({ ...preset, audioMode: "off" })}
            >
              不共享音频
            </button>
            <button
              className={`screen-share-chip ${preset.audioMode === "share" ? "screen-share-chip--active" : ""}`}
              onClick={() => onChange({ ...preset, audioMode: "share" })}
            >
              {currentModeLabel}
            </button>
          </div>
          <p className={`screen-share-sheet__risk ${preset.audioMode === "share" ? "screen-share-sheet__risk--warning" : ""}`}>
            {preset.audioMode === "share" ? riskText : "只共享画面，不采集标签页或系统音频。"}
          </p>
        </div>

        <div className="screen-share-sheet__actions">
          <button className="action-pill" onClick={onCancel}>
            取消
          </button>
          <button className="action-pill action-pill--primary" onClick={onConfirm}>
            选择源并开始共享
          </button>
        </div>
      </div>
    </div>
  );
}

import { CloseIcon } from "./icons";
import type { Notice } from "../../types/live";

/**
 * 通知视图组件：用于渲染右上角通知列表。
 * 带 progress 的通知会额外渲染进度条（下载等长任务统一走这里）。
 */
export function NoticeViewport({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  if (!notices.length) return null;
  return (
    <div className="notice-viewport" role="status" aria-live="polite">
      {notices.map((notice) => {
        const progress = typeof notice.progress === "number" ? Math.min(100, Math.max(0, notice.progress)) : null;
        return (
          <div key={notice.id} className={`notice-card notice-card--${notice.kind}`}>
            <div className="notice-card__body">
              <strong>{notice.title}</strong>
              <p>{notice.message}</p>
              {progress != null ? (
                <div
                  className="notice-card__progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                  aria-label={notice.title}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
              ) : null}
            </div>
            <button className="notice-card__close" onClick={() => onDismiss(notice.id)} aria-label="关闭通知">
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}

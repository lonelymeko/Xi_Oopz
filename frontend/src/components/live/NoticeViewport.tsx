import { CloseIcon } from "./icons";

type NoticeItem = {
  id: number;
  kind: "error" | "info";
  title: string;
  message: string;
};

/**
 * 通知视图组件：用于渲染顶部通知列表。
 */
export function NoticeViewport({ notices, onDismiss }: { notices: NoticeItem[]; onDismiss: (id: number) => void }) {
  if (!notices.length) return null;
  return (
    <div className="notice-viewport" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice-card notice-card--${notice.kind}`}>
          <div className="notice-card__body">
            <strong>{notice.title}</strong>
            <p>{notice.message}</p>
          </div>
          <button className="notice-card__close" onClick={() => onDismiss(notice.id)} aria-label="关闭通知">
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

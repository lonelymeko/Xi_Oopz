import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

/**
 * 局部错误边界：把某个面板的渲染异常限制在该面板内。
 *
 * 背景：放映室 <media-player>（vidstack）在收到非法 src 时会抛渲染异常；React 在
 * 没有错误边界时会把整棵组件树卸载，导致 WebRTC/信令 effect 全部 cleanup —— 表现为
 * 「放视频把连麦一起搞断」。这里兜住异常，只替换出错面板，保证语音/信令不受影响。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("panel render error", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="empty-state">该面板渲染出错了，请刷新页面重试。</div>
        )
      );
    }
    return this.props.children;
  }
}

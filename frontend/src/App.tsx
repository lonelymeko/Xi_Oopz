import { LivePage } from "./pages/LivePage";

/**
 * 应用根组件：仅负责挂载页面容器，避免业务逻辑集中在入口文件。
 */
export function App() {
  return <LivePage />;
}

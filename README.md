# Oopz Live

一个参考 Discord 交互方式实现的实时语音、文字聊天、屏幕共享 Web 应用。

项目当前定位是一个可运行、可继续扩展的 MVP，适合做以下场景的原型或二次开发：

- 游戏开黑语音房
- 小团队在线协作
- 轻量级社区频道
- WebRTC / Gin / WebSocket 实时系统练手项目

## 使用截图
<img width="1280" height="680" alt="a956294c2b584c2b0df1248c22b35649" src="https://github.com/user-attachments/assets/3e9051fe-62ee-4fb0-9175-91465b61830b" />
<img width="3420" height="1994" alt="a60c9321fbbc31e666af0bc13dabc1a7" src="https://github.com/user-attachments/assets/ac233fb8-e756-4409-93c0-b516ed5be058" />


## 在线能力

- 邮箱验证码注册与登录
- 多域 Domain 切换
- 文字频道 / 语音频道
- 频道文字消息实时广播与持久化
- 语音频道在线成员实时同步
- 麦克风开关状态同步
- 屏幕共享状态同步
- WebRTC 音频通话
- WebRTC 屏幕共享
- 远端音频音量调节
- 语音 / 共享断流后的自动补连
- Discord 风格三栏桌面 UI

## 近期提交重点

最近几次提交主要围绕 WebRTC 在真实网络波动下的稳定性做了修复：

- TURN 断线后不再只依赖 ICE restart，relay 链路异常时会通过局部重建 PeerConnection 恢复连接，避免用户被误判为直接退出频道。
- 修复 TURN 重连后单向无声问题：重连、重新协商、收到 offer/answer 前后都会刷新本地 outbound 音频轨道，屏幕共享音频也会被当作有效音频源处理。
- 增加重连成功后的延迟 sender rehydrate：对浏览器可能保留旧 RTCRtpSender 但实际不发 RTP 的情况，使用 `replaceTrack(null -> track)` 强制刷新发送管线，避免手机端必须手动关麦再开麦。
- 清理了早期依赖自动 toggleMic 的补丁思路，避免污染用户真实的麦克风静音状态。
- 修复本地屏幕共享小窗黑屏：小窗预览会同时监听 `screenSharing` 和 `screenStream`，确保 video 元素渲染后重新绑定本地共享流；放大预览与小窗预览表现保持一致。
- 在头像旁加入前端调试版本号，便于确认浏览器实际加载的是否为最新前端资源。

## 技术栈

- 前端：React + TypeScript + Vite
- 后端：Gin + GORM + WebSocket
- 数据库：MySQL
- 缓存 / 在线状态：Redis
- 实时音视频：浏览器 WebRTC Mesh

## 项目交互方向

当前 UI 以桌面端频道社交产品为目标，重点参考 Discord / Oopz 这类布局：

- 左侧域列表
- 中间频道树与消息区
- 右侧在线成员区
- 顶部语音控制条
- 语音头像说话高亮
- 共享屏预览与放大 / 全屏

## 适用边界

当前版本采用 WebRTC Mesh 拓扑，每个用户会和房间内其他用户分别建立连接，因此更适合小房间：

- 建议单个语音房控制在 6 人以内
- 屏幕共享适合少量同时观看用户
- 如果要做大房间，建议下一步切到 SFU 架构

## 核心功能说明

### 账号系统

- 邮箱验证码发送
- 注册
- 登录
- Bearer Token 鉴权
- 获取当前用户信息

### 域 / 频道系统

- 所有登录用户默认可见所有域
- 用户进入域后会被加入域成员列表
- 每个域有独立域主
- 域主可创建文字频道和语音频道

### 实时消息

- 普通聊天消息通过 WebSocket 广播
- 普通聊天消息落 MySQL
- 语音房加入 / 离开消息只做瞬时广播，不写库
- 麦克风 / 屏幕共享状态通过 WebSocket 同步

### WebRTC

- `offer / answer / ice_candidate` 走 WebSocket 转发
- TURN / STUN 支持
- 麦克风热切换
- 浏览器基础降噪约束
- 屏幕共享自动重协商
- 音频 / 屏幕断流自动补连

## 仓库结构

```text
.
├── cmd/server                 # Gin 服务入口
├── deploy
│   ├── nginx                  # Nginx 部署模板
│   └── systemd                # systemd 服务模板
├── docs                       # 架构说明
├── frontend                   # React 前端
├── internal
│   ├── app                    # 应用启动与路由
│   ├── auth                   # token 鉴权
│   ├── config                 # 配置读取
│   ├── httpapi                # HTTP 接口
│   ├── models                 # 数据模型
│   ├── notify                 # 邮件发送
│   ├── realtime               # WebSocket Hub
│   └── store                  # GORM + 数据访问
├── migrations                 # 初始化 SQL
├── release                    # 部署目录（构建产物不入库）
└── scripts                    # 启动与辅助脚本
```

## 本地开发

### 1. 启动依赖

```bash
docker compose up -d
```

### 2. 启动后端

```bash
go mod tidy
go run ./cmd/server
```

服务启动时会执行 `GORM AutoMigrate`，自动确保所需表结构存在。

### 3. 启动前端开发环境

```bash
cd frontend
pnpm install
pnpm dev
```

前端开发环境默认采用“直连后端”模式（不经过 Vite 代理），请先配置：

```bash
cd frontend
# Windows PowerShell 示例
@"
VITE_API_BASE_URL=https://oopz.xixiu.top
VITE_WS_BASE_URL=wss://oopz.xixiu.top
"@ | Set-Content .env.development
```

如果你改过配置但浏览器仍命中旧地址，请先停止已有 `vite` 进程再重新执行 `pnpm dev`。

推荐在本地提交流程中执行：

```bash
cd frontend
pnpm lint
pnpm run format:check
pnpm run test:run
```

开发模式访问：

```text
http://localhost:5173
```

### 4. 让 Gin 直接服务前端

```bash
cd frontend
pnpm install
pnpm run build
cd ..
go run ./cmd/server
```

后端直出访问：

```text
http://localhost:8080
```

## 环境变量

常用环境变量如下：

- `PORT`
- `MYSQL_DSN`
- `REDIS_ADDR`
- `REDIS_PASSWORD`
- `AUTH_SECRET`
- `EMAIL_ENABLED`
- `EMAIL_HOST`
- `EMAIL_PORT`
- `EMAIL_USER`
- `EMAIL_PASSWORD`
- `EMAIL_FROM_NAME`
- `WEBRTC_STUN_URLS`
- `WEBRTC_TURN_URLS`
- `WEBRTC_TURN_USERNAME`
- `WEBRTC_TURN_CREDENTIAL`

### WebRTC ICE 环境变量示例

```bash
# 多个地址使用逗号分隔
WEBRTC_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
WEBRTC_TURN_URLS=turn:turn.xixiu.top:3478,turn:turn.xixiu.top:3478?transport=tcp
WEBRTC_TURN_USERNAME=xixiu
WEBRTC_TURN_CREDENTIAL=123456
```

生产环境请通过密钥系统或部署环境变量注入 TURN 凭据，避免把凭据写入代码仓库。

## 主要接口

### 鉴权

- `POST /api/auth/send-verification-code`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

### 域 / 频道

- `POST /api/domains`
- `GET /api/domains/:domainId`
- `PATCH /api/domains/:domainId`
- `GET /api/domains/:domainId/members`
- `GET /api/domains/:domainId/channels`
- `GET /api/domains/:domainId/presence`
- `POST /api/domains/:domainId/categories`
- `POST /api/domains/:domainId/channels`
- `PATCH /api/channels/:channelId`

### 消息

- `GET /api/domains/:domainId/channels/:channelId/messages`

### WebSocket 事件

常见事件包括：

- `channel.join`
- `channel.leave`
- `chat.send`
- `chat.message`
- `voice.state`
- `screen.state`
- `rtc.offer`
- `rtc.answer`
- `rtc.ice_candidate`
- `media.sync_request`

## 部署说明

项目支持直接部署到已有 MySQL / Redis 的服务器环境，不依赖 Docker 运行。

### 推荐部署方式

- Nginx：负责 HTTPS、静态文件、WebSocket 反向代理
- Gin：只监听本机 HTTP 端口，例如 `127.0.0.1:18080`
- MySQL：使用服务器已有实例
- Redis：使用服务器已有实例

### 部署产物

仓库仅保留部署模板与源码，不再提交预构建二进制。  
发布时请通过仓库外手工分发方式获取二进制，并放入部署目录：

- Linux `amd64` 二进制：`release/oopz-live-linux-amd64`（手工分发）
- Linux `arm64` 二进制：`release/oopz-live-linux-arm64`（手工分发）
- Nginx 模板：`deploy/nginx/oopz.xixiu.top.conf`
- systemd 模板：`deploy/systemd/oopz-live.service`

### 典型目录结构

```text
/home/oopz/oopz-live/
├── frontend/dist
├── release/oopz-live-linux-amd64
└── .env
```

### 仓库边界约定

- 可跟踪：源码、配置模板、脚本、文档。
- 不可跟踪：构建产物与本地发布二进制（如 `release/`、`frontend/dist/`、`*.tsbuildinfo`）。

### systemd

将模板复制到：

```text
/etc/systemd/system/oopz-live.service
```

然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable oopz-live
sudo systemctl start oopz-live
sudo systemctl status oopz-live
```

查看日志：

```bash
sudo journalctl -u oopz-live -f
```

### Nginx

将模板复制到：

```text
/etc/nginx/conf.d/oopz.xixiu.top.conf
```

或按你的系统习惯放到：

```text
/etc/nginx/sites-available/oopz.xixiu.top.conf
/etc/nginx/sites-enabled/oopz.xixiu.top.conf
```

检查与重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## TURN / STUN

当前前端默认内置：

- Google STUN
- 自定义 TURN

如果你准备公开部署，建议使用你自己的 TURN 配置，并把凭据改成环境变量或服务端下发，而不是写死在前端代码里。

## 当前实现说明

### 本次修补说明

这一次主要集中修了语音房在线状态、WebRTC 重连链路，以及 TURN 诊断可观测性。

已修复的问题：

- 用户异常退出浏览器或 WebSocket 断开后，可能仍残留在 Redis 的频道在线列表里，导致同一个账号看起来同时挂在多个频道。
- 用户退出语音频道后，前端仍可能继续响应残留的 RTC 信令，出现“已经退出频道，但别人还能听到声音”的异常。
- 首轮 WebRTC 协商在部分情况下会重复创建 peer、重复发送 offer，导致 `answer ignored`、`m-line` 顺序异常，以及后续 TURN fallback 判断失真。
- TURN / STUN 切换过程之前缺少足够日志，难以判断到底是没有拿到 relay candidate，还是虽然拿到了但没有被选中。

本次改进：

- 后端在用户加入频道前，会先清理该用户在其它语音频道和放映室中的残留成员记录，保证单用户同一时间只在一个频道在线。
- 后端在 WebSocket 连接完全断开且该用户没有其它活跃连接时，会把该用户从所有 Redis presence / screening viewers 中兜底清除，并同步移出在线状态。
- 前端语音会话增加了显式的 `voiceSessionActive` 保护；离开频道后不再处理新的 RTC 信令或重连流程，避免被远端残留消息重新拉起 PeerConnection。
- WebRTC 首次建连现在默认同时下发 STUN + TURN，并使用 `iceTransportPolicy: "all"`；首次失败先 `ICE restart`，再次失败再升级为 `relay-only` 重建。
- 前端补充了 ICE 配置、candidate、selected pair、频道状态变更等调试日志，便于排查“为何自动离房”“为何没有切到 TURN”“为何退出后音频未停”等问题。
- 连接诊断面板现在会显示实际链路类型（局域网 / STUN / TURN）、RTT、重试次数，以及当前恢复方式（稳定 / ICE 重启 / TURN 中继）。

### 关于“降噪”

当前项目里的“降噪”不是独立 AI 降噪引擎，而是浏览器 `getUserMedia` 约束：

- `noiseSuppression`
- `echoCancellation`
- `autoGainControl`

它属于浏览器 / 系统级基础音频处理，不等于专门的第三方实时降噪方案。

### 关于耳机静听

耳机按钮表示“静听”模式：

- 开启后听不到任何远端声音
- 同时会自动关闭本地麦克风
- 耳机悬浮面板里可以调远端音量

## 测试建议

### 双端联调

1. 打开两个浏览器会话
2. 分别注册两个账号
3. 进入同一个语音频道
4. 测试双向语音
5. 测试文字消息
6. 测试屏幕共享与恢复

### 公网测试

公网部署时，请重点确认：

- 站点启用了 HTTPS
- WebSocket 走 `wss`
- Nginx 没有错误限制 `microphone` / `display-capture`
- TURN 服务器可达

## 已知限制

- 目前是 Mesh 架构，不适合大房间
- 前端状态与 UI 仍以桌面端为主，移动端未专门优化
- 屏幕共享与 RTC 恢复逻辑仍属于工程化增强版 MVP，不是 SFU 级实现
- 多实例部署时，WebSocket 广播层还需要补 Redis Pub/Sub 或消息总线

## 后续方向

- 引入好友 / 邀请体系
- 域角色与权限细化
- 频道排序 / 删除 / 转移管理
- 更稳定的 WebRTC 策略与统计面板
- SFU 架构升级
- 移动端与桌面壳封装

---

如果这个项目对你有帮助，欢迎继续扩展成更完整的实时社交 / 协作平台。

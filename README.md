# Oopz Live
前端体验地址：https://oopz.xixiu.top

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
- 放映室频道：直链视频同步播放、播放列表、控制权转移
- 频道文字消息实时广播与持久化
- 语音频道在线成员实时同步
- 麦克风开关状态同步
- 屏幕共享状态同步
- WebRTC 音频通话
- WebRTC 屏幕共享，支持本地预览、放大与系统全屏
- 屏幕共享音频：支持标签页音频 / 系统音频采集策略
- 远端音频音量调节
- 语音 / 共享断流后的自动补连与 TURN 重连恢复
- 连接诊断：显示局域网 / STUN / TURN 链路、RTT 与重连状态
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
├── migrations                 # 早期 SQL 迁移参考，当前启动由 GORM AutoMigrate 建表
└── release                    # 部署目录（构建产物不入库）
```

## Docker 一键运行

当前 `Dockerfile` 会先构建 React/Vite 前端，再编译 Go 后端；`docker-compose.yml` 会同时启动应用、MySQL 8.4 和 Redis 7.4。用户只需要安装 Docker，就可以把前后端和依赖一起跑起来。

```bash
docker compose up --build -d
docker compose ps
```

访问：

```text
http://localhost:8080
```

健康检查：

```bash
curl http://localhost:8080/healthz
```

默认端口：

- Web 应用：宿主 `8080` -> 容器 `8080`
- MySQL：宿主 `3307` -> 容器 `3306`
- Redis：宿主 `6379` -> 容器 `6379`

常用覆盖项可以直接放在仓库根目录 `.env`，Docker Compose 会自动读取：

```env
APP_PORT=8080
GIN_MODE=release
MYSQL_ROOT_PASSWORD=password
MYSQL_DATABASE=oopz
MYSQL_PORT=3307
REDIS_PORT=6379
REDIS_PASSWORD=
AUTH_SECRET=replace-with-a-strong-random-secret
EMAIL_ENABLED=false
WEBRTC_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
WEBRTC_TURN_URLS=
WEBRTC_TURN_USERNAME=
WEBRTC_TURN_CREDENTIAL=
```

后端启动时会执行 `GORM AutoMigrate` 并补默认域、频道等种子数据，不需要手动导入 SQL。生产环境请至少替换 `AUTH_SECRET`、`MYSQL_ROOT_PASSWORD`，并按需要配置 TURN。

停止服务：

```bash
docker compose down
```

清空本地 MySQL / Redis 数据卷：

```bash
docker compose down -v
```

## 本地开发

### 1. 启动依赖

如果只想用本机 Go 和 Vite 开发，可以只启动 MySQL / Redis：

```bash
docker compose up -d mysql redis
```

### 2. 启动后端

```bash
cp .env.example .env
# docker-compose.yml 默认把 MySQL 暴露到宿主 3307，.env.example 已按该端口配置 MYSQL_DSN。
go mod tidy
go run ./cmd/server
```

服务启动时会执行 `GORM AutoMigrate`，自动确保所需表结构存在。

### 3. 启动前端开发环境

```bash
cd frontend
npm install
npm run dev
```

前端开发环境默认采用“直连后端”模式（不经过 Vite 代理），本地开发请配置到本机后端：

```bash
cd frontend
cat > .env.development <<'EOF'
VITE_API_BASE_URL=http://localhost:8080
VITE_WS_BASE_URL=ws://localhost:8080
EOF
```

Windows PowerShell 示例：

```powershell
@"
VITE_API_BASE_URL=http://localhost:8080
VITE_WS_BASE_URL=ws://localhost:8080
"@ | Set-Content .env.development
```

如果你改过配置但浏览器仍命中旧地址，请先停止已有 `vite` 进程再重新执行 `npm run dev`。

推荐在本地提交流程中执行：

```bash
cd frontend
npm run lint
npm run format:check
npm run test:run
```

开发模式访问：

```text
http://localhost:5173
```

### 4. 让 Gin 直接服务前端

```bash
cd frontend
npm install
npm run build
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
- `APP_PORT`（仅 Docker Compose 使用，用于映射宿主访问端口）
- `MYSQL_DSN`
- `MYSQL_ROOT_PASSWORD`（仅 Docker Compose 使用）
- `MYSQL_DATABASE`（仅 Docker Compose 使用）
- `MYSQL_PORT`（仅 Docker Compose 使用）
- `REDIS_ADDR`
- `REDIS_PASSWORD`
- `REDIS_PORT`（仅 Docker Compose 使用）
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
WEBRTC_TURN_URLS=
WEBRTC_TURN_USERNAME=
WEBRTC_TURN_CREDENTIAL=
```

生产环境请通过密钥系统或部署环境变量注入 TURN 凭据，避免把凭据写入代码仓库。

## 主要接口

### 健康检查

- `GET /healthz`

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
- `screening.join`
- `screening.leave`
- `screening.url.replace`
- `screening.url.add`
- `screening.play`
- `screening.pause`
- `screening.seek`
- `screening.tick`
- `screening.rate`
- `screening.item.ended`

## 部署说明

当前仓库的服务拆分如下：

- 后端：`cmd/server`，Gin HTTP API + WebSocket + 前端静态文件兜底服务。
- 前端：`frontend`，React + Vite，构建产物为 `frontend/dist`。
- 数据库：MySQL 8.x，后端启动时会执行 GORM AutoMigrate 并补默认种子数据。
- 缓存 / 在线状态：Redis 7.x，用于在线成员、语音频道、放映室状态与 WebSocket presence。
- TURN / STUN：由后端环境变量生成 ICE servers，下发给前端。

### 部署产物与目录

仓库不跟踪构建产物。生产部署时建议目录为：

```text
/home/oopz/oopz-live/
├── .env
├── frontend/
│   └── dist/
└── release/
    └── oopz-live-linux-amd64
```

`.gitignore` 已排除 `release/`、`frontend/dist/`、根目录和 `cmd/server` 下的本地二进制，避免误提交部署产物。

### 方式 A：Nginx 静态前端 + systemd 后端

这是公网部署推荐方式。Nginx 负责 HTTPS、静态文件、`/api` 与 `/ws` 反向代理；Gin 只监听本机端口。

1. 准备服务器依赖：

```bash
sudo apt update
sudo apt install -y nginx mysql-server redis-server
```

2. 准备数据库：

```sql
CREATE DATABASE oopz CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'oopz'@'127.0.0.1' IDENTIFIED BY 'replace-with-password';
GRANT ALL PRIVILEGES ON oopz.* TO 'oopz'@'127.0.0.1';
FLUSH PRIVILEGES;
```

3. 准备服务器 `.env`：

```bash
sudo mkdir -p /home/oopz/oopz-live/release /home/oopz/oopz-live/frontend
sudo cp .env.example /home/oopz/oopz-live/.env
sudo editor /home/oopz/oopz-live/.env
```

生产环境示例：

```env
PORT=18080
MYSQL_DSN=oopz:replace-with-password@tcp(127.0.0.1:3306)/oopz?parseTime=true&multiStatements=true
REDIS_ADDR=127.0.0.1:6379
REDIS_PASSWORD=
AUTH_SECRET=replace-with-a-strong-random-secret

EMAIL_ENABLED=true
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_USER=your-email@example.com
EMAIL_PASSWORD=replace-with-email-password
EMAIL_FROM_NAME=Oopz Live

WEBRTC_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
WEBRTC_TURN_URLS=turn:turn.example.com:3478,turn:turn.example.com:3478?transport=tcp
WEBRTC_TURN_USERNAME=replace-with-turn-username
WEBRTC_TURN_CREDENTIAL=replace-with-turn-credential
```

4. 构建后端二进制：

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o release/oopz-live-linux-amd64 ./cmd/server
```

5. 构建前端：

```bash
cd frontend
npm ci
cat > .env.production <<'EOF'
VITE_API_BASE_URL=https://oopz.example.com
VITE_WS_BASE_URL=wss://oopz.example.com
EOF
npm run build
cd ..
```

如果前后端同域部署，`VITE_WS_BASE_URL` 可以省略，前端会从 `VITE_API_BASE_URL` 自动推导为 `wss://` 或 `ws://`。

6. 上传产物：

```bash
rsync -av release/oopz-live-linux-amd64 user@server:/home/oopz/oopz-live/release/
rsync -av --delete frontend/dist/ user@server:/home/oopz/oopz-live/frontend/dist/
```

7. 安装 systemd 服务：

```bash
sudo cp deploy/systemd/oopz-live.service /etc/systemd/system/oopz-live.service
sudo systemctl daemon-reload
sudo systemctl enable oopz-live
sudo systemctl restart oopz-live
sudo systemctl status oopz-live
```

`deploy/systemd/oopz-live.service` 默认从 `/home/oopz/oopz-live/.env` 读取配置，避免把密钥写进 service 文件。

8. 安装 Nginx 配置：

```bash
sudo cp deploy/nginx/oopz.xixiu.top.conf /etc/nginx/conf.d/oopz.example.com.conf
sudo editor /etc/nginx/conf.d/oopz.example.com.conf
sudo nginx -t
sudo systemctl reload nginx
```

需要替换模板里的 `server_name`、证书路径、`root /home/oopz/oopz-live/frontend/dist`，以及后端代理端口 `127.0.0.1:18080`。

9. 验证：

```bash
curl -fsS http://127.0.0.1:18080/healthz
curl -I https://oopz.example.com
sudo journalctl -u oopz-live -f
```

### 方式 B：Gin 直接服务前端 dist

适合内网、小规模部署或暂时不接 Nginx 的场景。后端会在检测到 `./frontend/dist` 时服务 `/assets` 和 `/`。

```bash
cp .env.example .env
cd frontend
npm ci
cat > .env.production <<'EOF'
VITE_API_BASE_URL=http://your-server:8080
EOF
npm run build
cd ..
go build -o release/oopz-live ./cmd/server
./release/oopz-live
```

这种方式仍然建议在公网前面放 HTTPS 代理。浏览器屏幕共享、麦克风和 WebRTC 在公网环境通常需要 HTTPS。

### 方式 C：前后端分开部署

适合把前端放到 CDN / 对象存储 / 静态站点服务，后端单独运行在 API 域名的场景。

1. 后端域名示例：`https://api.oopz.example.com`
2. 前端域名示例：`https://app.oopz.example.com`
3. 后端只需要暴露：

```text
GET /healthz
/api/*
GET /ws
```

4. 前端构建时写入后端地址：

```bash
cd frontend
npm ci
cat > .env.production <<'EOF'
VITE_API_BASE_URL=https://api.oopz.example.com
VITE_WS_BASE_URL=wss://api.oopz.example.com
EOF
npm run build
```

5. 将 `frontend/dist` 上传到静态站点，并配置 SPA fallback：

```text
/assets/*  -> 静态文件，建议长缓存
/*         -> /index.html
```

6. 后端部署：

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o release/oopz-live-linux-amd64 ./cmd/server
scp release/oopz-live-linux-amd64 user@server:/home/oopz/oopz-live/release/
scp .env user@server:/home/oopz/oopz-live/.env
sudo systemctl restart oopz-live
```

注意：当前后端没有专门的 CORS 中间件。前后端分开域名时，建议优先通过同一 Nginx 域名做路径转发；如果必须跨域，需要补充后端 CORS 配置后再开放生产访问。

### Docker Compose 说明

`docker-compose.yml` 默认启动完整应用栈：

```bash
docker compose up --build -d
docker compose ps
```

包含服务：

- `app`：Go 后端 + 已构建的 React 前端静态文件
- `mysql`：MySQL 8.4，持久化到 `mysql84_data` volume
- `redis`：Redis 7.4，持久化到 `redis_data` volume

如果只是本地开发依赖，不想启动业务容器，可以只启动：

```bash
docker compose up -d mysql redis
```

Compose 读取根目录 `.env`。下面是一个最小生产化示例：

```env
APP_PORT=8080
GIN_MODE=release
MYSQL_ROOT_PASSWORD=replace-with-strong-password
MYSQL_DATABASE=oopz
MYSQL_PORT=3307
REDIS_PORT=6379
REDIS_PASSWORD=replace-with-redis-password
AUTH_SECRET=replace-with-a-strong-random-secret
EMAIL_ENABLED=false
WEBRTC_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
WEBRTC_TURN_URLS=turn:turn.example.com:3478,turn:turn.example.com:3478?transport=tcp
WEBRTC_TURN_USERNAME=replace-with-turn-username
WEBRTC_TURN_CREDENTIAL=replace-with-turn-credential
```

如果使用 `docker compose up -d mysql redis` 只跑依赖，本机后端 `.env` 里的 DSN 应连接宿主映射端口：

```env
MYSQL_DSN=root:password@tcp(127.0.0.1:3307)/oopz?parseTime=true&multiStatements=true
REDIS_ADDR=127.0.0.1:6379
```

### GitHub Actions 自动部署

仓库包含 `.github/workflows/deploy.yml`，当前流程会：

1. 执行 `go test ./...`
2. 使用 `npm ci && npm run build` 构建前端
3. 构建 `release/oopz-live-linux-amd64`
4. 通过 SSH/SCP 上传二进制和 `frontend/dist`
5. 重启远端 `oopz-live` systemd 服务
6. 请求 `http://127.0.0.1:18080/healthz` 验证

需要配置的 GitHub Secrets：

- `SERVER_HOST`
- `SERVER_USER`
- `SERVER_PORT`
- `SERVER_SSH_KEY`
- `SERVER_SSH_PASSPHRASE`
- `SERVER_DEPLOY_PATH`

## TURN / STUN

当前 ICE 配置由后端根据环境变量生成，并通过 `bootstrap` 数据下发给前端：

- `WEBRTC_STUN_URLS`：逗号分隔的 STUN 地址列表。
- `WEBRTC_TURN_URLS`：逗号分隔的 TURN 地址列表。
- `WEBRTC_TURN_USERNAME` / `WEBRTC_TURN_CREDENTIAL`：TURN 凭据。

公开部署建议必须配置自己的 TURN 服务，尤其是手机流量、校园网、公司网、跨运营商网络等场景。TURN 凭据不要写死到前端源码或 README 示例里，生产环境应放在服务器环境变量、systemd `EnvironmentFile` 或密钥系统中。

## 当前实现说明

### 当前 WebRTC 恢复策略

当前实现主要增强了语音房在线状态、WebRTC 重连链路、TURN 诊断与屏幕共享体验。

已修复的问题：

- 用户异常退出浏览器或 WebSocket 断开后，可能仍残留在 Redis 的频道在线列表里，导致同一个账号看起来同时挂在多个频道。
- 用户退出语音频道后，前端仍可能继续响应残留的 RTC 信令，出现“已经退出频道，但别人还能听到声音”的异常。
- 首轮 WebRTC 协商在部分情况下会重复创建 peer、重复发送 offer，导致 `answer ignored`、`m-line` 顺序异常，以及后续 TURN fallback 判断失真。
- TURN / STUN 切换过程之前缺少足够日志，难以判断到底是没有拿到 relay candidate，还是虽然拿到了但没有被选中。

本次改进：

- 后端在用户加入频道前，会先清理该用户在其它语音频道和放映室中的残留成员记录，保证单用户同一时间只在一个频道在线。
- 后端在 WebSocket 连接完全断开且该用户没有其它活跃连接时，会把该用户从所有 Redis presence / screening viewers 中兜底清除，并同步移出在线状态。
- 前端语音会话增加了显式的 `voiceSessionActive` 保护；离开频道后不再处理新的 RTC 信令或重连流程，避免被远端残留消息重新拉起 PeerConnection。
- WebRTC 首次建连默认下发 STUN + TURN，并使用 `iceTransportPolicy: "all"`；普通网络波动优先尝试 ICE restart，TURN/relay 链路异常时直接通过 `rtc.reset` 局部重建双方 PeerConnection，避免旧 transceiver / sender 状态卡住。
- 重连、重新协商、收到 offer/answer 前会刷新本地 outbound track；重连 connected 后还会延迟执行 sender rehydrate，通过 `replaceTrack(null -> track)` 强制刷新浏览器 RTP 发送管线。
- 屏幕共享音频被纳入本地音频源判断，避免“关麦但共享系统/标签页音频”时重连后没有重新发送音频。
- 前端补充了 ICE 配置、candidate、selected pair、频道状态变更等调试日志，便于排查“为何自动离房”“为何没有切到 TURN”“为何退出后音频未停”等问题。
- 连接诊断面板现在会显示实际链路类型（局域网 / STUN / TURN）、RTT、重试次数，以及当前恢复方式（稳定 / ICE 重启 / TURN 中继）。
- 本地屏幕共享小窗会在 `screenSharing` 和 `screenStream` 变化后重新绑定 video stream，避免自己看到黑屏而放大预览正常。

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
- 前端已有基础响应式样式，但主要体验仍以桌面端语音房为主
- 屏幕共享与 RTC 恢复逻辑仍属于工程化增强版 MVP，不是 SFU 级实现
- 多实例部署时，WebSocket 广播层还需要补 Redis Pub/Sub 或消息总线

## 后续方向

- 引入好友 / 邀请体系
- 域角色与权限细化
- 频道排序 / 删除 / 转移管理
- 更稳定的 WebRTC 策略与统计面板
- SFU 架构升级
- 移动端与桌面壳封装

## 开源协议

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。

---

如果这个项目对你有帮助，欢迎继续扩展成更完整的实时社交 / 协作平台。

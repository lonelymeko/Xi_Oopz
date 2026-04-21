import { NoticeViewport } from "./NoticeViewport";
import { ScreenShareSheet } from "./ScreenShareSheet";
import { ScreenPreviewModal } from "./voiceAndMember";
import type { Notice, ScreenPreview, ScreenSharePreset } from "../../types/live";

/**
 * 页面弹层与通知组件。
 */
export function LiveOverlays(props: {
  session: unknown;
  creatingDomain: boolean;
  channelComposerType: "text" | "voice" | "screening" | null;
  maximizdScreen: ScreenPreview | null;
  showScreenShareSheet: boolean;
  screenSharePreset: ScreenSharePreset;
  notices: Notice[];
  authMode: "login" | "register";
  displayNameInput: string;
  emailInput: string;
  verificationCodeInput: string;
  passwordInput: string;
  submittingAuth: boolean;
  sendingVerificationCode: boolean;
  verificationCooldown: number;
  domainNameInput: string;
  domainDescriptionInput: string;
  submittingDomain: boolean;
  channelNameInput: string;
  channelTopicInput: string;
  submittingChannel: boolean;
  setAuthMode: (value: "login" | "register") => void;
  setDisplayNameInput: (value: string) => void;
  setEmailInput: (value: string) => void;
  setVerificationCodeInput: (value: string) => void;
  setPasswordInput: (value: string) => void;
  setCreatingDomain: (value: boolean) => void;
  setDomainNameInput: (value: string) => void;
  setDomainDescriptionInput: (value: string) => void;
  setChannelComposerType: (value: "text" | "voice" | "screening" | null) => void;
  setChannelNameInput: (value: string) => void;
  setChannelTopicInput: (value: string) => void;
  setMaximizedScreenKey: (value: string | null) => void;
  setShowScreenShareSheet: (value: boolean) => void;
  setScreenSharePreset: (value: ScreenSharePreset) => void;
  submitAuth: () => Promise<void>;
  requestVerificationCode: () => Promise<void>;
  submitCreateDomain: () => Promise<void>;
  submitCreateChannel: () => Promise<void>;
  confirmScreenShare: () => Promise<void>;
  dismissNotice: (id: number) => void;
}) {
  const {
    session,
    creatingDomain,
    channelComposerType,
    maximizdScreen,
    showScreenShareSheet,
    screenSharePreset,
    notices,
    authMode,
    displayNameInput,
    emailInput,
    verificationCodeInput,
    passwordInput,
    submittingAuth,
    sendingVerificationCode,
    verificationCooldown,
    domainNameInput,
    domainDescriptionInput,
    submittingDomain,
    channelNameInput,
    channelTopicInput,
    submittingChannel,
    setAuthMode,
    setDisplayNameInput,
    setEmailInput,
    setVerificationCodeInput,
    setPasswordInput,
    setCreatingDomain,
    setDomainNameInput,
    setDomainDescriptionInput,
    setChannelComposerType,
    setChannelNameInput,
    setChannelTopicInput,
    setMaximizedScreenKey,
    setShowScreenShareSheet,
    setScreenSharePreset,
    submitAuth,
    requestVerificationCode,
    submitCreateDomain,
    submitCreateChannel,
    confirmScreenShare,
    dismissNotice,
  } = props;

  return (
    <>
      {!session ? (
        <div className="identity-modal identity-modal--visible">
          <div className="identity-modal__card">
            <div className="eyebrow">ACCOUNT ACCESS</div>
            <h2>开源版 Oopz</h2>
            <p>by.玺朽</p>

            <div className="toggle-row">
              <button className="action-pill" onClick={() => setAuthMode("register")}>
                注册
              </button>
              <button className="action-pill" onClick={() => setAuthMode("login")}>
                登录
              </button>
            </div>

            {authMode === "register" ? (
              <input
                maxLength={32}
                placeholder="昵称"
                value={displayNameInput}
                onChange={(event) => setDisplayNameInput(event.target.value)}
              />
            ) : null}
            <input type="email" placeholder="邮箱" value={emailInput} onChange={(event) => setEmailInput(event.target.value)} />
            {authMode === "register" ? (
              <div className="identity-modal__code-row">
                <input
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 位邮箱验证码"
                  value={verificationCodeInput}
                  onChange={(event) => setVerificationCodeInput(event.target.value.replace(/\D+/g, "").slice(0, 6))}
                />
                <button
                  className="action-pill"
                  disabled={sendingVerificationCode || verificationCooldown > 0}
                  onClick={() => void requestVerificationCode()}
                >
                  {sendingVerificationCode ? "发送中..." : verificationCooldown > 0 ? `${verificationCooldown}s` : "发送验证码"}
                </button>
              </div>
            ) : null}
            <input
              type="password"
              placeholder="密码（至少 6 位）"
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
            />

            <button
              className="action-pill action-pill--primary action-pill--full"
              disabled={submittingAuth}
              onClick={() => void submitAuth()}
            >
              {submittingAuth ? "处理中..." : authMode === "register" ? "注册并进入" : "登录并进入"}
            </button>
          </div>
        </div>
      ) : null}

      {session && creatingDomain ? (
        <div className="identity-modal identity-modal--visible">
          <div className="identity-modal__card">
            <div className="eyebrow">NEW DOMAIN</div>
            <h2>创建一个新的域</h2>
            <p>创建后你会自动成为这个域的域主，并拥有创建频道的权限。</p>
            <input
              maxLength={48}
              placeholder="域名称"
              value={domainNameInput}
              onChange={(event) => setDomainNameInput(event.target.value)}
            />
            <input
              maxLength={120}
              placeholder="域描述"
              value={domainDescriptionInput}
              onChange={(event) => setDomainDescriptionInput(event.target.value)}
            />
            <div className="toggle-row">
              <button className="action-pill action-pill--primary" disabled={submittingDomain} onClick={() => void submitCreateDomain()}>
                {submittingDomain ? "创建中..." : "创建域"}
              </button>
              <button className="action-pill" onClick={() => setCreatingDomain(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {session && channelComposerType ? (
        <div className="identity-modal identity-modal--visible">
          <div className="identity-modal__card">
            <div className="eyebrow">{channelComposerType === "text" ? "TEXT CHANNEL" : "VOICE CHANNEL"}</div>
            <h2>创建{channelComposerType === "text" ? "文字" : "语音"}频道</h2>
            <p>只有域主可以创建频道，创建后会自动出现在左侧频道列表。</p>
            <input
              maxLength={48}
              placeholder="频道名称"
              value={channelNameInput}
              onChange={(event) => setChannelNameInput(event.target.value)}
            />
            <input
              maxLength={120}
              placeholder="频道描述 / Topic"
              value={channelTopicInput}
              onChange={(event) => setChannelTopicInput(event.target.value)}
            />
            <div className="toggle-row">
              <button className="action-pill action-pill--primary" disabled={submittingChannel} onClick={() => void submitCreateChannel()}>
                {submittingChannel ? "创建中..." : "创建频道"}
              </button>
              <button className="action-pill" onClick={() => setChannelComposerType(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {maximizdScreen ? <ScreenPreviewModal screen={maximizdScreen} onClose={() => setMaximizedScreenKey(null)} /> : null}
      {showScreenShareSheet ? (
        <ScreenShareSheet
          preset={screenSharePreset}
          onChange={setScreenSharePreset}
          onCancel={() => setShowScreenShareSheet(false)}
          onConfirm={() => void confirmScreenShare()}
        />
      ) : null}
      <NoticeViewport notices={notices} onDismiss={dismissNotice} />
    </>
  );
}

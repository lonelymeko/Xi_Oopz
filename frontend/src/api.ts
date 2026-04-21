import type { AuthResponse, BootstrapResponse, Channel, ChannelCategory, Domain, DomainPresenceResponse, Message, User } from "./types";
import { buildApiUrl } from "./config/runtime";

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

export async function createGuestUser(displayName: string): Promise<User> {
  const response = await fetch(buildApiUrl("/api/users/guest"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ displayName }),
  });
  if (!response.ok) {
    throw new Error("无法创建用户");
  }
  return response.json();
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

export async function registerAccount(input: {
  displayName: string;
  email: string;
  password: string;
  code: string;
}): Promise<AuthResponse> {
  const response = await fetch(buildApiUrl("/api/auth/register"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error((await response.json()).error || "注册失败");
  }
  return response.json();
}

export async function sendVerificationCode(input: { email: string }): Promise<{ message: string; cooldown: number; expiresIn: number; emailDebug: boolean }> {
  const response = await fetch(buildApiUrl("/api/auth/send-verification-code"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error((await response.json()).error || "验证码发送失败");
  }
  return response.json();
}

export async function loginAccount(input: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  const response = await fetch(buildApiUrl("/api/auth/login"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error((await response.json()).error || "登录失败");
  }
  return response.json();
}

export async function fetchMe(token: string): Promise<User> {
  const response = await fetch(buildApiUrl("/api/auth/me"), {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error("登录状态失效");
  }
  return response.json();
}

export async function fetchBootstrap(token: string, channelId?: number, domainId?: number): Promise<BootstrapResponse> {
  const params = new URLSearchParams();
  if (channelId) {
    params.set("channelId", String(channelId));
  }
  if (domainId) {
    params.set("domainId", String(domainId));
  }

  const query = params.toString();
  const response = await fetch(buildApiUrl(`/api/bootstrap${query ? `?${query}` : ""}`), {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error("加载引导数据失败");
  }
  return response.json();
}

export async function createDomain(
  token: string,
  input: { name: string; description: string; accentColor?: string },
): Promise<Domain> {
  const response = await fetch(buildApiUrl("/api/domains"), {
    method: "POST",
    headers: { ...JSON_HEADERS, ...authHeaders(token) },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error((await response.json()).error || "创建域失败");
  }
  return response.json();
}

export async function createCategory(
  domainId: number,
  token: string,
  input: { name: string; position?: number },
): Promise<ChannelCategory> {
  const response = await fetch(buildApiUrl(`/api/domains/${domainId}/categories`), {
    method: "POST",
    headers: { ...JSON_HEADERS, ...authHeaders(token) },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error((await response.json()).error || "创建分组失败");
  }
  return response.json();
}

export async function createChannel(
  domainId: number,
  token: string,
  input: { categoryId?: number; name: string; type: "text" | "voice" | "screening"; topic?: string; position?: number; maxMembers?: number },
): Promise<Channel> {
  const response = await fetch(buildApiUrl(`/api/domains/${domainId}/channels`), {
    method: "POST",
    headers: { ...JSON_HEADERS, ...authHeaders(token) },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error((await response.json()).error || "创建频道失败");
  }
  return response.json();
}

export async function fetchChannelMessages(domainId: number, channelId: number, token: string): Promise<Message[]> {
  const response = await fetch(buildApiUrl(`/api/domains/${domainId}/channels/${channelId}/messages`), {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error("加载频道消息失败");
  }
  return response.json();
}

export async function fetchDomainPresence(domainId: number, token: string): Promise<DomainPresenceResponse> {
  const response = await fetch(buildApiUrl(`/api/domains/${domainId}/presence`), {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error("加载在线状态失败");
  }
  return response.json();
}

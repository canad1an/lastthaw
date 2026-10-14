import type { z } from "zod";
import { alliancesResponse, chatResponse, marketResponse, matchStateView, matchSummary, userView, type ChatMessageView, type MarketOrderView, type TradeResource } from "@lastthaw/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A stable per-browser id used only for multi-account review (fair play).
 * It is random, not derived from anything personal, and lives in localStorage.
 */
function deviceId(): string {
  try {
    let id = localStorage.getItem("lt_device");
    if (!id) {
      id = crypto.randomUUID().replace(/-/g, "");
      localStorage.setItem("lt_device", id);
    }
    return id;
  } catch {
    return "unknown";
  }
}

async function request<T>(method: string, url: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
  const init: RequestInit = { method, credentials: "include", headers: { "x-device": deviceId() } };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json", "x-device": deviceId() };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? `request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return schema ? schema.parse(json) : (json as T);
}

export const api = {
  me: () => request("GET", "/api/auth/me", undefined, userView),
  register: (b: { email: string; password: string; displayName: string }) => request("POST", "/api/auth/register", b, userView),
  login: (b: { email: string; password: string }) => request("POST", "/api/auth/login", b, userView),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
  verify: (token: string) => request<{ ok: true }>("POST", "/api/auth/verify", { token }),
  resendVerification: () => request<{ ok: true }>("POST", "/api/auth/resend-verification", {}),
  forgot: (email: string) => request<{ ok: true }>("POST", "/api/auth/forgot", { email }),
  reset: (token: string, password: string) => request<{ ok: true }>("POST", "/api/auth/reset", { token, password }),

  matches: () => request("GET", "/api/matches", undefined, matchSummary.array()),
  createMatch: (b: { name: string; speed: number; startsInMinutes: number; aiFillTo?: number; neutralTribes?: number; aiDifficulty?: "mixed" | "easy" | "medium" | "hard" }) => request<{ id: string }>("POST", "/api/matches", b),
  joinMatch: (id: string) => request<{ playerId: string }>("POST", `/api/matches/${id}/join`, {}),
  startOptions: (id: string) => request<{ options: string[]; current: string | null }>("GET", `/api/matches/${id}/start-options`),
  pickStart: (id: string, regionId: string) => request<{ ok: true }>("POST", `/api/matches/${id}/pick-start`, { regionId }),
  matchState: (id: string) => request("GET", `/api/matches/${id}/state`, undefined, matchStateView),
  assign: (id: string, regionId: string, shares: { food: number; wood: number; stone: number }) =>
    request<{ ok: true }>("POST", `/api/matches/${id}/regions/${regionId}/assign`, shares),
  build: (id: string, regionId: string, buildingId: string) => request<{ ok: true; jobId: string; endsAt: string }>("POST", `/api/matches/${id}/regions/${regionId}/build`, { buildingId }),
  train: (id: string, regionId: string, unitId: string, qty: number) =>
    request<{ ok: true; jobId: string; endsAt: string }>("POST", `/api/matches/${id}/regions/${regionId}/train`, { unitId, qty }),
  research: (id: string, techId: string) => request<{ ok: true; jobId: string; endsAt: string }>("POST", `/api/matches/${id}/research`, { techId }),
  sendArmy: (id: string, regionId: string, body: { mission: string; targetRegionId: string; units: Record<string, number>; people: number; cargo: Record<string, number> }) =>
    request<{ ok: true; armyId: string; arrivesAt: string; path: string[] }>("POST", `/api/matches/${id}/regions/${regionId}/send`, body),
  recallArmy: (id: string, armyId: string) => request<{ ok: true; returnsAt: string }>("POST", `/api/matches/${id}/armies/${armyId}/recall`, {}),
  cancelJob: (id: string, jobId: string) => request<{ ok: true }>("POST", `/api/matches/${id}/jobs/${jobId}/cancel`, {}),
  messages: (id: string) => request<MessagesResponse>("GET", `/api/matches/${id}/messages`),
  markMessagesRead: (id: string) => request<{ ok: true }>("POST", `/api/matches/${id}/messages/read`, {}),
  devStart: (id: string) => request<{ ok: true; started: boolean }>("POST", `/api/matches/${id}/dev/start`, {}),
  devTimeSkip: (id: string, seconds: number) => request<{ ok: true; clockOffsetSeconds: number }>("POST", `/api/matches/${id}/dev/time-skip`, { seconds }),

  // Milestone 5: alliances, chat, market
  alliances: (id: string) => request("GET", `/api/matches/${id}/alliances`, undefined, alliancesResponse),
  createAlliance: (id: string, b: { name: string; tag: string }) => request<{ id: string; name: string; tag: string }>("POST", `/api/matches/${id}/alliances`, b),
  inviteToAlliance: (id: string, playerId: string) => request<{ ok: true }>("POST", `/api/matches/${id}/alliances/invite`, { playerId }),
  acceptAllianceInvite: (id: string, allianceId: string) => request<{ ok: true }>("POST", `/api/matches/${id}/alliances/accept`, { allianceId }),
  declineAllianceInvite: (id: string, allianceId: string) => request<{ ok: true }>("POST", `/api/matches/${id}/alliances/decline`, { allianceId }),
  leaveAlliance: (id: string) => request<{ ok: true; dissolved: boolean }>("POST", `/api/matches/${id}/alliances/leave`, {}),
  kickFromAlliance: (id: string, playerId: string) => request<{ ok: true }>("POST", `/api/matches/${id}/alliances/kick`, { playerId }),
  chat: (id: string, channel: "global" | "alliance") => request("GET", `/api/matches/${id}/chat?channel=${channel}`, undefined, chatResponse),
  postChat: (id: string, channel: "global" | "alliance", body: string) => request<ChatMessageView>("POST", `/api/matches/${id}/chat`, { channel, body }),
  market: (id: string) => request("GET", `/api/matches/${id}/market`, undefined, marketResponse),
  postOrder: (id: string, b: { regionId: string; offerResource: TradeResource; offerAmount: number; askResource: TradeResource; askAmount: number }) =>
    request<MarketOrderView>("POST", `/api/matches/${id}/market`, b),
  cancelOrder: (id: string, orderId: string) => request<{ ok: true; refundedTo: string | null }>("POST", `/api/matches/${id}/market/${orderId}/cancel`, {}),
  acceptOrder: (id: string, orderId: string, regionId: string) => request<{ ok: true; received: number }>("POST", `/api/matches/${id}/market/${orderId}/accept`, { regionId }),
};

export interface MessageView {
  id: string;
  kind: string;
  subject: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
export interface MessagesResponse {
  unread: number;
  messages: MessageView[];
}

export const keys = {
  me: ["me"] as const,
  matches: ["matches"] as const,
  matchState: (id: string) => ["match", id, "state"] as const,
  startOptions: (id: string) => ["match", id, "start-options"] as const,
  messages: (id: string) => ["match", id, "messages"] as const,
  alliances: (id: string) => ["match", id, "alliances"] as const,
  chat: (id: string, channel: string) => ["match", id, "chat", channel] as const,
  chatAll: (id: string) => ["match", id, "chat"] as const,
  market: (id: string) => ["match", id, "market"] as const,
};

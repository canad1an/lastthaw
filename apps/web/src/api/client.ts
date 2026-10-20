import type { z } from "zod";
import { reportClientError } from "../errorReport.js";
import { alliancesResponse, chatResponse, marketResponse, matchStateView, matchSummary, userView, type AdvisorSettings, type ChatMessageView, type MarketOrderView, type TradeResource } from "@lastthaw/shared";

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
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch (err) {
    reportClientError("schema", err, { request: `${method} ${url}`, status: res.status });
    throw new ApiError(res.status, "the server's answer could not be read");
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? `request failed (${res.status})`;
    // A 5xx or a body the server refused as invalid is a bug on one side or the other; a 4xx from the player doing the wrong thing is not.
    if (res.status >= 500 || (res.status === 400 && msg === "invalid request")) reportClientError("api", new Error(msg), { request: `${method} ${url}`, status: res.status });
    throw new ApiError(res.status, msg);
  }
  if (!schema) return json as T;
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    reportClientError("schema", new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 600)), { request: `${method} ${url}`, status: res.status });
    throw parsed.error;
  }
  return parsed.data;
}

export const api = {
  me: () => request("GET", "/api/auth/me", undefined, userView),
  register: (b: { email: string; password: string; displayName: string }) => request("POST", "/api/auth/register", b, userView),
  login: (b: { email: string; password: string }) => request("POST", "/api/auth/login", b, userView),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
  verify: (b: { token?: string; code?: string }) => request<{ ok: true }>("POST", "/api/auth/verify", b),
  resendVerification: () => request<{ ok: true }>("POST", "/api/auth/resend-verification", {}),
  forgot: (email: string) => request<{ ok: true }>("POST", "/api/auth/forgot", { email }),
  reset: (token: string, password: string) => request<{ ok: true }>("POST", "/api/auth/reset", { token, password }),
  updateProfile: (b: { tagline?: string | null; bio?: string | null; location?: string | null; displayName?: string }) => request("PATCH", "/api/me/profile", b, userView),
  changePassword: (b: { currentPassword: string; newPassword: string }) => request<{ ok: true }>("POST", "/api/me/password", b),

  matches: () => request("GET", "/api/matches", undefined, matchSummary.array()),
  createMatch: (b: { name: string; speed: number; startsInMinutes: number; startsAt?: string; kind?: "tournament" | "public" | "private"; aiFillTo?: number; neutralTribes?: number; aiDifficulty?: "mixed" | "easy" | "medium" | "hard"; resourceMult?: number }) => request<{ id: string; inviteCode: string | null }>("POST", "/api/matches", b),
  joinByCode: (code: string) => request<{ id: string; name: string }>("POST", "/api/matches/join-code", { code }),
  startNow: (id: string) => request<{ ok: true }>("POST", `/api/matches/${id}/start-now`, {}),
  cancelGame: (id: string) => request<{ ok: true }>("DELETE", `/api/matches/${id}`),
  registerTournament: (id: string) => request<{ ok: true; registered: boolean }>("POST", `/api/matches/${id}/register`, {}),
  unregisterTournament: (id: string) => request<{ ok: true; registered: boolean }>("DELETE", `/api/matches/${id}/register`),
  joinMatch: (id: string, inviteCode?: string) => request<{ playerId: string }>("POST", `/api/matches/${id}/join`, inviteCode ? { inviteCode } : {}),
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
  createRoute: (id: string, regionId: string, body: { toRegionId: string; mode: "fixed" | "share"; load: Record<string, number>; share: number; caravans: number; everyHours: number; target?: Record<string, number> }) =>
    request<{ id: string }>("POST", `/api/matches/${id}/regions/${regionId}/routes`, body),
  updateRoute: (id: string, routeId: string, body: { toRegionId: string; mode: "fixed" | "share"; load: Record<string, number>; share: number; caravans: number; everyHours: number }) =>
    request<{ ok: true }>("PATCH", `/api/matches/${id}/routes/${routeId}`, body),
  toggleRoute: (id: string, routeId: string) => request<{ ok: true; enabled: boolean }>("POST", `/api/matches/${id}/routes/${routeId}/toggle`, {}),
  deleteRoute: (id: string, routeId: string) => request<{ ok: true }>("DELETE", `/api/matches/${id}/routes/${routeId}`),
  runRoute: (id: string, routeId: string) => request<{ ok: true; result: string }>("POST", `/api/matches/${id}/routes/${routeId}/run`, {}),
  evacuate: (id: string, regionId: string, toRegionId: string) =>
    request<{ ok: true; armyId: string; arrivesAt: string; people: number; units: Record<string, number>; cargo: Record<string, number>; leftBehind: number }>("POST", `/api/matches/${id}/regions/${regionId}/evacuate`, { toRegionId }),
  colonize: (id: string, regionId: string, body: { targetRegionId: string; settlers: number; stock?: Record<string, number>; caravans?: number }) =>
    request<{ ok: true; armyId: string; arrivesAt: string; routeId: string | null }>("POST", `/api/matches/${id}/regions/${regionId}/colonize`, body),
  setCapital: (id: string, regionId: string) =>
    request<{ ok: true; armyId: string; arrivesAt: string; cargo: Record<string, number>; path: string[] }>("POST", `/api/matches/${id}/capital`, { regionId }),
  proposePact: (id: string, b: { otherPlayerId: string; kind: "nap" | "ceasefire" | "tribute"; resource?: string; amount?: number }) => request<{ ok: true; id: string }>("POST", `/api/matches/${id}/pacts`, b),
  respondPact: (id: string, pactId: string, accept: boolean) => request<{ ok: true }>("POST", `/api/matches/${id}/pacts/${pactId}/respond`, { accept }),
  endPact: (id: string, pactId: string) => request<{ ok: true }>("POST", `/api/matches/${id}/pacts/${pactId}/end`, {}),
  payTribute: (id: string, pactId: string) => request<{ ok: true }>("POST", `/api/matches/${id}/pacts/${pactId}/pay`, {}),
  hireMercenaries: (id: string, offerId: string) => request<{ ok: true; qty: number; company: string }>("POST", `/api/matches/${id}/mercenaries/${offerId}/hire`, {}),
  hireAdvisor: (id: string, kind: "economic") => request<{ ok: true; wage: Record<string, number> }>("POST", `/api/matches/${id}/advisors/${kind}/hire`, {}),
  dismissAdvisor: (id: string, kind: "economic") => request<{ ok: true }>("POST", `/api/matches/${id}/advisors/${kind}/dismiss`, {}),
  setAdvisorSettings: (id: string, kind: "economic", settings: AdvisorSettings) => request<{ ok: true }>("PUT", `/api/matches/${id}/advisors/${kind}/settings`, settings),
  runAdvisor: (id: string, kind: "economic") => request<{ ok: true }>("POST", `/api/matches/${id}/advisors/${kind}/run`, {}),
  setNote: (id: string, regionId: string, b: { text: string; colour: string | null }) => request<{ ok: true }>("PUT", `/api/matches/${id}/notes/${regionId}`, b),
  endMatch: (id: string) => request<{ ok: true }>("POST", `/api/matches/${id}/end`, {}),
  lastStand: (id: string, targetRegionId: string) => request<{ ok: true; arrivesAt: string }>("POST", `/api/matches/${id}/last-stand`, { targetRegionId }),
  decideRefugees: (id: string, offerId: string, accept: boolean) => request<{ ok: true; accepted: boolean }>("POST", `/api/matches/${id}/refugees/${offerId}`, { accept }),
  nameSuggestion: () => request<{ name: string }>("GET", "/api/matches/name-suggestion"),
  rally: (id: string, includeMissions: boolean) =>
    request<{ ok: true; groups: number; soldiers: number; recalled: number; skipped: string[] }>("POST", `/api/matches/${id}/rally`, { includeMissions }),
  convert: (id: string, regionId: string, body: { from: string; to: string; qty: number }) =>
    request<{ ok: true; converted: number; cost: Record<string, number> }>("POST", `/api/matches/${id}/regions/${regionId}/convert`, body),
  disband: (id: string, regionId: string, units: Record<string, number>) =>
    request<{ ok: true; disbanded: number }>("POST", `/api/matches/${id}/regions/${regionId}/disband`, { units }),
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

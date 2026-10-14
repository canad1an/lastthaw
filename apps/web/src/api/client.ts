import type { z } from "zod";
import { matchStateView, matchSummary, userView } from "@lastthaw/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
  const init: RequestInit = { method, credentials: "include" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
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
  createMatch: (b: { name: string; speed: number; startsInMinutes: number }) => request<{ id: string }>("POST", "/api/matches", b),
  joinMatch: (id: string) => request<{ playerId: string }>("POST", `/api/matches/${id}/join`, {}),
  startOptions: (id: string) => request<{ options: string[]; current: string | null }>("GET", `/api/matches/${id}/start-options`),
  pickStart: (id: string, regionId: string) => request<{ ok: true }>("POST", `/api/matches/${id}/pick-start`, { regionId }),
  matchState: (id: string) => request("GET", `/api/matches/${id}/state`, undefined, matchStateView),
  assign: (id: string, regionId: string, shares: { food: number; wood: number; stone: number }) =>
    request<{ ok: true }>("POST", `/api/matches/${id}/regions/${regionId}/assign`, shares),
  devStart: (id: string) => request<{ ok: true; started: boolean }>("POST", `/api/matches/${id}/dev/start`, {}),
  devTimeSkip: (id: string, seconds: number) => request<{ ok: true; clockOffsetSeconds: number }>("POST", `/api/matches/${id}/dev/time-skip`, { seconds }),
};

export const keys = {
  me: ["me"] as const,
  matches: ["matches"] as const,
  matchState: (id: string) => ["match", id, "state"] as const,
  startOptions: (id: string) => ["match", id, "start-options"] as const,
};

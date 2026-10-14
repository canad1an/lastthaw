import type { Redis } from "ioredis";
import type { EventKind } from "@lastthaw/shared";

/** Channel naming shared by publishers (api, worker) and the websocket hub. */
export const channels = {
  match: (matchId: string) => `match:${matchId}`,
  player: (playerId: string) => `player:${playerId}`,
};

export interface PublishedEvent {
  matchId: string;
  kind: EventKind;
  at: string;
  payload: unknown;
}

export class Publisher {
  constructor(private readonly redis: Redis) {}

  async toMatch(matchId: string, kind: EventKind, payload: unknown = {}): Promise<void> {
    await this.send(channels.match(matchId), { matchId, kind, at: new Date().toISOString(), payload });
  }

  async toPlayer(matchId: string, playerId: string, kind: EventKind, payload: unknown = {}): Promise<void> {
    await this.send(channels.player(playerId), { matchId, kind, at: new Date().toISOString(), payload });
  }

  private async send(channel: string, ev: PublishedEvent) {
    try {
      await this.redis.publish(channel, JSON.stringify(ev));
    } catch {
      // Realtime is best effort; clients also poll.
    }
  }
}

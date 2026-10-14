import { z } from "zod";

/** Every API response carries the server time so clients can compute countdowns from an offset. */
export const healthResponse = z.object({
  ok: z.literal(true),
  serverTime: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponse>;

import { Redis } from "ioredis";
import { config } from "./config.js";

export function createRedis() {
  return new Redis(config().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
}

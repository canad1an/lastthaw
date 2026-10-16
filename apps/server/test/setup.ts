import { beforeAll } from "vitest";

process.env.DATABASE_URL ??= "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.SMTP_PORT ??= "1";

/** Rate-limit and lockout counters live in Redis and would otherwise carry over from one test run to the next. */
beforeAll(async () => {
  const { createRedis } = await import("../src/redis.js");
  const redis = createRedis();
  try {
    const keys = [...(await redis.keys("lt-rl:*")), ...(await redis.keys("lt-login-fail:*")), ...(await redis.keys("lt-mail:*"))];
    if (keys.length) await redis.del(...keys);
  } finally {
    await redis.quit().catch(() => {});
  }
});

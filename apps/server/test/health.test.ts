import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { healthResponse } from "@lastthaw/shared";
import { buildApp } from "../src/api/app.js";

process.env.DATABASE_URL ??= "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";

describe("GET /api/health", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("returns ok with a server time", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = healthResponse.parse(res.json());
    expect(Date.parse(body.serverTime)).not.toBeNaN();
  });
});

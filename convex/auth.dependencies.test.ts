/// <reference types="vite/client" />
import { generateKeyPairSync } from "node:crypto";
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

afterEach(() => vi.unstubAllEnvs());

function tokenUserId(token: string) {
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString(),
  ) as { sub: string };
  return claims.sub.split("|")[0];
}

it("keeps password sign-up, sign-in and refresh working after auth upgrades", async () => {
  // Disposable signing key and in-memory database. No deployment is contacted.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv(
    "JWT_PRIVATE_KEY",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  vi.stubEnv("CONVEX_SITE_URL", "https://auth-test.invalid");
  vi.stubEnv("ADMIN_EMAILS", "");
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  rateLimiterTest.register(t);
  const credentials = {
    email: "dependency-test@example.com",
    password: "test-password-60",
  };

  const signup = await t.action(api.auth.signIn, {
    provider: "password",
    params: { ...credentials, flow: "signUp" },
  });
  expect(signup.tokens).toBeTruthy();
  const userId = tokenUserId(signup.tokens!.token);
  const user = await t.run((ctx) =>
    ctx.db.query("users")
      .withIndex("email", (q) => q.eq("email", credentials.email))
      .unique(),
  );
  expect(user).toMatchObject({
    _id: userId,
    email: credentials.email,
    role: "user",
    tier: "free",
  });

  const signin = await t.action(api.auth.signIn, {
    provider: "password",
    params: { ...credentials, flow: "signIn" },
  });
  expect(tokenUserId(signin.tokens!.token)).toBe(userId);

  const refreshed = await t.action(api.auth.signIn, {
    refreshToken: signin.tokens!.refreshToken,
  });
  expect(tokenUserId(refreshed.tokens!.token)).toBe(userId);

  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: { ...credentials, password: "wrong-password", flow: "signIn" },
    }),
  ).rejects.toThrow();
});

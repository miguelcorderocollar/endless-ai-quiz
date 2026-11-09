/// <reference types="vite/client" />
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { authCallbacks } from "./auth";
import { rateLimiter } from "./rateLimits";
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
afterEach(() => vi.useRealTimers());

async function setup() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { email: "delete@example.com" });
    const otherId = await ctx.db.insert("users", { email: "keep@example.com" });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3600000 });
    return { userId, otherId, sessionId };
  });
  const authed = t.withIdentity({ subject: `${ids.userId}|${ids.sessionId}` });
  return { t, authed, ...ids };
}

it("requires a recent, unexpired session owned by the caller", async () => {
  vi.useFakeTimers();
  const { t, authed, userId, otherId, sessionId } = await setup();
  await expect(t.mutation(api.users.deleteAccount, {})).rejects.toThrow("Sign in required");
  await expect(t.withIdentity({ subject: userId }).mutation(api.users.deleteAccount, {})).rejects.toThrow("Sign out and sign in again");
  await expect(t.withIdentity({ subject: `${otherId}|${sessionId}` }).mutation(api.users.deleteAccount, {})).rejects.toThrow("Sign out and sign in again");
  await t.run(async ctx => { await ctx.db.patch(sessionId, { expirationTime: Date.now() - 1 }); });
  await expect(authed.mutation(api.users.deleteAccount, {})).rejects.toThrow("Sign out and sign in again");
  await t.run(async ctx => { await ctx.db.patch(sessionId, { expirationTime: Date.now() + 3600000 }); });
  vi.advanceTimersByTime(5 * 60 * 1000 + 1);
  await expect(authed.mutation(api.users.deleteAccount, {})).rejects.toThrow("Sign out and sign in again");
  await t.run(async ctx => { await ctx.db.patch(sessionId, { expirationTime: Date.now() - 1 }); });
  await expect(authed.mutation(api.users.deleteAccount, {})).rejects.toThrow("Sign out and sign in again");
  expect(await t.run(ctx => ctx.db.get(userId))).not.toHaveProperty("deletionStartedAt");
});

it("deletes large histories and auth children in bounded continuations, isolating other users", async () => {
  vi.useFakeTimers();
  const { t, authed, userId, otherId, sessionId } = await setup();
  const accountId = await t.run(async ctx => {
    const questionId = await ctx.db.insert("questions", {
      questionId: "con-9001", text: "Test", options: ["a", "b", "c", "d"], answer: "a",
      category: "concepts", difficulty: 1, explanation: "Test", source: { kind: "none" },
      tags: [], addedAt: "2026-11-09", status: "published", updatedAt: Date.now(),
    });
    for (const owner of [userId, otherId]) {
      for (let i = 0; i < (owner === userId ? 251 : 1); i++) {
        await ctx.db.insert("answerEvents", { userId: owner, questionId, category: "concepts", difficulty: 1,
          correct: true, ratingBefore: 1000, ratingAfter: 1001, createdAt: i });
      }
      await ctx.db.insert("userStats", { userId: owner, rating: 1001, answered: 1, correct: 1,
        streak: 1, bestStreak: 1, byCategory: [], updatedAt: Date.now() });
    }
    const accountId = await ctx.db.insert("authAccounts", { userId, provider: "password", providerAccountId: "delete@example.com", secret: "hash" });
    await ctx.db.insert("authVerificationCodes", { accountId, provider: "password", code: "code", expirationTime: Date.now() + 1000 });
    await ctx.db.insert("authRateLimits", { identifier: accountId, lastAttemptTime: Date.now(), attemptsLeft: 2 });
    for (let i = 0; i < 203; i++) {
      await ctx.db.insert("authRefreshTokens", { sessionId, expirationTime: Date.now() + 1000 });
    }
    await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 1000 });
    await ctx.db.insert("authAccounts", { userId: otherId, provider: "password", providerAccountId: "keep@example.com" });
    await ctx.db.insert("authSessions", { userId: otherId, expirationTime: Date.now() + 1000 });
    return accountId;
  });
  await authed.mutation(api.users.deleteAccount, {});
  expect(await t.run(ctx => ctx.db.get(userId))).toHaveProperty("deletionStartedAt");
  await expect(authed.mutation(api.users.deleteAccount, {})).resolves.toBeNull();
  await expect(authed.mutation(api.users.setDisplayName, { displayName: "resurrect" })).rejects.toThrow("being deleted");
  await expect(authed.mutation(api.answers.ensureStats, {})).rejects.toThrow("being deleted");
  await expect(authed.mutation(api.answers.answer, { questionId: "con-9001", picked: "a" })).rejects.toThrow("being deleted");
  // Drive exactly one batch: the history must still have 151 rows.
  await t.mutation(internal.users.continueDeletion, { userId });
  expect(await t.run(async ctx => (await ctx.db.query("answerEvents").withIndex("by_user", q => q.eq("userId", userId)).collect()).length)).toBe(151);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.run(async ctx => {
    expect(await ctx.db.get(userId)).toBeNull();
    expect(await ctx.db.get(accountId)).toBeNull();
    expect(await ctx.db.get(sessionId)).toBeNull();
    expect(await ctx.db.query("authRefreshTokens").collect()).toEqual([]);
    expect(await ctx.db.query("authVerificationCodes").collect()).toEqual([]);
    expect(await ctx.db.query("authRateLimits").collect()).toEqual([]);
    for (const table of ["answerEvents", "userStats", "authAccounts", "authSessions"] as const) {
      const rows = await ctx.db.query(table).collect();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(otherId);
    }
    expect(await ctx.db.get(otherId)).not.toBeNull();
    expect(await ctx.db.query("questions").collect()).toHaveLength(1);
  });
  // Already-issued JWTs still resolve an id, but cannot recreate data.
  await expect(authed.mutation(api.users.claimProgress, { rating: 1000, answered: 1, correct: 1 })).rejects.toThrow("unavailable");
  await t.mutation(internal.users.continueDeletion, { userId });
  await expect(authed.mutation(api.users.deleteAccount, {})).resolves.toBeNull();
});

it("seed cleanup schedules subsequent user pages and uses the shared cascade", async () => {
  vi.useFakeTimers();
  const { t, otherId } = await setup();
  await t.run(async ctx => {
    for (let i = 0; i < 105; i++) await ctx.db.insert("users", { email: `${i}@seed.endless-ai.test` });
  });
  await t.mutation(internal.seed.cleanupSeed, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const users = await t.run(ctx => ctx.db.query("users").collect());
  expect(users).toHaveLength(2);
  expect(users.some(u => u._id === otherId)).toBe(true);
});


it("refuses session creation for a user marked for deletion", async () => {
  const { t, userId } = await setup();
  const createSession = () => t.run(async ctx => {
    await authCallbacks.beforeSessionCreation!(ctx, { userId });
    return ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 1000 });
  });
  await expect(createSession()).resolves.toBeTruthy();
  await t.run(ctx => ctx.db.patch(userId, { deletionStartedAt: Date.now() }));
  await expect(createSession()).rejects.toThrow("Account unavailable or being deleted.");
  expect(await t.run(ctx => ctx.db.query("authSessions").collect())).toHaveLength(2);
});

it.each(["account", "seed"])("resumes a marked user with no running continuation through %s deletion", async source => {
  vi.useFakeTimers();
  const { t, authed, userId } = await setup();
  // Simulate the state left when a batch fails: the marker committed earlier,
  // and there is no queued continuation. A stale session can resume this work.
  await t.run(ctx => ctx.db.patch(userId, {
    deletionStartedAt: Date.now(), email: "stalled@seed.endless-ai.test",
  }));
  vi.advanceTimersByTime(6 * 60 * 1000);
  if (source === "account") await authed.mutation(api.users.deleteAccount, {});
  else await t.mutation(internal.seed.cleanupSeed, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run(ctx => ctx.db.get(userId))).toBeNull();
});

it("removes component rate limits for the deleted user while retaining other quotas", async () => {
  vi.useFakeTimers();
  const { t, authed, userId, otherId } = await setup();
  await t.run(async ctx => {
    for (const key of [userId, otherId]) {
      await rateLimiter.limit(ctx, "answer", { key });
      await rateLimiter.limit(ctx, "displayName", { key });
    }
    await rateLimiter.limit(ctx, "signUpGlobal");
  });
  await authed.mutation(api.users.deleteAccount, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.run(async ctx => {
    for (const name of ["answer", "displayName"] as const) {
      expect((await rateLimiter.getValue(ctx, name, { key: userId })).ts).toBe(0);
      expect((await rateLimiter.getValue(ctx, name, { key: otherId })).ts).toBeGreaterThan(0);
    }
    expect((await rateLimiter.getValue(ctx, "signUpGlobal")).ts).toBeGreaterThan(0);
  });
});

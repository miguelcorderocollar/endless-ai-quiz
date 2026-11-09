import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { Password } from "@convex-dev/auth/providers/Password";

import { api } from "./_generated/api";
import schema from "./schema";
import { authCallbacks } from "./auth";
import { OUTBOX_CAP } from "../src/lib/answers/outboxCore";
import { normalizeDisplayName } from "./users";
import { resetUserRateLimits } from "./rateLimits";
import { STARTING_ELO } from "../src/lib/quiz/elo";
import { runDrain } from "../src/lib/answers/outboxCore";

const modules = import.meta.glob("./**/*.*s");
afterEach(() => vi.useRealTimers());

async function setup(isAnonymous = false) {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const userId = await t.run((ctx) => ctx.db.insert("users", { isAnonymous }));
  const questionId = await t.run((ctx) => ctx.db.insert("questions", {
    questionId: "con-test", text: "Test?", options: ["yes", "no"], answer: "yes",
    category: "concepts", difficulty: 1, explanation: "Test fixture",
    source: { kind: "none" }, tags: [], addedAt: "2026-01-01",
    status: "published", updatedAt: Date.now(),
  }));
  const user = t.withIdentity({ subject: userId });
  const answer = (eventId: string) => user.mutation(api.answers.answer, {
    questionId: "con-test", picked: "yes", eventId,
  });
  return { t, userId, user, answer, questionId };
}

describe("claimProgress", () => {
  it.each([3000, 1e100, NaN, Infinity, -100])("ignores untrusted rating %s and totals", async (rating) => {
    const { user } = await setup();
    expect(await user.mutation(api.users.claimProgress, {
      rating, answered: 1e100, correct: 1e100,
    })).toEqual({ seeded: true });
    expect(await user.query(api.answers.myStats)).toMatchObject({
      rating: STARTING_ELO, answered: 1000, correct: 1000,
      byCategory: [{ category: "imported", answered: 1000, correct: 1000 }],
      streak: 0, bestStreak: 0, serverAnswered: 0, seeded: true,
    });
    expect(await user.mutation(api.users.claimProgress, {
      rating: 3000, answered: 500, correct: 500,
    })).toEqual({ seeded: false });
  });

  it.each([0, -1, NaN, Infinity])("does not create stats for invalid/empty count %s", async (answered) => {
    const { user } = await setup();
    await user.mutation(api.users.claimProgress, { rating: 3000, answered, correct: 1 });
    expect(await user.query(api.answers.myStats)).toBeNull();
  });

  it("preserves existing server stats and rebuilds missing ones from events", async () => {
    const { t, user, userId, answer } = await setup();
    await answer("first");
    const before = await user.query(api.answers.myStats);
    const claim = { rating: 3000, answered: 999999, correct: 999999 };
    await user.mutation(api.users.claimProgress, claim);
    expect(await user.query(api.answers.myStats)).toEqual(before);
    await t.run(async (ctx) => {
      const stats = await ctx.db.query("userStats").withIndex("by_user", q => q.eq("userId", userId)).unique();
      await ctx.db.delete(stats!._id);
    });
    expect(await user.mutation(api.users.claimProgress, claim)).toEqual({ seeded: false });
    expect(await user.query(api.answers.myStats)).toMatchObject({
      rating: before!.rating, answered: 1, correct: 1, serverAnswered: 1,
      byCategory: [{ category: "concepts", answered: 1, correct: 1 }],
    });
  });
});

it("rejects new anonymous sign-ins and writes from legacy anonymous sessions", async () => {
  const { t, user, answer } = await setup(true);
  await expect(t.action(api.auth.signIn, { provider: "anonymous" })).rejects.toThrow();
  await expect(answer("anonymous")).rejects.toThrow("Sign in required.");
  await expect(user.mutation(api.users.claimProgress, { rating: 3000, answered: 100, correct: 100 })).rejects.toThrow("Sign in required.");
  await expect(user.mutation(api.users.setDisplayName, { displayName: "Guest" })).rejects.toThrow("Sign in required.");
  expect(await t.query(api.stats.population)).toMatchObject({ count: 0 });
});

it("limits new answers per user, allows retries at capacity, and refills", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { t, user, answer } = await setup();
  for (let i = 0; i < OUTBOX_CAP; i++) await answer(`answer-${i}`);
  expect(await answer("answer-0")).toMatchObject({ deduped: true });
  // Legacy retry also bypasses quota consumption.
  expect(await user.mutation(api.answers.answer, { questionId: "con-test", picked: "yes" })).toMatchObject({ deduped: true });
  await expect(answer("over-limit")).rejects.toThrow();
  const queued = ["queued-1", "queued-2"].map((eventId, at) => ({
    eventId, at, questionId: "con-test", picked: "yes", account: "tester",
  }));
  const drain = () => runDrain(queued, args => user.mutation(api.answers.answer, args), "tester");
  const blocked = await drain();
  expect(blocked.sent).toBe(0);
  expect(blocked.settledIds.size).toBe(0);
  expect(await user.query(api.answers.myStats)).toMatchObject({ answered: OUTBOX_CAP, serverAnswered: OUTBOX_CAP });
  const otherId = await t.run(ctx => ctx.db.insert("users", {}));
  await t.withIdentity({ subject: otherId }).mutation(api.answers.answer, {
    questionId: "con-test", picked: "yes", eventId: "other-user",
  });
  vi.advanceTimersByTime(1002);
  await answer("after-refill");
  expect(await user.query(api.answers.myStats)).toMatchObject({ answered: OUTBOX_CAP + 1 });
  vi.advanceTimersByTime(2001);
  const retried = await drain();
  expect(retried.sent).toBe(2);
  expect([...retried.settledIds]).toEqual(["queued-1", "queued-2"]);
});

it("normalizes names, reserves handles, and limits renames without changing the last name", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { t, user, userId } = await setup();
  await user.mutation(api.users.setDisplayName, { displayName: "  Ａlice\u202e\u2066\u061c\u200f\n  Smith  " });
  expect(await user.query(api.users.me)).toMatchObject({ displayName: "Alice Smith" });
  for (const displayName of ["\u202e  ", "＠player-abcd", "ｐｌａｙｅｒ-abc2", "pla\u200byer-abcd"]) {
    await expect(user.mutation(api.users.setDisplayName, { displayName })).rejects.toThrow();
  }
  for (let i = 0; i < 4; i++) await user.mutation(api.users.setDisplayName, { displayName: `Name ${i}` });
  await expect(user.mutation(api.users.setDisplayName, { displayName: "Too fast" })).rejects.toThrow();
  expect(await t.run(ctx => ctx.db.get(userId))).toMatchObject({ displayName: "Name 3" });
  vi.advanceTimersByTime(12002);
  await user.mutation(api.users.setDisplayName, { displayName: "After refill" });
});

it("limits account creation globally without retaining email keys, with transactional refusal", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { t } = await setup();
  const create = (email: string) => t.run(async ctx => {
    const userId = await ctx.db.insert("users", { email });
    await authCallbacks.afterUserCreatedOrUpdated!(ctx, {
      userId, existingUserId: null, type: "credentials", provider: Password(), profile: { email },
    });
    return userId;
  });
  for (let i = 0; i < 100; i++) await create(`user${i}@example.com`);
  await expect(create("over-global@example.com")).rejects.toThrow();
  expect(await t.run(ctx => ctx.db.query("users").collect())).toHaveLength(101);
  vi.advanceTimersByTime(3600001);
  await create("alice@example.com");
});

it("counts only the cohort with 20 server answers, with no percentile for an ineligible caller", async () => {
  const { t, user, userId, answer } = await setup();
  await user.mutation(api.users.claimProgress, { rating: 3000, answered: 1000000, correct: 1000000 });
  // Existing seed-only and legacy stats have no new eligibility field.
  await t.run(async ctx => {
    for (const seeded of [true, false]) {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("userStats", {
        userId: id, rating: 3000, answered: 1000000, correct: 1000000,
        streak: 0, bestStreak: 0, byCategory: [], seeded, updatedAt: Date.now(),
      });
    }
  });
  for (let i = 0; i < 19; i++) await answer(`cohort-${i}`);
  expect(await user.query(api.stats.population)).toMatchObject({ count: 0, median: null, percentile: null });
  await answer("twentieth");
  const stats = await user.query(api.answers.myStats);
  const population = await user.query(api.stats.population);
  expect(population).toMatchObject({ count: 1, median: stats!.rating, percentile: 0, capped: false });
  expect(population.buckets.reduce((a, b) => a + b, 0)).toBe(1);
  const otherId = await t.run(ctx => ctx.db.insert("users", {}));
  expect(await t.withIdentity({ subject: otherId }).query(api.stats.population)).toMatchObject({ count: 1, percentile: null });
  expect(await t.run(ctx => ctx.db.query("answerEvents").withIndex("by_user", q => q.eq("userId", userId)).collect())).toHaveLength(20);
});

it("conservatively initializes eligibility on legacy stats without counting imported totals", async () => {
  for (const seeded of [true, false]) {
    const { t, user, userId, answer } = await setup();
    await t.run(ctx => ctx.db.insert("userStats", {
      userId, rating: 3000, answered: 100, correct: 50, byCategory: [],
      streak: 0, bestStreak: 0, seeded, updatedAt: Date.now(),
    }));
    const first = await answer("legacy-next");
    expect(first.ratingBefore).toBe(seeded ? STARTING_ELO : 3000);
    expect(await user.query(api.answers.myStats)).toMatchObject({ serverAnswered: seeded ? 1 : 101 });
    expect(await user.query(api.stats.population)).toMatchObject({ count: seeded ? 0 : 1 });
  }
});

it("preserves a capped guest claim and clamps invalid correct counts", async () => {
  for (const [answered, correct, expectedAnswered, expectedCorrect] of [
    [123.9, 78.9, 123, 78], [50, 100, 50, 50], [5, -2, 5, 0], [5, NaN, 5, 0],
  ] as const) {
    const { user } = await setup();
    expect(await user.mutation(api.users.claimProgress, { rating: 3000, answered, correct })).toEqual({ seeded: true });
    expect(await user.query(api.answers.myStats)).toMatchObject({
      rating: STARTING_ELO, answered: expectedAnswered, correct: expectedCorrect,
      serverAnswered: 0, seeded: true,
    });
    expect(await user.query(api.stats.population)).toMatchObject({ count: 0 });
  }
});

it("replays 125 queued answers without hitting the limiter, even for the old error classifier", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { user } = await setup();
  const queued = Array.from({ length: 125 }, (_, at) => ({
    eventId: `replay-${at}`, at, questionId: "con-test", picked: "yes", account: "tester",
  }));
  const result = await runDrain(queued, args => user.mutation(api.answers.answer, args), "tester");
  expect(result.sent).toBe(125);
  expect(result.settledIds.size).toBe(125);
  expect(result.retryAfter).toBeUndefined();
  expect(await user.query(api.answers.myStats)).toMatchObject({ answered: 125 });
});

it("resets legacy seeded Elo once and admits only the new earned rating", async () => {
  const { t, user, userId, answer } = await setup();
  await t.run(ctx => ctx.db.insert("userStats", {
    userId, rating: 3000, answered: 1000, correct: 1000, byCategory: [],
    streak: 0, bestStreak: 0, seeded: true, updatedAt: Date.now(),
  }));
  let rating = STARTING_ELO;
  for (let i = 0; i < 20; i++) {
    const result = await answer(`earned-${i}`);
    expect(result.ratingBefore).toBe(rating);
    rating = result.ratingAfter;
  }
  expect(await user.query(api.stats.population)).toMatchObject({ count: 1, median: rating });
  expect(rating).toBeLessThan(1500);
});

it("accepts real names, removes invisible format characters, and keeps complete Unicode code points", () => {
  expect(normalizeDisplayName("Player One")).toBe("Player One");
  expect(normalizeDisplayName("PLAYER_abc2")).toBe("PLAYER_abc2");
  expect(normalizeDisplayName("A\u200b\u200c\u200d\ufefflice")).toBe("Alice");
  expect(normalizeDisplayName("x".repeat(39) + "😀" + "y")).toBe("x".repeat(39) + "😀");
});

it("exposes an account-deletion helper that resets only the caller's user quota keys", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { t, userId, user, answer } = await setup();
  for (let i = 0; i < OUTBOX_CAP; i++) await answer(`quota-${i}`);
  for (let i = 0; i < 5; i++) await user.mutation(api.users.setDisplayName, { displayName: `Name ${i}` });
  await expect(answer("blocked")).rejects.toThrow();
  await expect(user.mutation(api.users.setDisplayName, { displayName: "Blocked" })).rejects.toThrow();
  await t.run(ctx => resetUserRateLimits(ctx, userId));
  await answer("after-reset");
  await user.mutation(api.users.setDisplayName, { displayName: "After reset" });
});

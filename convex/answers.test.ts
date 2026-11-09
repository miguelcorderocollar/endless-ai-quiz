import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";

import { api, internal } from "./_generated/api";
import schema from "./schema";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

/**
 * The server half of the offline outbox (#17): `eventId` makes replayed
 * answers idempotent. The client half (`drainOutbox` ordering, stop-on-first-
 * failure) is unit-tested in `src/lib/answers/outbox.test.ts` with a stubbed
 * sender; these specs run the real mutation against an in-memory backend, so
 * the dedupe interaction they pin cannot drift from the deployed code.
 *
 * Three invariants, each load-bearing for Elo/streak/count integrity:
 *
 * 1. Replaying an `eventId` returns the stored result without inserting.
 *    (A mutation that succeeded while its response was lost must not count
 *    twice.)
 * 2. Two same-question, same-verdict answers with *distinct* `eventId`s both
 *    record. (The 5s network-retry window must not eat a genuine second
 *    attempt queued offline.)
 * 3. Two same-question, same-verdict answers *without* `eventId`s record
 *    once. (Old clients keep the legacy retry window.)
 */
async function setup() {
  // The canonical glob, `_generated` included: convex-test resolves its
  // virtual server modules and cross-module imports (including `../src`)
  // through it. The test file itself matches the glob too, which is harmless
  // — modules load lazily, on reference.
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  rateLimiterTest.register(t);
  const userId = await t.run(async (ctx) => {
    return await ctx.db.insert("users", {});
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("questions", {
      questionId: "con-9001",
      text: "Which field studies systems that perform tasks we associate with human intelligence?",
      options: ["Robotics", "Networking", "Cryptography", "Machine learning"],
      answer: "Machine learning",
      category: "concepts",
      difficulty: 3,
      explanation: "Machine learning improves from data rather than hand-written rules.",
      source: { kind: "wikipedia", title: "Machine learning", label: "Wikipedia" },
      tags: [],
      addedAt: "2026-01-01",
      status: "published",
      updatedAt: Date.now(),
    });
  });
  // `getAuthUserId` resolves the identity's subject (up to the divider)
  // straight to the user row — no session or provider linkage needed.
  const authed = t.withIdentity({ subject: userId });
  const eventCount = () =>
    t.run(async (ctx) => {
      return (
        await ctx.db
          .query("answerEvents")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect()
      ).length;
    });
  return { t, userId, authed, eventCount };
}

describe("answers.answer eventId replay", () => {
  it("records once and dedupes the replay without inserting", async () => {
    const { authed, eventCount } = await setup();

    const first = await authed.mutation(api.answers.answer, {
      questionId: "con-9001",
      picked: "Machine learning",
      eventId: "replay-1",
    });
    expect(first.deduped).toBe(false);
    expect(await eventCount()).toBe(1);

    const second = await authed.mutation(api.answers.answer, {
      questionId: "con-9001",
      picked: "Machine learning",
      eventId: "replay-1",
    });
    expect(second.deduped).toBe(true);
    expect(second.ratingAfter).toBe(first.ratingAfter);
    expect(await eventCount()).toBe(1);
  });

  it("records two offline attempts with distinct eventIds despite the 5s window", async () => {
    const { authed, eventCount } = await setup();

    await authed.mutation(api.answers.answer, {
      questionId: "con-9001",
      picked: "Robotics",
      eventId: "offline-first",
    });
    const second = await authed.mutation(api.answers.answer, {
      questionId: "con-9001",
      picked: "Robotics",
      eventId: "offline-second",
    });

    expect(second.deduped).toBe(false);
    expect(await eventCount()).toBe(2);
  });

  it("keeps the legacy 5s window for clients without eventId", async () => {
    const { authed, eventCount } = await setup();

    await authed.mutation(api.answers.answer, {
      questionId: "con-9001",
      picked: "Robotics",
    });
    const retry = await authed.mutation(api.answers.answer, {
      questionId: "con-9001",
      picked: "Robotics",
    });

    expect(retry.deduped).toBe(true);
    expect(await eventCount()).toBe(1);
  });

  it("still records a changed verdict without eventId", async () => {
    const { authed, eventCount } = await setup();

    await authed.mutation(api.answers.answer, {
      questionId: "con-9001",
      picked: "Robotics",
    });
    const corrected = await authed.mutation(api.answers.answer, {
      questionId: "con-9001",
      picked: "Machine learning",
    });

    expect(corrected.deduped).toBe(false);
    expect(corrected.correct).toBe(true);
    expect(await eventCount()).toBe(2);
  });
});

describe("casual question trust boundary", () => {
  it("draws without teaching content, then reveals after a valid pick without recording", async () => {
    const { authed, eventCount } = await setup();
    const rows = await authed.query(api.questions.drawForPlay, { excludeIds: [] });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "addedAt", "category", "difficulty", "options", "questionId", "tags", "text",
    ]);
    const revealed = await authed.mutation(api.answers.reveal, {
      questionId: rows[0]!.questionId, picked: "Robotics",
    });
    expect(revealed).toMatchObject({ correct: false, answer: "Machine learning" });
    expect(revealed.explanation).not.toBe("");
    expect(revealed.source.kind).toBe("wikipedia");
    expect(await eventCount()).toBe(0);
    await authed.mutation(api.answers.answer, {
      questionId: rows[0]!.questionId, picked: "Robotics", eventId: "revealed-outbox",
    });
    await authed.mutation(api.answers.answer, {
      questionId: rows[0]!.questionId, picked: "Robotics", eventId: "revealed-outbox",
    });
    expect(await eventCount()).toBe(1);
  });

  it("rejects invalid picks and missing questions", async () => {
    const { authed } = await setup();
    await expect(authed.mutation(api.answers.reveal, {
      questionId: "con-9001", picked: "injected option",
    })).rejects.toThrow("Pick one of the offered options");
    await expect(authed.mutation(api.answers.reveal, {
      questionId: "missing", picked: "Robotics",
    })).rejects.toThrow("Unknown question");
  });

  it("gates the full bank while retaining the legacy draw", async () => {
    const { authed } = await setup();
    expect(await authed.query(api.questions.list, {})).toEqual([]);
    expect((await authed.query(api.questions.draw, { excludeIds: [] }))[0]!.answer)
      .toBe("Machine learning");
  });

  it("lets only admins read the full list and keeps the publish query internal", async () => {
    const { t, userId, authed } = await setup();
    expect(await t.query(api.questions.list, {})).toEqual([]);
    const guestReveal = await t.mutation(api.answers.reveal, {
      questionId: "con-9001", picked: "Machine learning",
    });
    expect(guestReveal.correct).toBe(true);
    await t.run(async (ctx) => { await ctx.db.patch(userId, { role: "admin" }); });
    expect((await authed.query(api.questions.list, {}))[0]!.answer).toBe("Machine learning");
    expect(await t.query(internal.questions.publishedList, {})).toHaveLength(1);
    await t.run(async (ctx) => {
      const q = await ctx.db.query("questions").first();
      await ctx.db.patch(q!._id, { status: "archived" });
    });
    expect(await t.query(api.questions.drawForPlay, { excludeIds: [] })).toEqual([]);
    await expect(t.mutation(api.answers.reveal, {
      questionId: "con-9001", picked: "Machine learning",
    })).rejects.toThrow("Unknown question");
  });
});

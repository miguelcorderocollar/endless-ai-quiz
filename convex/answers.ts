import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { rateLimiter } from "./rateLimits";
import { questionFields } from "./schema";
import { requireUser } from "./access";
import { STARTING_ELO, scoreAnswer } from "../src/lib/quiz/elo";
import { getAuthUserId } from "@convex-dev/auth/server";

/**
 * Casual online reveal, available to guests too. This does not award Elo:
 * signed-in attempts still use the existing ordered, idempotent outbox.
 * The public offline bank means these results are unsuitable for competition.
 */
export const reveal = mutation({
  args: { questionId: v.string(), picked: v.string() },
  returns: v.object({
    correct: v.boolean(), answer: v.string(), explanation: v.string(),
    source: questionFields.source,
  }),
  handler: async (ctx, args) => {
    const question = await ctx.db.query("questions")
      .withIndex("by_questionId", (q) => q.eq("questionId", args.questionId)).first();
    if (!question || question.status !== "published") {
      throw new ConvexError("Unknown question.");
    }
    if (!question.options.includes(args.picked)) {
      throw new ConvexError("Pick one of the offered options.");
    }
    return {
      correct: args.picked === question.answer, answer: question.answer,
      explanation: question.explanation, source: question.source,
    };
  },
});

/**
 * Records one answered question and moves Elo — the only writer of both
 * (#3 + #4). The client computes nothing; the returned rating is truth and
 * the client reconciles its local cache to it.
 *
 * Event-sourced rating: the player's current rating is the latest event's
 * `ratingAfter` (STARTING_ELO when there are no events), so no rating column
 * is needed on `users` and replays can't drift it.
 *
 * The same mutation maintains `userStats` (#34): the materialized per-user
 * rollup every per-user read comes from. The event log is never scanned for
 * reads beyond point lookups.
 *
 * Guards:
 * - unknown or archived questions are rejected (client plays published only)
 * - same verdict within 5s of the previous event for the same question is a
 *   network retry: returns the previous result without inserting. A changed
 *   verdict (wrong then right) always records as a new event.
 * - an `eventId` that already exists for this user is an outbox replay of a
 *   mutation that succeeded on the server but whose response was lost on the
 *   way back: returns the stored result without inserting. Exact, no time
 *   window, and it suppresses the 5s rule below — a player who genuinely
 *   answered the same question twice offline would otherwise lose the second
 *   attempt at replay.
 */
export const answer = mutation({
  args: {
    questionId: v.string(),
    picked: v.string(),
    eventId: v.optional(v.string()),
  },
  returns: v.object({
    correct: v.boolean(), ratingBefore: v.number(), ratingAfter: v.number(),
    delta: v.number(), deduped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    const question = await ctx.db
      .query("questions")
      .withIndex("by_questionId", (q) => q.eq("questionId", args.questionId))
      .take(1)
      .then((rows) => rows[0]);
    if (!question || question.status !== "published") {
      throw new ConvexError("Unknown question.");
    }

    if (args.eventId) {
      const replayed = await ctx.db
        .query("answerEvents")
        .withIndex("by_user_event", (q) =>
          q.eq("userId", userId).eq("eventId", args.eventId),
        )
        .take(1)
        .then((rows) => rows[0]);
      if (replayed) {
        return {
          correct: replayed.correct,
          ratingBefore: replayed.ratingBefore,
          ratingAfter: replayed.ratingAfter,
          delta:
            Math.round((replayed.ratingAfter - replayed.ratingBefore) * 10) / 10,
          deduped: true,
        };
      }
    }

    const recent = await ctx.db
      .query("answerEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(1);
    const last = recent[0] ?? null;
    // Prefer the rollup: identical to the latest event for event-derived
    // users, and honors a seeded claim (lazy signup) that has no events yet.
    const stats = await ctx.db
      .query("userStats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(1)
      .then((rows) => rows[0]);
    // Legacy imports could choose their Elo. Reset that untrusted baseline
    // once, before scoring the first answer that initializes serverAnswered.
    const legacySeed = stats?.seeded && stats.serverAnswered === undefined;
    const ratingBefore = legacySeed ? STARTING_ELO : stats?.rating ?? last?.ratingAfter ?? STARTING_ELO;

    const lastSame =
      last && last.questionId === question._id
        ? last
        : (
            await ctx.db
              .query("answerEvents")
              .withIndex("by_user_question", (q) =>
                q.eq("userId", userId).eq("questionId", question._id),
              )
              .order("desc")
              .take(1)
          )[0] ?? null;
    const correct = args.picked === question.answer;
    // Same outcome within 5s of the previous event for this question means a
    // network retry, not a new attempt — return the previous result without
    // inserting. A changed verdict (wrong then right) always records. Skipped
    // for outbox replays: their dedupe is the exact `eventId` lookup above,
    // and a player who answered the same question twice while offline (both
    // queued, both replayed seconds apart) would otherwise lose the second
    // attempt to this rule.
    if (
      !args.eventId &&
      lastSame &&
      Date.now() - lastSame.createdAt < 5000 &&
      lastSame.correct === correct
    ) {
      return {
        correct: lastSame.correct,
        ratingBefore: lastSame.ratingBefore,
        ratingAfter: lastSame.ratingAfter,
        delta: lastSame.ratingAfter - lastSame.ratingBefore,
        deduped: true,
      };
    }

    await rateLimiter.limit(ctx, "answer", { key: userId, throws: true });

    const { delta, rating } = scoreAnswer(ratingBefore, question.difficulty, correct);
    const now = Date.now();

    // Stats before the event insert: the first-answer fold must not include
    // this answer (it applies it itself), or it would count twice.
    await upsertStats(ctx, userId, {
      rating,
      correct,
      category: question.category,
      now,
    });

    await ctx.db.insert("answerEvents", {
      userId,
      questionId: question._id,
      category: question.category,
      difficulty: question.difficulty,
      correct,
      ratingBefore,
      ratingAfter: rating,
      createdAt: now,
      ...(args.eventId ? { eventId: args.eventId } : {}),
    });

    return {
      correct,
      ratingBefore,
      ratingAfter: rating,
      delta: Math.round(delta * 10) / 10,
      deduped: false,
    };
  },
});

/** Current user's materialized rollup, or null before their first answer. */
export const myStats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const stats = await ctx.db
      .query("userStats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(1)
      .then((rows) => rows[0]);
    return stats ?? null;
  },
});

/**
 * Builds the rollup on demand for users whose events predate userStats (so
 * /profile never falls back to device-only numbers while signed in). No-op
 * when stats exist or the user has never answered. Bounded fold, idempotent.
 */
export const ensureStats = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("userStats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(1);
    if (existing.length > 0) return { created: false };

    const anyEvent = await ctx.db
      .query("answerEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(1);
    if (anyEvent.length === 0) return { created: false };

    const folded = await foldUserEvents(ctx, userId);
    const last = await ctx.db
      .query("answerEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(1);

    await ctx.db.insert("userStats", {
      userId,
      rating: last[0]?.ratingAfter ?? STARTING_ELO,
      answered: folded.answered,
      serverAnswered: folded.answered,
      correct: folded.correct,
      streak: folded.trailingStreak,
      bestStreak: folded.bestStreak,
      byCategory: folded.byCategory,
      updatedAt: Date.now(),
    });
    return { created: true };
  },
});

/**
 * Distinct public questionIds the current user answered correctly.
 * Guests get []. Used on login to replace device-local completed ids when
 * the account already existed, so the existing account stays visible instead
 * of the guest's local list. Paginated like the stats fold (20k cap).
 */
export const myCompleted = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 40; pages++) {
      const page = await ctx.db
        .query("answerEvents")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .paginate({ cursor, numItems: 500 });
      const correctEvents = page.page.filter((e) => e.correct);
      const questions = await Promise.all(
        correctEvents.map((e) => ctx.db.get(e.questionId)),
      );
      for (const q of questions) {
        const publicId = q?.questionId;
        if (publicId && !seen.has(publicId)) {
          seen.add(publicId);
          out.push(publicId);
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    return out;
  },
});

type CategoryCount = { category: string; answered: number; correct: number };

/**
 * The caller's most recent attempts, newest first (both verdicts, capped).
 * Tiny docs, single bounded take. The profile derives its misses list from
 * this: most-recent verdict per question wins, so a later correct clears the
 * miss. Guests use the device-local recent ring instead.
 */
export const myRecent = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const n = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const events = await ctx.db
      .query("answerEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(n);
    const questions = await Promise.all(
      events.map((e) => ctx.db.get(e.questionId)),
    );
    return events.flatMap((e, i) => {
      const publicId = questions[i]?.questionId;
      return publicId
        ? [{ questionId: publicId, correct: e.correct, createdAt: e.createdAt }]
        : [];
    });
  },
});

/**
 * Maintains the per-user rollup transactionally with the event insert.
 * First call for a pre-stats user folds their existing events once (bounded
 * paginated scan, then every later answer is O(1)). Streak counts the current
 * correct-in-a-row run; a wrong answer resets it.
 */
async function upsertStats(
  ctx: MutationCtx,
  userId: Id<"users">,
  answer: { rating: number; correct: boolean; category: string; now: number },
) {
  const existing = await ctx.db
    .query("userStats")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(1)
    .then((rows) => rows[0]);

  if (!existing) {
    const folded = await foldUserEvents(ctx, userId);
    await ctx.db.insert("userStats", {
      userId,
      rating: answer.rating,
      answered: folded.answered + 1,
      serverAnswered: folded.answered + 1,
      correct: folded.correct + (answer.correct ? 1 : 0),
      streak: answer.correct ? folded.trailingStreak + 1 : 0,
      bestStreak: Math.max(
        folded.bestStreak,
        answer.correct ? folded.trailingStreak + 1 : 0,
      ),
      byCategory: bumpCategory(folded.byCategory, answer.category, answer.correct),
      updatedAt: answer.now,
    });
    return;
  }

  const streak = answer.correct ? existing.streak + 1 : 0;
  await ctx.db.patch(existing._id, {
    rating: answer.rating,
    answered: existing.answered + 1,
    serverAnswered: (existing.serverAnswered ?? (existing.seeded ? 0 : existing.answered)) + 1,
    correct: existing.correct + (answer.correct ? 1 : 0),
    streak,
    bestStreak: Math.max(existing.bestStreak, streak),
    byCategory: bumpCategory(existing.byCategory, answer.category, answer.correct),
    updatedAt: answer.now,
  });
}

function bumpCategory(
  counts: CategoryCount[],
  category: string,
  correct: boolean,
): CategoryCount[] {
  const next = counts.map((c) => ({ ...c }));
  const entry = next.find((c) => c.category === category);
  if (entry) {
    entry.answered += 1;
    if (correct) entry.correct += 1;
  } else {
    next.push({ category, answered: 1, correct: correct ? 1 : 0 });
  }
  return next;
}

/**
 * One-time fold for users whose events predate userStats. Paginated so no
 * single call reads unbounded history; 20k events covers ~20 years of daily
 * play, after which the oldest history stays in the log but leaves the rollup.
 */
async function foldUserEvents(ctx: MutationCtx, userId: Id<"users">) {
  let answered = 0;
  let correct = 0;
  let bestStreak = 0;
  let trailingStreak = 0;
  const byCategory: CategoryCount[] = [];
  let cursor: string | null = null;

  for (let pages = 0; pages < 40; pages++) {
    const page = await ctx.db
      .query("answerEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .paginate({ cursor, numItems: 500 });
    for (const e of page.page) {
      answered += 1;
      if (e.correct) {
        correct += 1;
        trailingStreak += 1;
        bestStreak = Math.max(bestStreak, trailingStreak);
      } else {
        trailingStreak = 0;
      }
      const entry = byCategory.find((c) => c.category === e.category);
      if (entry) {
        entry.answered += 1;
        if (e.correct) entry.correct += 1;
      } else {
        byCategory.push({
          category: e.category,
          answered: 1,
          correct: e.correct ? 1 : 0,
        });
      }
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }

  return { answered, correct, bestStreak, trailingStreak, byCategory };
}

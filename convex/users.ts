import { ConvexError, v } from "convex/values";
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";

import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isAdminEmail, requireAdmin, requireUser } from "./access";
import { rateLimiter } from "./rateLimits";
import { STARTING_ELO } from "../src/lib/quiz/elo";

import { beginUserDeletion, deleteUserBatch } from "./lib/deleteUser";

const HANDLE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomHandle(): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += HANDLE_ALPHABET[Math.floor(Math.random() * HANDLE_ALPHABET.length)];
  }
  return `player-${suffix}`;
}

/** Current signed-in profile, or null for guests. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return {
      handle: user.handle ?? null,
      displayName: user.displayName ?? null,
      role: user.role ?? "user",
      isAnonymous: user.isAnonymous ?? false,
    };
  },
});

/**
 * Backfills profile defaults for rows auth created without them (anonymous
 * sign-in, or signups predating a field). Only fills missing fields — it
 * never overwrites role/tier, so it cannot escalate. Idempotent.
 */
export const ensureProfile = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError("No such user.");

    const patch: {
      handle?: string;
      role?: "user" | "admin";
      tier?: "free";
      createdAt?: number;
    } = {};

    if (!user.handle) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = randomHandle();
        const taken = await ctx.db
          .query("users")
          .withIndex("by_handle", (q) => q.eq("handle", candidate))
          .take(1);
        if (taken.length === 0) {
          patch.handle = candidate;
          break;
        }
      }
      patch.handle ??= `player-${userId.slice(-6)}`;
    }
    if (!user.role) {
      patch.role = isAdminEmail(user.email) ? "admin" : "user";
    }
    if (!user.tier) patch.tier = "free";
    if (!user.createdAt) patch.createdAt = user._creationTime;

    if (Object.keys(patch).length > 0) await ctx.db.patch(userId, patch);
    return { ok: true };
  },
});

export function normalizeDisplayName(value: string): string {
  const name = Array.from(value.normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ").trim()).slice(0, 40).join("").trim();
  if (!name) throw new ConvexError("Display name cannot be empty.");
  // Handles identify accounts. Reserve their namespace, including fullwidth
  // forms after normalization and names prefixed by @.
  if (/^@?player-(?:[abcdefghjkmnpqrstuvwxyz23456789]{4}|[a-z0-9]{6})$/iu.test(name)) {
    throw new ConvexError("Display name cannot look like an account handle.");
  }
  return name;
}

/** Rename yourself. */
export const setDisplayName = mutation({
  args: { displayName: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const name = normalizeDisplayName(args.displayName);
    await rateLimiter.limit(ctx, "displayName", { key: userId, throws: true });
    await ctx.db.patch(userId, { displayName: name });
    return { ok: true };
  },
});

/**
 * Imports capped guest counts at signup (#59), retaining STARTING_ELO.
 * The imported category records counts with no trusted category breakdown.
 * Only when the user has neither stats nor events — i.e. the account is brand
 * new. An existing account (stats or events present) keeps its server history:
 * local totals are ignored and nothing is overwritten, so logging into an
 * existing account from a device with guest progress leaves that account
 * untouched. Idempotent.
 *
 * Edge case: stats doc missing but events present (pre-rollup accounts). The
 * rollup is rebuilt by folding the account's own events — still never from
 * local — so the existing history stays visible.
 */
export const claimProgress = mutation({
  args: {
    rating: v.number(),
    answered: v.number(),
    correct: v.number(),
  },
  returns: v.object({ seeded: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    const existingStats = await ctx.db
      .query("userStats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(1);
    if (existingStats.length > 0) return { seeded: false };

    const hasEvents =
      (
        await ctx.db
          .query("answerEvents")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(1)
      ).length > 0;
    if (hasEvents) {
      await rebuildStatsFromOwnEvents(ctx, userId);
      return { seeded: false };
    }

    // Preserve bounded guest totals, but never import a client-chosen rating.
    const answered = Number.isFinite(args.answered)
      ? Math.min(1000, Math.max(0, Math.floor(args.answered))) : 0;
    const correct = Number.isFinite(args.correct)
      ? Math.min(answered, Math.max(0, Math.floor(args.correct))) : 0;
    const rating = STARTING_ELO;
    if (answered === 0) return { seeded: false };

    await ctx.db.insert("userStats", {
      userId,
      rating,
      answered,
      correct,
      streak: 0,
      bestStreak: 0,
      byCategory: [{ category: "imported", answered, correct }],
      seeded: true,
      serverAnswered: 0,
      updatedAt: Date.now(),
    });
    return { seeded: true };
  },
});

/**
 * Rebuilds a missing rollup from the account's own events only. Used when an
 * existing account predates userStats: the existing history stays (rating =
 * latest event, counts folded), device-local totals are ignored.
 */
async function rebuildStatsFromOwnEvents(ctx: MutationCtx, userId: Id<"users">) {
  let answered = 0;
  let correct = 0;
  let bestStreak = 0;
  let trailingStreak = 0;
  let rating = STARTING_ELO;
  const byCategory: { category: string; answered: number; correct: number }[] = [];
  let cursor: string | null = null;

  for (let pages = 0; pages < 40; pages++) {
    const page = await ctx.db
      .query("answerEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .paginate({ cursor, numItems: 500 });
    for (const e of page.page) {
      answered += 1;
      rating = e.ratingAfter;
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

  await ctx.db.insert("userStats", {
    userId,
    rating,
    answered,
    serverAnswered: answered,
    correct,
    streak: trailingStreak,
    bestStreak,
    byCategory,
    updatedAt: Date.now(),
  });
}

/**
 * Wipes the caller's play history: all answer events and their rollup. The
 * account, handle, and role survive — only the points/history go. This is the
 * "start over" button and is irreversible by design.
 */
export const resetProgress = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    let events = 0;
    let stats = 0;

    let cursor: string | null = null;
    for (;;) {
      const page = await ctx.db
        .query("answerEvents")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .paginate({ cursor, numItems: 200 });
      for (const doc of page.page) {
        await ctx.db.delete(doc._id);
        events++;
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    const statRows = await ctx.db
      .query("userStats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const doc of statRows) {
      await ctx.db.delete(doc._id);
      stats++;
    }

    return { events, stats };
  },
});

/**
 * Proves the admin gate from #2: population counts for future admin tooling
 * (#30). Throws "Admin only." for everyone else.
 */
export const adminStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [users, questions] = await Promise.all([
      ctx.db.query("users").take(1000),
      ctx.db.query("questions").take(20000),
    ]);
    return {
      users: users.length,
      questions: questions.length,
      admins: users.filter((u) => u.role === "admin").length,
    };
  },
});

/** Recent means a new authenticated session, never a refreshed access token. */
export const deleteAccount = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Sign in required.");
    const user = await ctx.db.get(userId);
    // A retried request after a lost response must still let the client clear
    // local data. No further destructive work is initiated by this branch.
    if (!user || user.deletionStartedAt !== undefined) return null;
    const sessionId = await getAuthSessionId(ctx);
    const session = sessionId ? await ctx.db.get(sessionId) : null;
    if (!session || session.userId !== userId ||
        session.expirationTime <= Date.now() ||
        Date.now() - session._creationTime > 5 * 60 * 1000) {
      throw new ConvexError("Sign out and sign in again, then delete within five minutes.");
    }
    await beginUserDeletion(ctx, userId);
    return null;
  },
});

export const continueDeletion = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    await deleteUserBatch(ctx, userId);
    return null;
  },
});

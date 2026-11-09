import { v } from "convex/values";

import { internalMutation, internalQuery, query } from "./_generated/server";
import { matchWeight, weightedSample } from "../src/lib/quiz/engine";
import schema, { questionFields } from "./schema";
import { authUserId } from "./access";
import type { QueryCtx } from "./_generated/server";

/** CLI-only full bank for publishing. */
async function publishedBank(ctx: QueryCtx) {
  return await ctx.db.query("questions")
    .withIndex("by_status", (q) => q.eq("status", "published")).collect();
}

export const publishedList = internalQuery({
  args: {},
  returns: v.array(schema.doc("questions")),
  handler: publishedBank,
});

/** Admin-gated compatibility shim. Old profile clients receive an empty list. */
export const list = query({
  args: {},
  returns: v.array(schema.doc("questions")),
  handler: async (ctx) => {
    const userId = await authUserId(ctx);
    const user = userId ? await ctx.db.get(userId) : null;
    return user?.role === "admin" ? await publishedBank(ctx) : [];
  },
});

/**
 * Server-side draw (#25): returns a handful of random published questions
 * excluding the caller's known-seen ids, so page loads transfer O(1)
 * questions instead of the whole bank. The client sends its seen ids
 * (session + local done list), capped at the most recent 1000 — ancient
 * correct answers may resurface past the cap, which matches the
 * misses-come-back spirit.
 *
 * `categories` narrows the pool to the fun-mode filter (#12). It never
 * touches Elo or ranking — the answer mutation scores identically.
 *
 * `ratingHint` Elo-matches the page (#32): the client's local rating biases
 * the draw toward on-level questions. Safe to accept from the client —
 * selection is not scoreable (easy questions at high Elo gain ~nothing, hard
 * ones risk losses), and the client re-weights its pick anyway. Absent for
 * guests: uniform draw, the old behavior.
 *
 * Scaling note (#34): the full published collect is fine to ~1-2k questions.
 * Past that, swap the collect for aggregate-backed random access and keep
 * this signature.
 */
const drawArgs = {
  excludeIds: v.array(v.string()),
  count: v.optional(v.number()),
  categories: v.optional(v.array(v.string())),
  ratingHint: v.optional(v.number()),
};

async function drawQuestions(ctx: QueryCtx, args: {
  excludeIds: string[]; count?: number; categories?: string[]; ratingHint?: number;
}) {
  const n = Math.min(Math.max(args.count ?? 20, 1), 50);
  const hint = args.ratingHint;
  const excluded = new Set(args.excludeIds.slice(-1000));
  const filter = new Set(args.categories ?? []);
  const pool = (
    await ctx.db
      .query("questions")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .collect()
  ).filter(
    (q) =>
      !excluded.has(q.questionId) &&
      (filter.size === 0 || filter.has(q.category)),
  );

  if (hint === undefined) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool.slice(0, n);
  }
  return weightedSample(
    pool,
    pool.map((q) => matchWeight(q.difficulty, hint)),
    n,
  );
}


/** Legacy casual draw retained for installed PWA and native clients. */
export const draw = query({
  args: drawArgs,
  returns: v.array(schema.doc("questions")),
  handler: drawQuestions,
});

const playFields = v.object(questionFields).omit("answer", "explanation", "source");

/** Online play gets an explicit allowlist. Teaching content waits for a pick. */
export const drawForPlay = query({
  args: drawArgs,
  returns: v.array(playFields),
  handler: async (ctx, args) => (await drawQuestions(ctx, args)).map((q) => ({
    questionId: q.questionId, text: q.text, options: q.options,
    category: q.category, difficulty: q.difficulty, tags: q.tags, addedAt: q.addedAt,
  })),
});

/** Published counts per category for the picker (#12). Tiny table, direct read. */
export const counts = query({
  args: {},
  handler: async (ctx) => {
    const counts = new Map<string, number>();
    const rows = await ctx.db
      .query("questions")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .collect();
    for (const q of rows) counts.set(q.category, (counts.get(q.category) ?? 0) + 1);
    return [...counts.entries()].map(([category, count]) => ({ category, count }));
  },
});

const sameStrings = (a: string[], b: string[]) =>
  a.length === b.length && a.every((s, i) => s === b[i]);

type Source = {
  kind: string;
  title?: string;
  url?: string;
  label?: string;
};

/** Key-order-insensitive: Convex may re-serialize object keys on write. */
const sameSource = (a: Source, b: Source) =>
  a.kind === b.kind &&
  (a as { title?: string }).title === (b as { title?: string }).title &&
  (a as { url?: string }).url === (b as { url?: string }).url &&
  (a as { label?: string }).label === (b as { label?: string }).label;

/**
 * Upsert one batch of the validated bank. Internal on purpose: publish via
 * authenticated `npx convex run` (see `scripts/publish.mts`), never from the
 * client. Matches per stable `questionId`: inserts new rows, patches changed
 * ones. Run `prune` afterwards to archive rows deleted from git.
 */
export const sync = internalMutation({
  args: {
    commit: v.optional(v.string()),
    questions: v.array(v.object(questionFields)),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("questions").collect();
    const byId = new Map(existing.map((d) => [d.questionId, d]));

    let inserted = 0;
    let updated = 0;

    for (const q of args.questions) {
      const doc = byId.get(q.questionId);
      if (!doc) {
        await ctx.db.insert("questions", {
          ...q,
          status: "published",
          updatedAt: now,
          commit: args.commit,
        });
        inserted += 1;
        continue;
      }
      if (
        doc.status !== "published" ||
        doc.text !== q.text ||
        !sameStrings(doc.options, q.options) ||
        doc.answer !== q.answer ||
        doc.category !== q.category ||
        doc.difficulty !== q.difficulty ||
        doc.explanation !== q.explanation ||
        !sameSource(
          doc.source as Source,
          q.source as unknown as Source,
        ) ||
        !sameStrings(doc.tags, q.tags) ||
        doc.addedAt !== q.addedAt
      ) {
        await ctx.db.patch(doc._id, {
          ...q,
          status: "published",
          updatedAt: now,
          commit: args.commit,
        });
        updated += 1;
      }
    }

    return {
      inserted,
      updated,
      unchanged: args.questions.length - inserted - updated,
    };
  },
});

/**
 * Archive published rows missing from the bank (deleted in git). Takes only
 * the id list, so it stays tiny no matter the bank size.
 *
 * Archive rather than delete by default: a missed judgement from `npm run dupe`
 * is one `sync` away from being undone, and the row plus its answer history is
 * the record of what shipped.
 */
export const prune = internalMutation({
  args: {
    keepIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const keep = new Set(args.keepIds);
    const existing = await ctx.db
      .query("questions")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .collect();
    let archived = 0;
    for (const doc of existing) {
      if (!keep.has(doc.questionId)) {
        await ctx.db.patch(doc._id, {
          status: "archived",
          updatedAt: Date.now(),
        });
        archived += 1;
      }
    }
    return { archived };
  },
});

/**
 * Permanently remove rows that are already archived, i.e. content that has been
 * out of the playable set for at least one publish. Two-step on purpose: this
 * only ever touches a row `prune` retired earlier, so a live question cannot be
 * destroyed by one mistake in the bank file.
 *
 * `answerEvents.questionId` is a document reference, and Convex does not
 * cascade, so events against a removed question become unresolvable. That is
 * already how the read paths behave: `myRecent` and `answeredCorrectly` skip
 * rows they cannot resolve, and `answer` rejects anything not `published`. The
 * event log and `userStats` rollups survive regardless, so per-user rating,
 * streak and counts are unaffected.
 */
export const purgeArchived = internalMutation({
  args: {
    /** Guard: refuse unless the caller confirms the ids are already archived. */
    ids: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    let removed = 0;
    let skipped = 0;
    for (const id of args.ids) {
      const doc = await ctx.db
        .query("questions")
        .withIndex("by_questionId", (q) => q.eq("questionId", id))
        .take(1)
        .then((rows) => rows[0]);
      if (!doc) {
        skipped += 1;
        continue;
      }
      if (doc.status !== "archived") {
        // Never purge a playable question: archiving first is the reversible step.
        skipped += 1;
        continue;
      }
      await ctx.db.delete(doc._id);
      removed += 1;
    }
    return { removed, skipped };
  },
});

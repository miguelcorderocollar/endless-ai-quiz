import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Simple model (issue #27): git (`content/questions/*.json`) is the draft
 * space, Convex holds the published set only — one doc per stable questionId.
 * No snapshots, no content versions, no per-question history.
 *
 * Auth (#2): Convex Auth owns identity. The `users` table below extends the
 * auth `users` table — every custom field stays optional because auth creates
 * rows (including legacy anonymous users) without them; `ensureProfile`
 * (`convex/users.ts`) backfills handle/role/tier/createdAt. Never take `role`
 * from client params; it is assigned server-side from ADMIN_EMAILS.
 */
const source = v.union(
  v.object({ kind: v.literal("wikipedia"), title: v.string(), label: v.string() }),
  v.object({ kind: v.literal("url"), url: v.string(), label: v.string() }),
  v.object({ kind: v.literal("none") }),
);

export const questionFields = {
  questionId: v.string(),
  text: v.string(),
  options: v.array(v.string()),
  answer: v.string(),
  category: v.string(),
  difficulty: v.number(),
  explanation: v.string(),
  source,
  tags: v.array(v.string()),
  addedAt: v.string(),
};

export const roleValidator = v.union(v.literal("user"), v.literal("admin"));
export const tierValidator = v.union(v.literal("free"), v.literal("paid"));

export default defineSchema({
  ...authTables,

  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    handle: v.optional(v.string()),
    displayName: v.optional(v.string()),
    role: v.optional(roleValidator),
    tier: v.optional(tierValidator),
    createdAt: v.optional(v.number()),
    deletionStartedAt: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("by_handle", ["handle"]),

  questions: defineTable({
    ...questionFields,
    status: v.union(v.literal("published"), v.literal("archived")),
    updatedAt: v.number(),
    commit: v.optional(v.string()),
  })
    .index("by_questionId", ["questionId"])
    .index("by_status", ["status"]),

  answerEvents: defineTable({
    userId: v.id("users"),
    questionId: v.id("questions"),
    category: v.string(),
    difficulty: v.number(),
    correct: v.boolean(),
    ratingBefore: v.number(),
    ratingAfter: v.number(),
    createdAt: v.number(),
    /**
     * Client-generated UUID for answers that traveled through the offline
     * outbox (#17). A mutation that succeeded on the server but whose response
     * never reached the phone would otherwise be recorded twice on replay —
     * Elo, streaks and counts would all fork. With this, replay is an exact
     * lookup first, insert second. Optional so older clients (which keep the
     * 5s retry window below) write events the same shape as before.
     */
    eventId: v.optional(v.string()),
  })
    .index("by_user", ["userId", "createdAt"])
    .index("by_user_question", ["userId", "questionId"])
    .index("by_user_event", ["userId", "eventId"]),

  /**
   * Materialized per-user rollup (#34). The event log is write-only at scale;
   * every per-user read (rating, streak, counts, category bars) comes from
   * this one doc, updated transactionally in the `answer` mutation. Global
   * rank/percentile will use the aggregate component (#8), never event scans.
   */
  userStats: defineTable({
    userId: v.id("users"),
    rating: v.number(),
    answered: v.number(),
    correct: v.number(),
    streak: v.number(),
    bestStreak: v.number(),
    byCategory: v.array(
      v.object({
        category: v.string(),
        answered: v.number(),
        correct: v.number(),
      }),
    ),
    seeded: v.optional(v.boolean()),
    // Only answers recorded by the server qualify for population statistics.
    serverAnswered: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_rating", ["rating"])
    .index("by_serverAnswered", ["serverAnswered"]),
});

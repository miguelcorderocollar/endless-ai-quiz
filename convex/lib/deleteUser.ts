import { resetUserRateLimits } from "../rateLimits";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const BATCH_SIZE = 100;

/** Block old clients' writes before scheduling any destructive work. */
export async function beginUserDeletion(ctx: MutationCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  if (!user) return;
  if (user.deletionStartedAt === undefined) {
    await ctx.db.patch(userId, { deletionStartedAt: Date.now() });
  }
  // A previous scheduled batch may have failed. Repeated requests resume it.
  await ctx.scheduler.runAfter(0, internal.users.continueDeletion, { userId });
}

/**
 * Each transaction deletes at most 100 children plus one parent. Always take
 * from the start of the index so deleting rows cannot invalidate a cursor.
 * Parent rows stay until their children are gone, making retries safe.
 */
export async function deleteUserBatch(ctx: MutationCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  if (!user || user.deletionStartedAt === undefined) return;
  const again = () => ctx.scheduler.runAfter(0, internal.users.continueDeletion, { userId });

  const events = await ctx.db.query("answerEvents")
    .withIndex("by_user", q => q.eq("userId", userId)).take(BATCH_SIZE);
  if (events.length) {
    for (const row of events) await ctx.db.delete(row._id);
    await again();
    return;
  }
  const stats = await ctx.db.query("userStats")
    .withIndex("by_user", q => q.eq("userId", userId)).take(BATCH_SIZE);
  if (stats.length) {
    for (const row of stats) await ctx.db.delete(row._id);
    await again();
    return;
  }
  const account = await ctx.db.query("authAccounts")
    .withIndex("userIdAndProvider", q => q.eq("userId", userId)).first();
  if (account) {
    const codes = await ctx.db.query("authVerificationCodes")
      .withIndex("accountId", q => q.eq("accountId", account._id)).take(BATCH_SIZE);
    for (const row of codes) await ctx.db.delete(row._id);
    if (!codes.length) {
      const limits = await ctx.db.query("authRateLimits")
        .withIndex("identifier", q => q.eq("identifier", account._id)).take(BATCH_SIZE);
      for (const row of limits) await ctx.db.delete(row._id);
      if (!limits.length) await ctx.db.delete(account._id);
    }
    await again();
    return;
  }
  const session = await ctx.db.query("authSessions")
    .withIndex("userId", q => q.eq("userId", userId)).first();
  if (session) {
    const tokens = await ctx.db.query("authRefreshTokens")
      .withIndex("sessionId", q => q.eq("sessionId", session._id)).take(BATCH_SIZE);
    for (const row of tokens) await ctx.db.delete(row._id);
    if (!tokens.length) await ctx.db.delete(session._id);
    await again();
    return;
  }
  await resetUserRateLimits(ctx, userId);
  // authVerifiers are OAuth-only, never created by this password-only app.
  await ctx.db.delete(userId);
}

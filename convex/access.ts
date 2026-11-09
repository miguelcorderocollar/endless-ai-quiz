import { SIGN_IN_REQUIRED } from "../src/lib/answers/errors";
import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

import type { MutationCtx, QueryCtx } from "./_generated/server";

/** Lowercased admin emails from the backend env. Empty = no admins. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return adminEmails().includes(email.toLowerCase());
}

/** The calling auth user id, or null when unauthenticated (guest). */
export async function authUserId(ctx: QueryCtx | MutationCtx) {
  return getAuthUserId(ctx);
}

/** Throws unless the caller is signed in. Returns the user id. */
export async function requireUser(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError(SIGN_IN_REQUIRED);
  const user = await ctx.db.get(userId);
  if (!user || user.isAnonymous) throw new ConvexError(SIGN_IN_REQUIRED);
  return userId;
}

/**
 * Throws unless the caller is signed in with role "admin". This is the gate
 * proven in #2 — admin powers themselves land with the roles issue (#30).
 */
export async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const userId = await requireUser(ctx);
  const user = await ctx.db.get(userId);
  if (user?.role !== "admin") throw new ConvexError("Admin only.");
  return userId;
}

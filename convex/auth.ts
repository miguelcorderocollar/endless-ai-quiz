import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth, type ConvexAuthConfig } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { z } from "zod";

import type { DataModel } from "./_generated/dataModel";
import { isAdminEmail } from "./access";
import { rateLimiter } from "./rateLimits";

const EmailSchema = z.object({ email: z.string().trim().toLowerCase().email() });

/**
 * Password-first auth (issue #2). No email infra in v1: signup/signin work
 * with email + password only. Password reset and email verification need
 * Resend + a sending domain — both deferred until magic links land.
 *
 * Role is assigned here, server-side, from ADMIN_EMAILS. Never accept `role`
 * from client params.
 */
const PasswordWithRole = Password<DataModel>({
  profile(params) {
    const parsed = EmailSchema.safeParse(params);
    if (!parsed.success) throw new ConvexError("Enter a valid email address.");
    const email = parsed.data.email;
    return {
      email,
      role: isAdminEmail(email) ? ("admin" as const) : ("user" as const),
      tier: "free" as const,
      createdAt: Date.now(),
    };
  },
  validatePasswordRequirements(password: string) {
    if (password.length < 8) throw new ConvexError("Password needs 8+ characters.");
  },
});

export const authCallbacks: NonNullable<ConvexAuthConfig["callbacks"]> = {
  async beforeSessionCreation(ctx, { userId }) {
    const user = await ctx.db.get(userId);
    if (!user || user.deletionStartedAt !== undefined) {
      throw new ConvexError("Account unavailable or being deleted.");
    }
  },
  async afterUserCreatedOrUpdated(ctx, { existingUserId }) {
    if (existingUserId !== null) return;
    // This callback and account creation share a transaction. A refusal rolls
    // back the user, account and quota consumption together.
    await rateLimiter.limit(ctx, "signUpGlobal", { throws: true });
  },
};

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [PasswordWithRole],
  callbacks: authCallbacks,
});

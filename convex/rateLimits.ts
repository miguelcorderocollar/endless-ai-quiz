import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import type { ComponentApi } from "@convex-dev/rate-limiter/_generated/component.js";
import { componentsGeneric } from "convex/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { OUTBOX_CAP } from "../src/lib/answers/outboxCore";

// Typed component reference until deployment codegen refreshes _generated/api.
// No deployment is needed to compile or exercise this component in convex-test.
const rateLimiterComponent = componentsGeneric().rateLimiter as unknown as ComponentApi;
export const rateLimiter = new RateLimiter(rateLimiterComponent, {
  signUpGlobal: { kind: "token bucket", rate: 100, period: HOUR, capacity: 100 },
  answer: { kind: "token bucket", rate: 60, period: MINUTE, capacity: OUTBOX_CAP },
  displayName: { kind: "token bucket", rate: 5, period: MINUTE, capacity: 5 },
});

/** #81 should await this inside the account-deletion mutation. No email keys. */
export async function resetUserRateLimits(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  await rateLimiter.reset(ctx, "answer", { key: userId });
  await rateLimiter.reset(ctx, "displayName", { key: userId });
}

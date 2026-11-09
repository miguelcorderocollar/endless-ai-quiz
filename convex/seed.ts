import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { beginUserDeletion } from "./lib/deleteUser";

/** Seed maintenance uses the same bounded cascade as account deletion. */
export const cleanupSeed = internalMutation({
  args: {
    domain: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  returns: v.object({ users: v.number(), events: v.number(), stats: v.number(), authRows: v.number() }),
  handler: async (ctx, args) => {
    const domain = args.domain ?? "@seed.endless-ai.test";
    const page = await ctx.db.query("users").paginate({
      cursor: args.cursor ?? null, numItems: 100,
    });
    let users = 0;
    for (const user of page.page) {
      if (!user.email?.endsWith(domain)) continue;
      await beginUserDeletion(ctx, user._id);
      users++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.seed.cleanupSeed, {
        domain, cursor: page.continueCursor,
      });
    }
    // Preserve the old return shape. Counts describe this scheduling page;
    // child deletion is asynchronous, so child counts are no longer totals.
    return { users, events: 0, stats: 0, authRows: 0 };
  },
});

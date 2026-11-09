# Backend hardening (#59)

Guest claims preserve up to 1000 answered questions and clamp correct counts to
0..answered. Fractional counts are floored; nonfinite counts become zero. The
rating is always `STARTING_ELO`, 1000. An `imported` category bucket keeps the
count breakdown consistent without inventing per-category history. Claims set
`seeded: true`, `serverAnswered: 0`, and return `seeded: true` so installed clients
keep their local progress and completed list. Existing server history is never
overwritten. Existing arguments remain accepted.

`Anonymous` is no longer a configured auth provider. The shared write guard also
rejects legacy anonymous sessions with the exact shared `SIGN_IN_REQUIRED`
message. Their rows remain stored; account deletion belongs to #81.

The rate-limiter component is mounted as `rateLimiter`. Token buckets allow:

- 60 new answer events per minute per user, with capacity `OUTBOX_CAP`, 1000.
  A full offline queue fits in a fresh bucket, including on installed clients
  whose old error classifier drops quota errors. Exact event-ID replays and
  legacy five-second retries return before consuming quota. A depleted bucket
  can still throttle a replay, so the larger burst reduces old-client exposure
  rather than guaranteeing unlimited repeated replays.
- 5 display-name changes per minute per user, with a burst of 5.
- 100 successful account creations per hour globally. This global bucket is the
  signup abuse control; no per-email keys or email hashes are stored. Refusals
  roll back account creation. Existing-account sign-in does not consume quota.
  An attacker can exhaust the global bucket. Email remains unverified.

Current web and native outboxes retain structured `RateLimited` errors and
publish a retry deadline from `error.data.retryAfter`. Mounted, online,
authenticated flushers subscribe to those deadlines and drain automatically
without a new answer. Timer cleanup runs on unmount, sign-out, offline transition,
or queue clearing. The deadline is held in memory; restarting resumes the normal
initial drain. `watchOutboxRetries` is shared and exercised with both storage
adapters. Successful scheduled drains use the existing rating reconciliation.

`resetUserRateLimits(ctx, userId)` in `convex/rateLimits.ts` resets the user's
answer and display-name keys. #81 should await it inside the account-deletion
mutation before deleting the user. It deliberately leaves the global signup
bucket intact. No deletion endpoint is added here.

Population statistics use optional `userStats.serverAnswered` and its index.
Only rows with at least 20 server-recorded answers qualify. Guest claims start
at zero. On the next answer, old event-derived rollups initialize the field from
their existing answer count. Old seeded rollups initialize at one and reset
their untrusted rating baseline to `STARTING_ELO` before scoring that answer.
This happens transactionally with the answer and only once. No migration needs
to be run. Rebuilding missing rollups initializes the field from their events.
Inactive legacy rows stay outside the cohort until initialized.

Median, histogram and percentile use the same cohort. Ineligible callers get no
percentile. The existing 5000-row cap selects the most active eligible accounts
and returns `capped: true` when truncated. These controls raise Sybil costs but
do not prove unique humans or prevent repeated-question farming. Answer
visibility and server-side grading belong to #58.

Names use NFKC normalization, remove all Unicode format characters, collapse
whitespace and truncate to 40 Unicode code points. Only exact generated handle
patterns are reserved, optionally prefixed by `@`. Names such as `Player One`
remain valid. Existing names are not rewritten. Signup and rename interfaces
show friendly quota-error copy. Public-name moderation remains outside scope.

All new stored fields are optional. No existing args were removed. Local tests
register the real component with convex-test; no deployment is needed. The
component reference uses the package's generated `ComponentApi` locally because
this task prohibits deployment codegen. Normal deployment codegen populates
`_generated/api` with the mounted component.

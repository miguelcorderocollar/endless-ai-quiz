# Backend hardening (#59)

Guest progress claims keep the existing argument shape for installed clients,
but initialize an empty rollup at `STARTING_ELO`. No client totals are imported.
The empty category breakdown therefore agrees with `answered: 0`. The response
uses `seeded: false` so existing clients reconcile to the server rollup. Existing
server history is never overwritten.

`Anonymous` is no longer a configured auth provider. The shared write guard also
rejects legacy anonymous sessions. Their rows remain stored; account deletion
belongs to #63.

The rate-limiter component is mounted as `rateLimiter`. Token buckets allow:

- 60 new answer events per minute per user, with a burst of 60. Exact event-ID
  replays and legacy five-second retries return before consuming quota.
- 5 display-name changes per minute per user, with a burst of 5.
- 1 successful account creation per hour per normalized email, plus a global
  budget of 100 per hour. Refusals roll back the account creation transaction.
  Existing-account sign-in does not consume this budget.

These are application limits, not network-level abuse protection. Email is
unverified, and the global signup bucket can be exhausted by an attacker.

Population statistics use the optional `userStats.serverAnswered` field and its
index. Only rows with at least 20 server-recorded answers qualify. Guest claims
start at zero. On the next answer, an old event-derived rollup initializes this
field from its existing answer count; an old seeded rollup starts at one because
its imported and recorded counts cannot be separated safely. Rebuilding a
missing rollup from events initializes the field from those events.

There is no bulk migration. Legacy rows stay out of population statistics until
the next answer initializes eligibility. Median, histogram and percentile use
the same eligible cohort, and ineligible callers receive no percentile. The
existing 5000-row cap remains, now selecting the most active eligible accounts
and returning `capped: true` when truncated. This raises the cost of Sybil
accounts but does not prove unique humans or prevent repeated-question farming.
Server-side grading and answer visibility belong to #58.

Names use NFKC normalization, remove bidi controls, collapse whitespace, and
retain the existing 40-character limit. Names beginning with `@` or the
`player-` handle namespace, including space/underscore variants, are reserved.
Existing stored names are not rewritten; names remain private and public-name
moderation remains a prerequisite for public social features.

All new stored fields are optional and existing function arguments remain
accepted. Local tests register the real rate-limiter component through
`convex-test`. No live deployment is needed. The component reference is typed
locally with the package's generated `ComponentApi`, since deployment codegen
cannot run under this task's no-deployment constraint. Normal deployment codegen
will populate `_generated/api` with the mounted component.

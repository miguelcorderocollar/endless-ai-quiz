# Account deletion and privacy

Issue #63 adds `users.deleteAccount`, authenticated by the caller's identity.
The initial request requires an existing, unexpired session created within five
minutes. Refreshing a token keeps the session's creation time, so it does not
count as a new sign-in. An old session must sign out and sign in again. Retrying
an accepted deletion is a successful no-op so a lost response does not prevent
local cleanup.

Deletion first sets optional `users.deletionStartedAt`. `requireUser` rejects
writes for marked or missing users, including old clients with a still-valid
JWT. The auth session-creation callback prevents new sessions for marked users.
Scheduled internal mutations remove at most 100 child rows per transaction.
The shared cascade removes answers, stats, auth verification codes and account
rate limits, auth accounts, refresh tokens, sessions, then the user. Each parent
stays until its children are gone. `cleanupSeed` uses the same cascade and
schedules subsequent user pages. Its existing return keys remain, but child
counts are zero because deletion now happens asynchronously, and `users` counts
only the current scheduling page.

The password/anonymous configuration does not create OAuth `authVerifiers`.
Adding OAuth must extend the cascade with a session index and verifier deletion.
Scheduled function metadata can temporarily contain the opaque user ID. Backups
and platform logs are outside this cascade; the notice does not promise their
immediate removal.

The web profile has a separate deletion confirmation next to reset. After the
request succeeds, it signs out, calls `clearLocalAccountState({ reason: "deletion",
account: null })` from `src/lib/accountState.ts` (drops every queued answer,
cached questions and profile, progress, the guest snapshot), and performs a full
navigation to discard memory and pending query state. Other tabs/devices can retain local copies, as the notice
explains. Native screens are not changed in this web issue.

## Recovery and verification decision

Keep password reset and email verification deferred. Implementing them needs a
mail provider, a sending domain and a recovery flow, which this issue does not
configure. The sign-in form and privacy notice now explicitly warn that a
forgotten password means the account cannot be recovered or deleted through
self-service. Email addresses are not verified ownership claims. A future mail
integration must implement both flows and extend tests before changing that copy.
The notice offers the project contact for deletion help without asking people
to post account details publicly. The maintainer still needs an ownership-check
process for such requests before a public launch.

## Compatibility and validation

The only schema addition is optional. Existing function args remain accepted;
no question content or published data is changed. Existing clients can still
play and write for active users. Pending/deleted accounts are rejected at the
shared write gate. No deployment command is needed or authorized for validation.

`convex/deletion.test.ts` drives real functions through convex-test, including
multiple answer/token batches, seed pagination, authentication freshness,
repeat requests, old-token write rejection and preservation of another user.
The local cleanup test checks unknown app keys and unrelated storage. The
browser privacy test runs with Convex blocked, like the existing suite.

# Endless AI

Prototype of an endless AI quiz. Start here before changing code or questions.

## Commands

- `npm run dev` starts the app.
- `npm run validate` checks every question for schema, answer integrity, distractor shape, balance, and source grounding.
- `npm run validate:offline` skips live Wikipedia and URL checks.
- `npm run typecheck` runs TypeScript.
- `npm run lint` runs ESLint.
- `npm run test` runs the unit tests (vitest).
- `npm run test:e2e` runs the browser tests (Playwright). It builds the app and starts it on port 3210, so it needs no dev server running.
- `npm run test:all` runs both suites.
- `npm run build` builds the Next.js production app.
- `npm run verify` runs validate, typecheck, lint, unit tests, build, and the browser suite.
- `npm run rebalance` reports answer-slot balance; add `--write` only after reviewing the diff.
- `npm run bundle:bank` regenerates `apps/mobile/assets/bank.json`, the bank baked into the APK. `npm run validate` fails when it drifts from `content/questions`, so a question change that does not reach the phone app fails the gate.
- `npm run assets:grain` regenerates `apps/mobile/assets/images/grain.png`, the film grain baked into the APK. Rarely needed; it only changes if the noise parameters in `scripts/lib/grain.mts` do. The same script used to emit the blob sprite for the `AmbientBackground` backdrop; that is gone from both apps, see `docs/native-parity.md`.
- `npm run dupe` finds near-duplicate questions (embeddings + Jev, issue #38). Needs `OPENROUTER_API_KEY` in `.env`. Costs ~$0.005 for the current bank and re-runs are free from the verdict cache. Writes `data/dupe/report.md`. Local only, never in CI.
- `npm run dupe:refresh` re-adjudicates every pair, ignoring the cache. Use after changing the definition or the pinned model.
- `npm run dupe:score` scores the reporting threshold against the hand-labelled pairs in `data/dupe/labelled.json`.
- `npm run dupe -- --offline` runs the embedding shortlist only, no network.
- `npm run probe -- "Title" ...` inspects Wikipedia lead sections before authoring.
- `npm run review` builds `review/review.html`, a self-contained page for human review of draft questions (search, filter, per-ID verdicts). It also shows a `near-duplicate` flag when `npm run dupe` has run, read from `data/dupe/pairs.json`. It stays offline and keyless: the flags are whatever dupe already decided, never a fresh model call.
- `npm run review:serve` builds it and serves it at `http://localhost:8901/review.html`.
- `npx convex dev` syncs the backend to your dev deployment (watch mode); `npm run dev` is the frontend.
- `npx tsx scripts/publish.mts` syncs the validated bank to dev (`--prod` for prod).
- `npm start` inside `apps/mobile` runs the Expo app (issue #18). Copy `apps/mobile/.env.example` to `.env` and set `EXPO_PUBLIC_CONVEX_URL` first. It needs no Android SDK: Expo Go runs the JS and EAS Build compiles in the cloud.
- `npm run typecheck` inside `apps/mobile` checks the native app. The root `typecheck` skips it, and the root `test` picks up only its pure helpers.

## The native app (apps/mobile)

An Expo / React Native build of the same quiz, for issue #18. Read
`apps/mobile/README.md` before changing it. Two rules keep it honest:

- **The quiz logic is imported, never copied.** `src/lib/quiz/*`,
  `src/lib/questions/*` and `src/lib/answers/outboxCore.ts` are reached through
  the `@shared/*` alias, which is declared in both `apps/mobile/tsconfig.json` and
  `metro.config.js`. If you add a file under one of those, the native app can
  import it — do not fork it into `apps/mobile`. Storage is the only thing
  reimplemented, because localStorage and AsyncStorage are different stores. The
  replay rules are shared rather than ported on purpose: `outboxCore.ts` owns
  ordering, the cap, stop-at-first-failure and per-account attribution, and the
  two adapters only decide where the list lives.
- **A release build bakes in its Convex URL.** `EXPO_PUBLIC_*` is inlined by
  Metro, so there is no runtime override: an APK pointed at the dev deployment
  is a public app reading disposable dev data. See `docs/deployment.md`.

`docs/native-parity.md` is the gap list between the two apps, and it is current
as of the parity pass. What is left: no automated UI coverage for the native
screens, no Android app shortcuts, and the distribution chart waiting on a real
population. Do not treat a passing native build as #18 being done.

The two generated native assets are committed and checked, not built per build:
`npm run bundle:bank` for the offline bank (and `npm run validate` fails when it
drifts) and `npm run assets:grain` for the film grain.

## Before you commit

`npm run verify` is the gate: validate, typecheck, lint, unit tests, build, then
the browser suite. Run it whole rather than the parts you remember, so nothing
lands on `main` untested. A push to `main` deploys to production, so this is the
only check between the two.

First time on a machine, and after Playwright upgrades:

```bash
npx playwright install chromium   # browsers are not in the repo
```

Keep the browser suite worth running:

- Specs assert the shipped UI, so a change to markup is a change to the spec.
  The suite builds a production app itself and needs no dev server.
- Specs must never depend on dev or prod Convex, or on `content/questions`.
  They seed a local draw cache and cut the network on purpose, so the degraded
  path is what runs on every pass. If a spec starts passing for the wrong
  reason — for instance the real deployment answers a query — fix the fixture,
  not the assertion.
- `manifest.shortcuts` and the worker's `ROUTES` must agree; the PWA spec fails
  if they drift, because a shortcut to an un-cached route 404s offline.
- Bump `VERSION` in `public/sw.js` when the shell changes shape.

## Deployment

- Read `docs/deployment.md` before touching Convex, Vercel env vars, or the build command.
- Name the deployment before acting on it. Dev is `careful-salmon-552`, production is
  `moonlit-blackbird-812`, and `--prod` resolves from your CLI login rather than
  `.env.local`. Both answer, so say which one you mean.
- A push to `main` ships the whole `convex/` directory to production, so a staged change
  in any function file rides along with the one you meant to push.
- `content/questions/*.json` is the source of truth; Convex holds the published questions (one doc per questionId).
- Never commit `.env.local` (`CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`) or any deploy key.

## Content rules

- Curated questions live in `content/questions/*.json`.
- IDs are stable and use three-letter prefixes, for example `hst-0042`.
- `category` must use the exact schema key, for example `technology`, not `tech`.
- `answer` must match exactly one option.
- Every question needs an explanation.
- Length caps (#49), enforced by `npm run validate` as errors: question text
  200 characters, each option 80, explanation 500. They keep one question on
  one phone screen with all four options visible. `LENGTH_CAPS` in
  `src/lib/questions/schema.ts` is the single place they live.
- Prefer Wikipedia or primary sources. Use `"kind": "none"` only when no source exists, and make the explanation carry the teaching.
- Do not ship generated questions without `npm run validate` and a human read.
- `npm run validate` cannot see a reworded or cross-category repeat. Run
  `npm run dupe` before shipping a batch, then decide each pair it flags. Jev is
  calibrated, not correct, and a decision does not have to be human: the pairs are
  unambiguous once read side by side, so an agent can adjudicate and record the
  outcome. Two traps, both seen in this bank: a shared answer is not a shared fact,
  and a different fact in near-identical wording still reads as one question.
  Record every decision in `data/dupe/labelled.json` so `npm run dupe:score`
  keeps measuring the threshold honestly.
- **Deleting a question does not remove it from play.** Editing git is not a
  deploy. The pruned id stays `published` in Convex until you run
  `npx tsx scripts/publish.mts`, which is what calls `questions:prune`. Always
  run the publish step after a deletion, and confirm the row is `archived` before
  assuming the deletion shipped.

## Removing a duplicate

No Convex change is needed. Delete the question from
`content/questions/*.json`, then run `npx tsx scripts/publish.mts` (`--prod` for
prod). That step does two things: `questions:sync` upserts the current bank, then
`questions:prune` archives every published row whose id is no longer in it. Every
read path filters on `status === "published"`, so an archived row leaves the
playable set immediately. Ids are never reused, so the pruned id stays retired.

Pruning is a status change, not a delete. The row and its answer history stay in
the table, which is what you want if answers were recorded against that id.

To actually remove them, `npx convex run questions:purgeArchived '{"ids":[...]}'
` deletes only rows that are *already* archived, so it takes two publishes to
remove anything and a live question cannot be destroyed by one mistake. Verify
with `npx convex data questions --deployment dev --limit 400` that a row reads
`archived` before purging it.

Prefer rewording over deleting when one side carries more value (a better hook, a
harder difficulty, a category that needs the coverage). Delete when the two are
genuinely interchangeable. Of seven duplicates fixed in #38, three were deleted and
four reworded, so check both options before removing an id.

## Code rules

- Keep the quiz loop simple: no timer, immediate feedback, Learn when a source exists.
- Elo updates belong in shared quiz code so the UI and backend can reuse them.
- Prototype progress is local only. Do not present it as an account, leaderboard, or shared result.

## The installed app (PWA)

The app installs to the home screen from the browser and works offline. There is
no native wrapper and no app-store build. Two rules keep it honest:

- **`public/sw.js` caches the shell and nothing else.** Documents are
  network-first, `/_next/static` is cache-first, and Convex, auth and RSC
  payloads are never touched. A cached question set is a bug, not a feature.
- **Bump `VERSION` in `public/sw.js` when the shell changes shape.** It is
  served from `public/`, so Next never fingerprints it and a deploy will not
  retire the old caches on its own. Anything added to `ROUTES` (which the
  manifest shortcuts point at) has to be reachable offline.

The install banner waits for ten answered questions and remembers a refusal.
The profile always keeps a way in. `src/lib/pwa/install.ts` holds the platform
branches and is unit-tested; `e2e/pwa.spec.ts` covers the wiring. Both e2e and
the offline quiz run against a seeded local draw cache with Convex cut off, so
they exercise the degraded path on every run instead of only when the network
happens to be gone.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

# Endless AI Quiz

An endless AI trivia quiz — four options, no timer, keep going until you quit. A homage to [Endless Quiz](https://apps.apple.com/us/app/endless-quiz/id1251898178) by Christopher Masser, with AI as the subject.

Live: **https://endless-ai-quiz.vercel.app**

## The loop

- Stream of questions that never ends and never repeats.
- Tap an answer, get immediate feedback, hit **Learn** to read the verified source.
- **Elo** (headline + per-category) tracks whether you're actually improving.
- Modes: **Endless** (default) and a **Weekly challenge** (15 fixed questions, resets Mondays).

## Stack

- Web: **Next.js + Convex**, installable **PWA** that works offline (shell cached, questions never cached).
- Native: **Expo / React Native** build in `apps/mobile` — same bank, Elo and draw via shared imports, AsyncStorage instead of localStorage. See `apps/mobile/README.md`.
- Bank: curated JSON in `content/questions/*.json` (source of truth), 14 categories, every question carries a verified source or teaches through its explanation.

## Develop

```bash
npm install
npx convex dev      # backend watch mode (needs `npx convex login` once)
npm run dev         # frontend, in another terminal
```

Content and quality gates:

```bash
npm run validate          # schema, answer integrity, balance, source grounding
npm run validate:offline  # skips live Wikipedia / URL checks
npm run dupe -- --offline # near-duplicate shortlist (needs OPENROUTER_API_KEY for verdicts)
npx tsx scripts/publish.mts          # sync bank to Convex dev (--prod for prod)
npm run verify            # full gate: validate, typecheck, lint, tests, build, browser suite
```

## Docs

- `AGENTS.md` — commands, content rules, deployment safety.
- `docs/architecture.md` — the architecture decision and why: guest-only web, ranked Expo app, free-tier budget.
- `docs/deployment.md` — Convex dev vs prod, publish pipeline.
- `docs/dataset.md` — question sourcing and grounding rules.
- `docs/native-parity.md` — web/native gap list.

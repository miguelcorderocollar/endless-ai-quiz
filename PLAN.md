# Endless AI

An endless general-knowledge quiz, but the topic is AI. Four options, no timer, keep
going until you quit, see where you land on the leaderboard.

This is a direct homage to [Endless Quiz](https://apps.apple.com/us/app/endless-quiz/id1251898178)
by Christopher Masser. Same loop, same simplicity, same Learn button, different subject
matter.

## Trust model, decided for #58

Endless and category runs are casual practice. Their Elo, answer history and
population statistics are untrusted learning progress, including signed-in
progress. They must never seed a leaderboard, weekly result or match score.
The public PWA bank and the native APK contain answers so offline play can
keep immediate feedback. No client-side concealment can make that bank secret.

New web draws use `questions.drawForPlay`, which returns only question text,
options and selection metadata. `answers.reveal` validates a submitted option
and returns the verdict, answer, explanation and source. The web waits for this
round-trip before showing feedback. Cached full questions and offline fallback
remain local practice. After reveal, signed-in picks still travel through
`answers.answer` via the ordered outbox, with its existing eventId dedupe.
Reveal itself awards no rating and is available to guests.

`questions.list` is admin-gated. Its empty-array response for other callers
keeps old installed profile clients from throwing. CLI publishing uses the
internal `questions.publishedList`. New web profiles read the public practice
bank, so their bank view follows the app build rather than live publication.
Native profiles already fall back to their bundled bank when the list is empty.

Before #8, #9, #13 or competitive #41 stats can ship, they need a separate,
server-held question pool that is never in the public bank, legacy draw, APK,
profile or offline cache. The server must issue an authenticated attempt,
commit its first pick once, grade it, and keep competitive scores separate
from casual Elo and imported/offline progress. The casual reveal endpoint is
not an attempt protocol and must not award competitive scores.

Staged cleanup: migrate the native quiz to server reveal, allow installed PWAs
to update, then remove the legacy `questions.draw` answer-bearing path and
`questions.list` shim in a later release. No schema or existing mutation args
change in this stage. Until that cleanup, legacy clients intentionally retain
the existing casual experience. This decision is in place before competitive
work starts; server reveal alone does not make published practice content secure.

## What we are copying, and why

Endless Quiz works because it is three screens and it never nags you. That is the whole
product. The things people love about it, in rough order of how often they come up:

- A stream of questions that never ends and never repeats
- The Learn button, which turns a wrong answer into something you now know
- Elo, so you can see whether you are getting better in a way a raw score cannot show
- A weekly challenge where everyone gets the identical 15 questions
- Question sheets, so you can go back and study what you missed

We keep all of it. The subject changes and the questions get harder, because AI has more
deeper material than general knowledge trivia does.

## What we are adding

AI is a fast-moving field and the subject opens up a few things the original does not need.

**The Learn button has a source on every question.** The hardest part of this project is
not the app, it is the question bank, and most of that difficulty comes down to one
question: how do we know a question is true and where do we send someone who wants to
learn more? See [docs/dataset.md](docs/dataset.md). Every question carries a source we
have verified. Where Wikipedia has an article, we link it. Where it does not, and the
answer is a paper, a model card or a lab post, we link the primary source instead. A small
number of questions have no good source, and for those the button hides and the written
explanation does the work.

**Fourteen categories instead of eight.** History, people, labs, models, tech, hardware,
papers, benchmarks, memes, ethics, business, products, open source, and concepts. This is
the main thing that separates us from a generic AI trivia app. Somebody who follows model
labs obsessively and somebody who reads the papers should both find a corner that suits
them, and the profile should make it obvious which corner that is.

**Per-category Elo.** One headline number, but a breakdown underneath. It creates a reason
to keep playing categories you are bad at, which is where the retention lives.

## The game

No timer, ever. The original is a knowledge test, not a reaction test, and adding a clock
would change what the game measures. You tap an answer, you immediately see whether it was
right, the Learn button is always there, and then you move on.

A run ends when you stop playing it. Nothing times you out, nothing counts down. The score
you post is however many questions you felt like doing.

### Modes

| Mode | What it is |
| --- | --- |
| Endless | The default. Questions until you quit. |
| Weekly challenge | 15 fixed questions, everyone gets the same ones, results reset every Monday. The main viral event. |
| Category run | Pick one to five categories and stay inside them. |
| Match | Send a friend a link, they play the same 20, you both see the result afterwards. |
| Question sheet | Not a mode, a feature. Every question you got wrong, with a link, ready to study. |

Mr. X is parked for later. The idea is a rare hidden encounter in the endless stream, but
it needs its own design pass and it is not worth building before the game is proven.

### Scoring and Elo

A run is worth a score, but the score is not the real number. The real number is Elo, and
it updates after every question rather than at the end of a run, so it moves while you
play.

Each question has a difficulty rating. An easy question is worth 800, a hard one 1600.
Your expected score is ordinary Elo math against that rating:

```
E     = 1 / (1 + 10 ^ ((questionRating - playerRating) / 400))
delta = 24 * (result - E)
```

The effect is the part that matters. At a 1000 rating, answering a difficulty 1 question
correctly gains you about 6 points and getting it wrong costs 18. A difficulty 5 question
correctly gains 23 and getting it wrong costs less than a point. So the rating measures
how much you actually know rather than how many questions you grind through the easy
ones, and a lucky streak of easy answers moves you almost nowhere.

Floored at 0. We will retune the K-factor once there is real data.

Ratings also split by category, so the profile can say you are in the top 5% for hardware
and the bottom third for memes. That gap is the most effective nudge we have.

### Levels

Elo maps to named tiers. They should be a little funny and not try too hard.

| Elo | Tier |
| --- | --- |
| 0 to 999 | Curious |
| 1000 to 1199 | Prompt |
| 1200 to 1399 | Fine-Tuner |
| 1400 to 1599 | Aligned |
| 1600 to 1799 | Reasoner |
| 1800 and up | Post-Singularity |

### Streaks

Daily streak with one grace token. Losing a 40 day streak because of a server hiccup or a
timezone bug is the fastest way to make someone never open the app again.

## Going viral

The share card is the product, not a feature. This is how the original grew and it is the
single highest-leverage thing we build.

Every finished run produces an image: score, accuracy, new Elo, tier, streak, and a link
to your profile. It renders server side and the link unfurls properly on X, LinkedIn and
iMessage. The link goes to a public, indexable profile page.

A profile is a real page with your handle, your tier, your streak, per-category bars, your
badges, your recent runs, and a button that sends a visitor a fresh run in your best and
worst categories. It should be worth looking at, because it is the thing people share.

The weekly challenge is the hook that brings people back on a schedule. Identical
questions for everyone means the result is genuinely comparable, which means the share card
means something.

Badges for the usual milestones: first hundred correct, a perfect run, every category
covered, a thirty day streak, beating a friend. They are cheap to add and they give people
a reason to open the profile page.

Leaderboard visibility is opt-in, with a generated default handle and no email exposed
anywhere. The original's reviews asked for exactly this, so let us not repeat the mistake.

## Architecture

Next.js with the App Router, TypeScript, Tailwind, and Convex on the backend. Convex gives
us reactive queries, which is what a live leaderboard and a match result both want, and
its server functions are the right place to run Elo updates where the client cannot forge
them.

The question bank is the one part that is not in the database during authoring. Curated
questions live as JSON in `content/questions/`, one file per category, versioned in git
and reviewed in pull requests. Every question gets a commit, a review and a rollback.
Publishing runs the validator and then syncs the published questions into Convex
(upsert per stable question id); the client plays from that table.

Community submissions, once we open them, go to a separate Convex table with a moderation
status. They never mix into the curated bank until somebody has reviewed them.

A PWA from day one. The original's reviews mention offline play more than once, and a
service worker gets us installable and offline for very little, while also being a step
toward the native app.

## Roadmap

**M1, now.** The schema, the validator, the first 100 questions reviewed by hand, the
endless loop, the Learn button, and local progress with no accounts. This is the milestone
that tells us whether the game is any fun.

**M2.** Convex, auth, the publish pipeline, Elo, streaks, the result screen.

**M3.** Profiles, share cards, leaderboard, weekly challenge.

**M4.** Matches, badges, question sheet, Spanish.

**M5.** The native shell, then community submissions and moderation.

**M6.** Mr. X.

## Open questions

- The domain name. Everything in share links depends on it.
- Whether per-category Elo is too much, or exactly right. Cheap to remove.
- Whether the weekly challenge should be 15 questions. Endless Quiz uses 15 and it works.
- Whether we open submissions before or after Mr. X. Probably before, since content
  volume is the long-term constraint.

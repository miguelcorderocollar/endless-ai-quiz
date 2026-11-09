"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Ref } from "react";

import {
  type SavedProgress,
  RECENT_CAP,
  getProgressServerSnapshot,
  getProgressSnapshot,
  hydrateProgress,
  readProgress,
  subscribeProgress,
  updateProgress,
} from "@/lib/progress";
import { pickNext } from "@/lib/quiz/engine";
import { scoreAnswer } from "@/lib/quiz/elo";
import { sourceHref, sourceLabel } from "@/lib/questions/schema";
import type { Question } from "@/lib/questions/schema";
import { useConvexAuth, useMutation } from "convex/react";

import { api } from "../../convex/_generated/api";
import { InstallBanner } from "./InstallPrompt";
import { SyncStatus } from "./SyncStatus";
import { UpdatePrompt } from "./UpdatePrompt";
import {
  drainOutbox,
  enqueueAnswer,
  newEventId,
  shouldReconcile,
} from "@/lib/answers/outbox";
import { resolvePick } from "@/lib/questions/resolvePick";
import { loadFallbackBank } from "@/lib/questions/fallback";
import { getNetworkSnapshot, subscribeNetwork } from "@/lib/pwa/network";
import { readProfileCache } from "@/lib/quiz/bankCache";
import { quizSession, type QuizSession } from "@/lib/quiz/session";

type Phase = "question" | "revealed";

const LETTERS = ["A", "B", "C", "D"] as const;

/**
 * Live session: keeps the current question across client-side navigation
 * (profile → main) so returning doesn't swap it. Module-level survives App
 * Router navigations but resets on full reload: refresh may draw anew,
 * back-navigation must not. Keyed by filter so picking new categories still
 * starts fresh.
 */
export function Quiz({
  bank,
  initial,
  onNeedMore,
  categories,
}: {
  bank: Question[];
  initial: Question;
  onNeedMore: (seen: Set<string>) => Promise<Question[]>;
  /** Fun-mode filter (#12): stream stays inside these, Elo untouched. */
  categories: Set<Question["category"]>;
}) {
  const progress = useSyncExternalStore(
    subscribeProgress,
    getProgressSnapshot,
    getProgressServerSnapshot,
  );
  // Restored when returning via client-side navigation with the same filter
  // and the retained question still in the bank. Null on first visit, reload,
  // or filter change — then `initial` wins as before.
  const filterKey = [...categories].sort().join(",");
  const session = quizSession.current;
  let restoredQuestion: Question | null = null;
  let restoredSession: QuizSession | null = null;
  if (session !== null && session.filterKey === filterKey) {
    const found = bank.find((q) => q.id === session.currentId) ?? null;
    if (found !== null && (categories.size === 0 || categories.has(found.category))) {
      restoredQuestion = session.revealedQuestion?.id === found.id
        ? session.revealedQuestion : found;
      restoredSession = session;
    }
  }
  // A revealed screen without its pick is unresumable (it would mislabel the
  // verdict), so it restarts as unanswered rather than showing a wrong banner.
  const restoredPicked =
    restoredQuestion !== null &&
    restoredSession !== null &&
    restoredSession.picked !== null &&
    restoredQuestion.options.includes(restoredSession.picked)
      ? restoredSession.picked
      : null;
  const restoredPhase: Phase =
    restoredQuestion !== null &&
    restoredSession !== null &&
    restoredSession.phase === "revealed" &&
    restoredPicked !== null
      ? "revealed"
      : "question";
  const [phase, setPhase] = useState<Phase>(() => restoredPhase);
  const [current, setCurrent] = useState<Question | null>(() => restoredQuestion ?? initial);
  const [picked, setPicked] = useState<string | null>(() => restoredPicked);
  const [seen, setSeen] = useState<Set<string>>(
    () =>
      new Set([
        ...(restoredSession?.seenIds ?? [initial.id]),
        (restoredQuestion ?? initial).id,
      ]),
  );
  const [exhausted, setExhausted] = useState(() => restoredSession?.exhausted ?? false);
  const { isAuthenticated } = useConvexAuth();
  const reveal = useMutation(api.answers.reveal);
  const pending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const recordAnswer = useMutation(api.answers.answer);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    hydrateProgress();
  }, []);

  // Remember the live spot so client-side navigation back to `/` resumes it.
  useEffect(() => {
    quizSession.current = {
      filterKey,
      currentId: current?.id ?? initial.id,
      seenIds: [...seen],
      phase,
      picked,
      exhausted,
      revealedQuestion: phase === "revealed" && current ? current : undefined,
    };
  }, [filterKey, current, seen, phase, picked, exhausted, initial.id]);

  const nextQuestion = useCallback(() => {
    setAnswerError(null);
    const next = pickNext(bank, seen, categories, Math.random, progress.rating);
    if (!next) {
      // Current page exhausted: ask the server for more unseen questions.
      // Empty twice in a row means the bank is truly done. A failed top-up
      // means the same thing by another route: offline with a spent local
      // bank. Either way the run ends, rather than hanging on a question that
      // is never coming.
      void onNeedMore(seen).then(
        (fresh) => {
          const retry = pickNext([...bank, ...fresh], seen, categories, Math.random, progress.rating);
          if (!retry) {
            setExhausted(true);
            return;
          }
          setSeen((prev) => new Set(prev).add(retry.id));
          setCurrent(retry);
          setPicked(null);
          setPhase("question");
        },
        () => setExhausted(true),
      );
      return;
    }
    setSeen((prev) => new Set(prev).add(next.id));
    setCurrent(next);
    setPicked(null);
    setPhase("question");
  }, [bank, seen, onNeedMore, categories, progress.rating]);

  const answer = useCallback(
    async (option: string) => {
      if (phase !== "question" || !current || pending.current) return;
      pending.current = true;
      setSubmitting(true);
      setAnswerError(null);
      let question: Question;
      try {
        question = await resolvePick(
          current, option, getNetworkSnapshot().online, reveal, loadFallbackBank,
          (onOffline) => {
            const check = () => { if (!getNetworkSnapshot().online) onOffline(); };
            const unsubscribe = subscribeNetwork(check);
            check();
            return unsubscribe;
          },
        );
      } catch {
        setAnswerError("Could not check your answer. Try again or skip this question.");
        return;
      } finally {
        pending.current = false;
        setSubmitting(false);
      }
      const correct = option === question.answer;
      const progress = readProgress();
      setCurrent(question);
      const { rating: nextRating } = scoreAnswer(progress.rating, current.difficulty, correct);

      setPicked(option);
      setPhase("revealed");

      updateProgress({
        ...progress,
        rating: nextRating,
        answered: progress.answered + 1,
        correct: progress.correct + (correct ? 1 : 0),
        completed:
          correct && !progress.completed.includes(current.id)
            ? [...progress.completed, current.id]
            : progress.completed,
        recent: [
          ...progress.recent,
          { id: current.id, correct, at: Date.now() },
        ].slice(-RECENT_CAP),
        lastPlayed: new Date().toISOString().slice(0, 10),
      });

      // Server is truth for Elo and owns the event log. Optimistic local
      // update above keeps feedback instant; reconcile to the server rating
      // when it lands. Guests without a session stay local-only.
      //
      // Every signed-in answer travels through the outbox (#17), even the live
      // ones: a mutation that fails is indistinguishable from one whose
      // response was lost, and only the outbox's exact `eventId` dedupe tells
      // them apart on replay. The drain sends in record order and stops at the
      // first failure, so an offline answer parks instead of vanishing.
      if (isAuthenticated) {
        // The handle tags the event for per-account drain attribution (see
        // outbox.ts). Display names are editable and non-unique, so they are
        // not identity. A missing handle tags null, which drains under
        // whoever is signed in — the server attributes by auth identity.
        const account = readProfileCache()?.handle ?? null;
        enqueueAnswer({
          eventId: newEventId(),
          questionId: current.id,
          picked: option,
          account,
          at: Date.now(),
        });
        void drainOutbox(recordAnswer, account).then(
          ({ sent, lastRating, maxAt }) => {
            if (sent > 0 && lastRating !== null && shouldReconcile(account, maxAt)) {
              updateProgress({ ...readProgress(), rating: lastRating });
            }
          },
        );
      }
    },
    [current, phase, isAuthenticated, recordAnswer, reveal],
  );

  // Move focus to Next on reveal so Tab+Enter works; preventScroll avoids
  // yanking the viewport on long explanations.
  useEffect(() => {
    if (phase === "revealed") nextRef.current?.focus({ preventScroll: true });
  }, [phase, current]);

  // Keyboard-first play (#26): 1-4/A-D answer, arrows move between options,
  // Enter/Space/→ advance, ? opens Learn. Mouse flow untouched. Guards:
  // modifiers held, editable targets, and natively activatable focused
  // elements (their default activation already fires — handling them too
  // would double-advance).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (phase === "question" && current) {
        const digit = ["1", "2", "3", "4"].indexOf(event.key);
        const letter = ["a", "b", "c", "d"].indexOf(event.key.toLowerCase());
        const index = digit !== -1 ? digit : letter;
        if (index !== -1 && index < current.options.length) {
          event.preventDefault();
          answer(current.options[index]!);
          return;
        }
        // Arrow navigation between options; focus + Enter/Space answers via
        // native button activation. Wraps around; starts at an end when
        // focus is elsewhere.
        const dir =
          event.key === "ArrowDown" || event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowUp" || event.key === "ArrowLeft"
              ? -1
              : 0;
        if (dir !== 0) {
          const buttons = optionRefs.current.filter(
            (el): el is HTMLButtonElement => el !== null,
          );
          if (buttons.length > 0) {
            event.preventDefault();
            const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              focused === -1
                ? dir > 0
                  ? 0
                  : buttons.length - 1
                : (focused + dir + buttons.length) % buttons.length;
            buttons[next]!.focus({ preventScroll: true });
          }
        }
        return;
      }
      if (phase === "revealed" && current) {
        if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") {
          if (target && (target.tagName === "BUTTON" || target.tagName === "A")) return;
          event.preventDefault();
          nextQuestion();
          return;
        }
        // ? opens the Learn source when the question has one.
        if (event.key === "?") {
          const href = sourceHref(current.source);
          if (href) {
            event.preventDefault();
            window.open(href, "_blank", "noopener,noreferrer");
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, current, answer, nextQuestion]);

  return (
    <div className="frame-x frame-t frame-b mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <Masthead progress={progress} />

      {exhausted ? (
        <main className="flex flex-1 flex-col pt-6">
          <p className="label text-muted">bank complete</p>
          <h1 className="mt-3 font-display text-3xl">Every question, answered right</h1>
          <Link
            href="/profile"
            className="label mt-8 w-fit cursor-pointer border border-signal bg-signal px-6 py-3 text-ink transition-colors hover:bg-paper hover:border-paper"
          >
            see your done list
          </Link>
        </main>
      ) : (
        <main className="flex flex-1 flex-col pt-4">
          {current ? (
            <>
              <div key={current.id} className="stagger pt-3">
                <h1 className="mt-3 font-display text-[1.75rem] leading-[1.25] text-balance sm:text-4xl">
                  {current.text}
                </h1>
              </div>

              <ul className="stagger mt-8 flex flex-col gap-2">
                {current.options.map((option, index) => {
                  const letter = LETTERS[index]!;
                  const isPicked = picked === option;
                  const isAnswer = option === current.answer;
                  const revealed = phase === "revealed";

                  let tone = "border-ink-line text-paper hover:border-paper/50 hover:bg-paper/[0.04]";
                  if (revealed && isAnswer) tone = "border-signal bg-signal text-ink";
                  else if (revealed && isPicked) tone = "border-fail bg-fail text-ink";
                  else if (revealed) tone = "border-ink-line text-muted";

                  return (
                    <li key={option}>
                      <button
                        ref={(el) => {
                          optionRefs.current[index] = el;
                        }}
                        type="button"
                        disabled={revealed || submitting}
                        onClick={() => answer(option)}
                        aria-keyshortcuts={`${letter.toLowerCase()} ${index + 1}`}
                        className={`group flex w-full items-start gap-4 border px-4 py-3.5 text-left transition-colors duration-150 ${tone} ${
                          revealed ? "cursor-default" : "cursor-pointer"
                        }`}
                      >
                        <kbd
                          title={`press ${letter} or ${index + 1}`}
                          className="label mt-0.5 w-4 shrink-0 font-normal opacity-60"
                        >
                          {letter}
                        </kbd>
                        <span className="text-[0.95rem] leading-snug">{option}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {submitting ? <p role="status" className="mt-4 text-muted">Checking answer…</p> : null}
              {answerError ? (
                <div className="mt-4 text-muted">
                  <p role="alert">{answerError}</p>
                  <button type="button" onClick={nextQuestion}
                    className="label mt-3 cursor-pointer border border-ink-line px-4 py-2 hover:text-signal">
                    skip this question
                  </button>
                </div>
              ) : null}
              {phase === "revealed" ? (
                <Reveal
                  key={`reveal-${current.id}`}
                  question={current}
                  correct={picked === current.answer}
                  onNext={nextQuestion}
                  nextRef={nextRef}
                />
              ) : null}
            </>
          ) : null}
        </main>
      )}

      <InstallBanner />
      <UpdatePrompt />
    </div>
  );
}

function Masthead({ progress }: { progress: SavedProgress }) {
  return (
    <header className="flex items-center justify-between border-b border-ink-line py-4">
      <span className="font-display text-2xl tracking-tight">
        <Link href="/" aria-label="back to the game">
          Endless <span className="text-signal">AI</span>
        </Link>
      </span>
      <div className="flex items-center gap-5">
        <SyncStatus />
        <span className="label text-muted">
          elo <span className="ml-1.5 font-mono text-sm text-paper">{progress.rating}</span>
        </span>
        <Link
          href="/categories"
          className="label cursor-pointer text-muted transition-colors hover:text-signal"
        >
          cats
        </Link>
        <Link
          href="/profile"
          aria-label="profile and settings"
          className="text-muted transition-colors hover:text-signal"
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
      </div>
    </header>
  );
}

function Reveal({
  question,
  correct,
  onNext,
  nextRef,
}: {
  question: Question;
  correct: boolean;
  onNext: () => void;
  nextRef: Ref<HTMLButtonElement>;
}) {
  const href = sourceHref(question.source);
  const label = sourceLabel(question.source);

  return (
    <div className="rise mt-7 border-t border-ink-line pt-5">
      <p className="label text-signal">{correct ? "correct" : "not quite"}</p>
      <p className="mt-3 text-[0.95rem] leading-relaxed text-paper/85">{question.explanation}</p>

      <div className="mt-5 flex flex-wrap items-center gap-5">
        <button
          ref={nextRef}
          type="button"
          onClick={onNext}
          aria-keyshortcuts="Enter ArrowRight"
          title="press Enter or →"
          className="label cursor-pointer border border-signal bg-signal px-5 py-2.5 text-ink transition-colors hover:bg-paper hover:border-paper"
        >
          next <span aria-hidden="true" className="opacity-60">⏎</span>
        </button>

        {href && label ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-keyshortcuts="?"
            title="press ? to open"
            className="label group inline-flex items-center gap-2 text-muted transition-colors hover:text-signal"
          >
            learn
            <span className="transition-transform group-hover:translate-x-0.5">→</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

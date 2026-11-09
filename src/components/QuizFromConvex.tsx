"use client";

import Link from "next/link";
import { useConvex, useConvexAuth, useQuery } from "convex/react";
import type { ConvexReactClient } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { api } from "../../convex/_generated/api";
import type { Question } from "@/lib/questions/schema";
import { loadFallbackBank } from "@/lib/questions/fallback";
import { readDrawCache, writeDrawCache } from "@/lib/quiz/bankCache";
import { readFilter } from "@/lib/quiz/filter";
import { readProgress } from "@/lib/progress";
import {
  getNetworkServerSnapshot,
  getNetworkSnapshot,
  subscribeNetwork,
} from "@/lib/pwa/network";
import { useIsomorphicLayoutEffect } from "@/lib/useIsomorphicLayoutEffect";
import { Quiz } from "./Quiz";
import { QuizSkeleton, Shell } from "./Skeletons";

export { Shell };

const PAGE = 20;

type DrawArgs = {
  excludeIds: string[];
  count: number;
  categories: string[];
  ratingHint: number;
};

async function drawPage(client: ConvexReactClient, args: DrawArgs) {
  return await client.query(api.questions.drawForPlay, args);
}

type DrawRow = {
  questionId: string;
  text: string;
  options: string[];
  category: string;
  difficulty: number;
  tags: string[];
  addedAt: string;
};

function toQuestion(q: DrawRow): Question {
  return {
    id: q.questionId,
    text: q.text,
    options: [...q.options] as [string, string, string, string],
    // Empty answer marks an online question awaiting server reveal.
    answer: "",
    category: q.category as Question["category"],
    tags: [...q.tags],
    difficulty: q.difficulty,
    explanation: "",
    source: { kind: "none" },
    answerAliases: [],
    status: "published" as const,
    addedAt: q.addedAt,
  };
}

/**
 * Plays from the published Convex questions table in pages (#25), not the
 * whole bank. First page excludes the done list (local + server when signed
 * in, so an existing account never replays its history on a fresh device);
 * top-ups exclude everything seen so far. Page loads transfer O(1) questions
 * regardless of bank size.
 *
 * Stale-while-revalidate (#31): the last draw snapshot is cached locally per
 * filter. Repeat visits paint the cached questions instantly (no skeleton),
 * then revalidate in the background and merge fresh rows. Only a true first
 * run with an empty cache blocks on the network.
 */
export function QuizFromConvex() {
  const client = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const serverCompleted = useQuery(
    api.answers.myCompleted,
    isAuthenticated ? {} : "skip",
  );
  const [filter] = useState<string[]>(() => readFilter());
  // Subscribed, not read once: a mid-session disconnect re-renders into the
  // fallback path, and a reconnect re-renders back into the live draw (which
  // then revalidates in the background). Server snapshot is always online, so
  // hydration matches by construction.
  const network = useSyncExternalStore(
    subscribeNetwork,
    getNetworkSnapshot,
    getNetworkServerSnapshot,
  );
  const offline = !network.online;
  // Null through hydration (matches the SSR skeleton), then painted from the
  // local snapshot in a layout effect: before paint, so repeat visits never
  // see the skeleton and never mismatch hydration.
  const [bank, setBank] = useState<Question[] | null>(null);
  const [initial, setInitial] = useState<Question | null>(null);
  const hadCache = useRef(false);
  const categories = useMemo(
    () => new Set(filter as Question["category"][]),
    [filter],
  );

  useIsomorphicLayoutEffect(() => {
    const cached = readDrawCache(filter);
    if (cached && cached.length > 0) {
      hadCache.current = true;
      setBank(cached);
      setInitial(cached[Math.floor(Math.random() * cached.length)] ?? null);
    }
  }, [filter]);

  useEffect(() => {
    if (isAuthenticated && serverCompleted === undefined) return;
    let cancelled = false;
    // A disconnected Convex client does not reject a query, it parks it and
    // retries the connection forever — same trap as the top-up below. So an
    // offline boot must not even attempt the draw; it goes straight to the
    // cache-or-fallback path. (`navigator.onLine` can lie behind a captive
    // portal, in which case the draw hangs exactly like any networked app.
    // No timer: inventing our own notion of "too slow" would race the real
    // response on a merely bad connection.)
    const draw = offline
      ? Promise.reject(new Error("offline"))
      : drawPage(client, {
          excludeIds: [
            ...new Set([...readProgress().completed, ...(serverCompleted ?? [])]),
          ],
          count: PAGE,
          categories: filter,
          ratingHint: readProgress().rating,
        });
    void draw
      .then((rows) => {
        if (cancelled) return;
        const questions = rows.map(toQuestion);
        if (questions.length === 0) {
          // Empty draw with a painted cache means the player is mid-game on
          // stale questions (done list grew since the snapshot): keep playing
          // the cache, the top-up path will page past it. Only an uncached
          // first run is truly empty.
          if (!hadCache.current) {
            setBank([]);
            setInitial(null);
          }
          return;
        }
        writeDrawCache(filter, questions);
        if (hadCache.current) {
          // Background revalidate: merge without swapping the live question.
          setBank((prev) => {
            if (!prev) return questions;
            const known = new Set(prev.map((q) => q.id));
            const fresh = questions.filter((q) => !known.has(q.id));
            return fresh.length > 0 ? [...prev, ...fresh] : prev;
          });
        } else {
          setBank(questions);
          setInitial(
            questions[Math.floor(Math.random() * questions.length)] ?? null,
          );
        }
      })
      .catch(() => {
        // Offline with cache: keep playing stale, the error is invisible.
        if (cancelled || hadCache.current) return;
        // Offline with no cache: the bundled content bank (#17) is the last
        // resort before the empty-bank frame. It answers from the same content
        // the server publishes from, filtered to the player's categories, and
        // the first chunk is written into the draw cache so the next cold boot
        // paints instantly and revalidates like any other cached draw.
        void loadFallbackBank().then((fallback) => {
          if (cancelled) return;
          const playable =
            filter.length === 0
              ? fallback
              : fallback.filter((q) => filter.includes(q.category));
          if (playable.length === 0) {
            setBank([]);
            return;
          }
          writeDrawCache(filter, playable.slice(0, 60));
          setBank(playable);
          setInitial(playable[Math.floor(Math.random() * playable.length)] ?? null);
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client, isAuthenticated, serverCompleted, filter, offline]);

  const topUp = useCallback(
    async (seen: Set<string>): Promise<Question[]> => {
      // Offline with the local bank spent: a disconnected Convex client does
      // not reject a query, it parks it and retries the connection forever, so
      // waiting on it means the player sits on "next" indefinitely. Report an
      // empty page instead and let the quiz end the run.
      if (offline) return [];

      const excludeIds = [
        ...new Set([...(serverCompleted ?? []), ...seen]),
      ].slice(-1000);
      const rows = await drawPage(client, {
        excludeIds,
        count: PAGE,
        categories: filter,
        ratingHint: readProgress().rating,
      });
      const fresh = rows.map(toQuestion);
      setBank((prev) => {
        const next = !prev
          ? fresh
          : [...prev, ...fresh.filter((q) => !new Set(prev.map((p) => p.id)).has(q.id))];
        writeDrawCache(filter, next.slice(-60));
        return next;
      });
      return fresh;
    },
    [client, serverCompleted, filter, offline],
  );

  // The filter is fixed per mount: picking categories navigates client-side
  // back to `/`, which remounts with the fresh filter (no full reload).

  if (bank === null || (initial === null && bank.length > 0)) return <QuizSkeleton />;

  if (bank.length === 0) {
    const completed = readProgress().completed.length;
    // First run with no connection: the draw failed and there is no cached or
    // bundled snapshot. The standard copy below assumes an unpublished backend
    // ("run npx convex dev"), which is what a developer needs to hear — but a
    // player on a plane needs to hear that the app itself is fine.
    if (offline && completed === 0) {
      return (
        <Shell>
          <main className="flex flex-1 flex-col pt-14">
            <p className="label text-muted">no connection</p>
            <h1 className="mt-3 font-display text-3xl">Nothing saved here yet</h1>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">
              The quiz lives on this device after one visit with a connection.
              Connect once and it keeps working without one.
            </p>
          </main>
        </Shell>
      );
    }
    return (
      <Shell>
        <main className="flex flex-1 flex-col pt-14">
          <p className="label text-muted">
            {completed > 0 ? "bank complete" : "empty bank"}
          </p>
          <h1 className="mt-3 font-display text-3xl">
            {completed > 0
              ? "Every question, answered right"
              : "Nothing published yet"}
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">
            {completed > 0 ? (
              <Link
                href="/profile"
                className="label cursor-pointer text-muted transition-colors hover:text-signal"
              >
                see your done list →
              </Link>
            ) : (
              <>
                Run <span className="font-mono">npx convex dev</span> and then{" "}
                <span className="font-mono">npx tsx scripts/publish.mts</span> to sync
                the validated bank.
              </>
            )}
          </p>
        </main>
      </Shell>
    );
  }

  return <Quiz bank={bank} initial={initial!} onNeedMore={topUp} categories={categories} />;
}

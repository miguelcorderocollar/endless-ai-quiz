"use client";

import { rateLimitMessage } from "@/lib/answers/errors";

import Link from "next/link";
import { useConvexAuth, useConvex, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { api } from "../../../convex/_generated/api";
import {
  getProgressSnapshot,
  getProgressServerSnapshot,
  hydrateProgress,
  subscribeProgress,
} from "@/lib/progress";
import {
  type CachedProfile,
  readListCache,
  readProfileCache,
  writeListCache,
  writeProfileCache,
} from "@/lib/quiz/bankCache";
import {
  getNetworkServerSnapshot,
  getNetworkSnapshot,
  subscribeNetwork,
} from "@/lib/pwa/network";
import { useIsomorphicLayoutEffect } from "@/lib/useIsomorphicLayoutEffect";
import { resetProgressAndClear } from "@/lib/accountState";
import { useLocalSignOut } from "@/lib/useLocalSignOut";
import type { Question } from "@/lib/questions/schema";
import { loadFallbackBank } from "@/lib/questions/fallback";
import { DeleteAccount } from "@/components/DeleteAccount";
import { DoneList } from "@/components/DoneList";
import { InstallRow } from "@/components/InstallPrompt";
import { Popup } from "@/components/Popup";
import { Shell } from "@/components/QuizFromConvex";
import { SignInForm } from "@/components/Account";
import { Distribution, EloChart } from "@/components/Stats";
import {
  ChartSkeleton,
  DistributionSkeleton,
  DoneListSkeleton,
  ProfileHeaderSkeleton,
} from "@/components/Skeletons";

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

export default function ProfilePage() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { leave, busy: signingOut, error: signOutError } = useLocalSignOut();
  const me = useQuery(api.users.me, isAuthenticated ? {} : "skip");
  const [bank, setBank] = useState<Question[] | undefined>();
  useEffect(() => {
    let cancelled = false;
    void loadFallbackBank().then((rows) => { if (!cancelled) setBank(rows); });
    return () => { cancelled = true; };
  }, []);
  const stats = useQuery(api.answers.myStats, isAuthenticated ? {} : "skip");
  const ensureStats = useMutation(api.answers.ensureStats);
  const history = useQuery(api.stats.history, isAuthenticated ? {} : "skip");
  const population = useQuery(api.stats.population, {});
  const serverCompleted = useQuery(
    api.answers.myCompleted,
    isAuthenticated ? {} : "skip",
  );
  // Defensive fetch, not useQuery: if the backend predates myRecent (npx
  // convex dev not run since it was added), a missing function would throw
  // during render and crash the page. Manual fetch lets us fall back to the
  // device-local recent ring. Sync the backend for cross-device misses.
  const convex = useConvex();
  const [serverRecent, setServerRecent] = useState<
    { questionId: string; correct: boolean; createdAt: number }[] | undefined
  >(undefined);
  const [recentUnsupported, setRecentUnsupported] = useState(false);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- logout reset runs on auth transition only, cannot cascade */
    if (!isAuthenticated) {
      setServerRecent(undefined);
      setRecentUnsupported(false);
      return;
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    let cancelled = false;
    void convex.query(api.answers.myRecent, {}).then(
      (rows) => {
        if (!cancelled) setServerRecent(rows);
      },
      () => {
        if (!cancelled) {
          setServerRecent([]);
          setRecentUnsupported(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [convex, isAuthenticated]);
  const progress = useSyncExternalStore(
    subscribeProgress,
    getProgressSnapshot,
    getProgressServerSnapshot,
  );

  const [popup, setPopup] = useState<"signin" | "name" | "reset" | null>(null);
  const [tab, setTab] = useState<"you" | "all">("you");
  // Stale-while-revalidate (#31): paint the last published-list snapshot
  // instantly so the done list never flashes a skeleton on repeat visits.
  // Null through hydration (matches SSR), populated pre-paint — same for the
  // cached profile name below. Reading localStorage in a state initializer
  // would mismatch hydration (server has no cache).
  const [cachedList, setCachedList] = useState<Question[] | null>(null);
  // Known name, no loading flash: the last signed-in header paints instantly
  // while `users.me` revalidates. Cleared on sign-out.
  const [cachedProfile, setCachedProfile] = useState<CachedProfile | null>(null);

  useIsomorphicLayoutEffect(() => {
    setCachedList(readListCache());
    setCachedProfile(readProfileCache());
  }, []);

  useEffect(() => {
    if (me) writeProfileCache(me);
  }, [me]);

  useEffect(() => {
    hydrateProgress();
  }, []);

  useEffect(() => {
    // Signed-in users with events but no rollup get one built on demand, so
    // the profile never shows device-only totals while authenticated.
    if (isAuthenticated && stats === null) void ensureStats();
  }, [isAuthenticated, stats, ensureStats]);

  const questions: Question[] =
    bank && bank.length > 0 ? bank : cachedList ?? [];
  // Offline, Convex auth and every query hang instead of failing — auth never
  // settles and the query hooks stay `undefined` until the socket connects.
  // An unsettled page would park on skeletons forever, so everything below
  // treats offline as settled and lets the guest frame plus the device-local
  // progress carry the page until the connection returns. Subscribed, not
  // read once, so a mid-session disconnect re-renders out of the skeletons;
  // the server snapshot is always online, so hydration matches.
  const network = useSyncExternalStore(
    subscribeNetwork,
    getNetworkSnapshot,
    getNetworkServerSnapshot,
  );
  const offline = !network.online;
  const bankReady = bank !== undefined || cachedList !== null || offline;

  useEffect(() => {
    if (bank && bank.length > 0) writeListCache(questions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank]);

  const displayMe = me ?? cachedProfile;
  // Refresh race: while auth resolves isAuthenticated is false, so a cached
  // name would briefly render the guest CTA before flipping to the profile.
  // Treat a cached non-anonymous identity as signed-in until auth settles,
  // and keep the skeleton while the identity is still unknown.
  const mePending = isAuthenticated && me === undefined;
  const headerPending = !offline && (isLoading || mePending) && !displayMe;
  const guest = isLoading
    ? !displayMe || displayMe.isAnonymous
    : !isAuthenticated || !displayMe || displayMe.isAnonymous;

  /**
   * Recent attempts, oldest first — the order they happened in, which is what
   * the done list is sorted by. Signed in it is the server event stream (so it
   * crosses devices); a guest it is the device-local ring.
   *
   * Both sources arrive newest-first and are flipped here rather than in
   * `buildDoneList`, so that function has one contract: record order.
   */
  const attempts = useMemo(() => {
    const source =
      isAuthenticated && !recentUnsupported
        ? (serverRecent ?? []).map((r) => ({
            id: r.questionId,
            correct: r.correct,
          }))
        : progress.recent
            .slice()
            .reverse()
            .map((r) => ({
              id: r.id,
              correct: r.correct,
            }));
    return source.reverse();
  }, [isAuthenticated, recentUnsupported, serverRecent, progress.recent]);

  return (
    <Shell showElo={false}>
      <main className="flex flex-1 flex-col pt-6">
        <p className="label text-muted">profile</p>

        {headerPending ? (
          <ProfileHeaderSkeleton />
        ) : guest ? (
          <>
            <h1 className="mt-3 font-display text-3xl">Playing as guest</h1>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">
              Your Elo and done list live on this device only. Sign in to keep them on
              every device.
            </p>
            <button
              type="button"
              onClick={() => setPopup("signin")}
              className="label mt-8 w-fit cursor-pointer border border-signal bg-signal px-6 py-3 text-ink transition-colors hover:bg-paper hover:border-paper"
            >
              sign in
            </button>
          </>
        ) : (
          <>
            <div className="mt-3 flex items-center justify-between gap-4">
              <h1 className="font-display text-3xl leading-none">
                {displayMe?.displayName ?? displayMe?.handle ?? "player"}
              </h1>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setPopup("name")}
                  aria-label="edit name"
                  className="cursor-pointer text-muted transition-colors hover:text-signal"
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  onClick={() => setPopup("reset")}
                  aria-label="reset progress"
                  className="cursor-pointer text-muted transition-colors hover:text-fail"
                >
                  <ResetIcon />
                </button>
                <button
                  type="button"
                  onClick={() => void leave()}
                  disabled={signingOut}
                  aria-label="sign out"
                  className="cursor-pointer text-muted transition-colors hover:text-signal"
                >
                  <SignOutIcon />
                </button>
              </div>
            </div>
            {/* No handle here. It is the account's internal id — a player
                recognises themselves by their name, and `handle` was noise
                between the name and the Elo. The role marker stays, because
                "admin" is something a reader needs and an opaque id is not. */}
            {displayMe?.role === "admin" ? (
              <p className="label mt-2 text-signal">admin</p>
            ) : null}
          </>
        )}

        <div className="mt-8 border-t border-ink-line pt-6">
          <p className="label text-muted">elo rating</p>
          <p className="mt-2 font-display text-7xl leading-none tracking-tight">
            {stats?.rating ?? progress.rating}
          </p>
          <p className="label mt-4 text-muted">
            {stats
              ? `${stats.answered} answered · streak ${stats.streak} · best ${stats.bestStreak}`
              : isAuthenticated && !offline
                ? "no answers yet on this account"
                : "on this device only · sign in to sync"}
          </p>

          <div className="mt-8 flex gap-3">
            {(["you", "all"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                className={`label cursor-pointer border px-4 py-2 transition-colors ${
                  tab === t
                    ? "border-signal bg-signal text-ink"
                    : "border-ink-line text-muted hover:text-signal"
                }`}
              >
                {t === "you" ? "you" : "all players"}
              </button>
            ))}
          </div>

          {tab === "you" ? (
            <div className="mt-3 min-h-[340px]">
              {history === undefined && !offline ? (
                isAuthenticated ? (
                  <ChartSkeleton />
                ) : (
                  <EloChart points={[]} median={population?.median ?? null} />
                )
              ) : (
                <EloChart points={history ?? []} median={population?.median ?? null} />
              )}
            </div>
          ) : (
            <div className="mt-3 min-h-[340px]">
              {population === undefined && !offline ? (
                <DistributionSkeleton />
              ) : (
                <Distribution
                  buckets={population?.buckets ?? []}
                  count={population?.count ?? 0}
                  median={population?.median ?? null}
                  percentile={population?.percentile ?? null}
                  rating={stats?.rating ?? null}
                />
              )}
            </div>
          )}
        </div>

        <div className="mt-8 border-t border-ink-line pt-6">
          <p className="label text-muted">done</p>
          {!bankReady ? (
            <DoneListSkeleton />
          ) : (
            <div className="mt-2">
              <DoneList
                bank={questions}
                completedIds={
                  isAuthenticated
                    ? (serverCompleted ?? progress.completed)
                    : progress.completed
                }
                attempts={attempts}
                correct={stats?.correct ?? progress.correct}
                answered={stats?.answered ?? progress.answered}
                total={questions.length}
              />
            </div>
          )}
        </div>

        {signOutError ? <p role="alert">{signOutError}</p> : null}
        {!guest ? (
          <section aria-label="danger zone" className="mt-8 border-t border-ink-line pt-6">
            <p className="label mb-4 text-muted">danger zone</p>
            <div className="flex items-center gap-6">
              <button type="button" onClick={() => setPopup("reset")} className="label cursor-pointer text-fail">reset progress</button>
              <DeleteAccount />
            </div>
          </section>
        ) : null}
        <Link href="/privacy" className="label mt-8 w-fit text-muted hover:text-signal">privacy notice</Link>
        <InstallRow />

        <Link
          href="/"
          className="label mt-10 w-fit cursor-pointer text-muted transition-colors hover:text-signal"
        >
          ← keep playing
        </Link>
      </main>

      {popup === "signin" ? (
        <Popup label="account" title="Sign in" onClose={() => setPopup(null)}>
          <SignInForm
            layout="dialog"
            onDone={() => setPopup(null)}
            onSignOut={() => void leave()}
          />
        </Popup>
      ) : null}

      {popup === "name" && !guest && displayMe ? (
        <Popup label="profile" title="Display name" onClose={() => setPopup(null)}>
          <DisplayNameForm
            current={displayMe.displayName ?? ""}
            onSaved={() => setPopup(null)}
          />
        </Popup>
      ) : null}

      {popup === "reset" && !guest ? (
        <Popup label="danger zone" title="Reset progress?" onClose={() => setPopup(null)}>
          <ResetConfirm
            account={displayMe?.handle ?? null}
            onCancel={() => setPopup(null)}
            onDone={() => {
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- discard mounted account state after reset
              window.location.assign("/");
            }}
          />
        </Popup>
      ) : null}
    </Shell>
  );
}

function ResetConfirm({
  account,
  onCancel,
  onDone,
}: {
  account: string | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const resetProgress = useMutation(api.users.resetProgress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-muted">
        This deletes every answer you have given: Elo drops back to 1000, your streak,
        per-category accuracy, and done list are wiped. Your account, handle, and
        role stay. <span className="text-fail">There is no undo.</span>
      </p>
      {error ? <span className="text-xs leading-snug text-fail">{error}</span> : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void resetProgressAndClear(() => resetProgress({}), account).then(
              () => onDone(),
              (err: unknown) => {
                setBusy(false);
                setError(err instanceof Error ? err.message : "Could not reset.");
              },
            );
          }}
          className="label cursor-pointer border border-fail bg-fail px-5 py-2.5 text-ink transition-colors hover:bg-paper hover:border-paper disabled:opacity-50"
        >
          {busy ? "resetting…" : "yes, reset everything"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="label cursor-pointer text-muted transition-colors hover:text-signal"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

function DisplayNameForm({
  current,
  onSaved,
}: {
  current: string;
  onSaved: () => void;
}) {
  const setDisplayName = useMutation(api.users.setDisplayName);
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        void setDisplayName({ displayName: name }).then(
          () => onSaved(),
          (err: unknown) =>
            setError(rateLimitMessage(err) ?? (err instanceof Error ? err.message : "Could not save.")),
        );
      }}
      className="flex flex-col gap-4"
    >
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={40}
        placeholder="what should we call you"
        className="border-b border-ink-line bg-transparent py-1.5 text-sm text-paper placeholder:text-muted/50 focus:border-signal focus:outline-none"
      />
      {error ? <span className="text-xs leading-snug text-fail">{error}</span> : null}
      <button
        type="submit"
        className="label w-fit cursor-pointer border border-signal bg-signal px-6 py-2.5 text-ink transition-colors hover:bg-paper hover:border-paper"
      >
        save
      </button>
    </form>
  );
}

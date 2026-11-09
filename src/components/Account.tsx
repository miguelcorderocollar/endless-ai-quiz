"use client";

import Link from "next/link";
import { rateLimitMessage } from "@/lib/answers/errors";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex, useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";

import { api } from "../../convex/_generated/api";
import { readProgress, updateProgress } from "@/lib/progress";
import { snapshotGuestProgress } from "@/lib/accountState";
import { useLocalSignOut } from "@/lib/useLocalSignOut";
import { AccountSlotSkeleton } from "./Skeletons";

/**
 * Lazy guests (#34): visitors play fully local with no server session — no
 * user row, no actions, no subscriptions until they choose to sign in.
 *
 * On sign-in, `claimProgress` seeds the rollup once from device-local totals
 * ONLY when the account is brand new (no stats, no events). Logging into an
 * existing account leaves that account untouched (`seeded: false`): local
 * totals are ignored and the device cache is reconciled to server truth so
 * the existing Elo/counts/done list stay visible instead of the guest's.
 */
export function Account() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { leave, busy, error: signOutError } = useLocalSignOut();
  const convex = useConvex();
  const me = useQuery(api.users.me, isAuthenticated ? {} : "skip");
  const ensureProfile = useMutation(api.users.ensureProfile);
  const claim = useMutation(api.users.claimProgress);

  const profileEnsured = useRef(false);

  useEffect(() => {
    if (isAuthenticated && !profileEnsured.current) {
      profileEnsured.current = true;
      const local = readProgress();
      void ensureProfile().then(
        async () => {
          try {
            const result = await claim({
              rating: local.rating,
              answered: local.answered,
              correct: local.correct,
            });
            if (!result.seeded) {
              // Existing account: discard guest totals, show server truth.
              const [stats, completed] = await Promise.all([
                convex.query(api.answers.myStats, {}),
                convex.query(api.answers.myCompleted, {}),
              ]);
              if (stats) {
                updateProgress({
                  ...readProgress(),
                  rating: stats.rating,
                  answered: stats.answered,
                  correct: stats.correct,
                  streak: stats.streak,
                  completed,
                });
              } else {
                updateProgress({ ...readProgress(), completed });
              }
            }
            // New account (seeded): server mirrors local, keep local as is.
          } catch {
            /* claim/reconcile is best-effort: local progress stands regardless */
          }
        },
        () => {
          profileEnsured.current = false;
        },
      );
    }
    if (!isAuthenticated) profileEnsured.current = false;
  }, [isAuthenticated, ensureProfile, claim, convex]);

  if (isLoading || (isAuthenticated && me === undefined)) {
    return <AccountSlotSkeleton />;
  }

  if (!isAuthenticated || !me || me.isAnonymous) {
    return (
      <Link
        href="/signin"
        className="label cursor-pointer text-muted transition-colors hover:text-signal"
      >
        sign in
      </Link>
    );
  }

  return (
    <span className="flex items-baseline gap-5">
      <span className="label text-paper">{me.displayName ?? me.handle ?? "player"}</span>
      <button
        type="button"
        onClick={() => void leave()}
        disabled={busy}
        className="label cursor-pointer text-muted transition-colors hover:text-signal"
      >
        out
      </button>
      {signOutError ? <span role="alert">{signOutError}</span> : null}
    </span>
  );
}

/**
 * Raw auth errors carry request IDs and stack traces. Unwrap our server
 * messages (ConvexError) and map known Auth.js codes to human copy.
 * Returns the message plus whether the UI should flip to signup
 * (sign-in attempted on an email with no account).
 */
function interpretAuthError(
  err: unknown,
  flow: "signIn" | "signUp",
): { message: string; flipToSignUp: boolean } {
  const limited = rateLimitMessage(err);
  if (limited) return { message: limited, flipToSignUp: false };
  const raw = err instanceof Error ? err.message : String(err);
  const serverMessage = raw.match(/(?:Uncaught (?:Convex)?Error|ConvexError):\s*([^]+?)(?:\s+at\s|\s*$)/)?.[1]?.trim();

  if (/InvalidAccountId/i.test(raw)) {
    return flow === "signIn"
      ? {
          message: "No account with that email yet — pick a password to create one.",
          flipToSignUp: true,
        }
      : { message: "Could not use those credentials.", flipToSignUp: false };
  }
  if (/InvalidPassword|invalid credentials|verify the password/i.test(raw)) {
    return { message: "Wrong password for that email.", flipToSignUp: false };
  }
  if (serverMessage) return { message: serverMessage, flipToSignUp: false };
  return { message: "Could not sign in. Try again.", flipToSignUp: false };
}

export function SignInForm({
  onDone,
  onSignOut,
  layout = "panel",
}: {
  onDone: () => void;
  onSignOut: () => void;
  layout?: "panel" | "page" | "dialog";
}) {
  const { signIn } = useAuthActions();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState<string | null>(null);

  const frame =
    layout === "panel"
      ? "absolute right-0 top-7 z-10 block w-64 border border-ink-line bg-ink-raised p-4"
      : layout === "dialog"
        ? "block w-full"
        : "block w-full max-w-sm";

  return (
    <span className={frame}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          const formData = new FormData(event.currentTarget);
          if (!isLoading && !isAuthenticated) snapshotGuestProgress();
          void signIn("password", formData).then(
            () => onDone(),
            (err: unknown) => {
              const interpreted = interpretAuthError(err, flow);
              if (interpreted.flipToSignUp) setFlow("signUp");
              setError(interpreted.message);
            },
          );
        }}
        className="flex flex-col gap-3"
      >
        <input
          name="email"
          type="email"
          required
          placeholder="email"
          autoComplete="email"
          className="border-b border-ink-line bg-transparent py-1.5 text-sm text-paper placeholder:text-muted/50 focus:border-signal focus:outline-none"
        />
        <input
          name="password"
          type="password"
          required
          minLength={8}
          placeholder="password (8+)"
          autoComplete={flow === "signUp" ? "new-password" : "current-password"}
          className="border-b border-ink-line bg-transparent py-1.5 text-sm text-paper placeholder:text-muted/50 focus:border-signal focus:outline-none"
        />
        <input name="flow" type="hidden" value={flow} />
        <button
          type="submit"
          className="label mt-1 cursor-pointer border border-signal bg-signal px-4 py-2 text-ink transition-colors hover:bg-paper hover:border-paper"
        >
          {flow === "signIn" ? "sign in" : "create account"}
        </button>
        {error ? <span className="text-xs leading-snug text-fail">{error}</span> : null}
      </form>
      <span className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setFlow(flow === "signIn" ? "signUp" : "signIn");
          }}
          className="label cursor-pointer text-muted transition-colors hover:text-signal"
        >
          {flow === "signIn" ? "new here? sign up" : "have an account? sign in"}
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="label cursor-pointer text-muted/60 transition-colors hover:text-signal"
        >
          forget me
        </button>
      </span>
    </span>
  );
}

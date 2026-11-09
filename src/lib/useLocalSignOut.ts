"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { drainOutbox } from "./answers/outbox";
import { readProfileCache } from "./quiz/bankCache";
import { useState } from "react";
import { clearLocalAuthTokens, signOutAndClear } from "./accountState";

export function useLocalSignOut() {
  const { signOut } = useAuthActions();
  const recordAnswer = useMutation(api.answers.answer);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const parked = await signOutAndClear(signOut, {
        drain: navigator.onLine
          ? () => drainOutbox(recordAnswer, readProfileCache()?.handle ?? null)
          : undefined,
        clearTokens: () => clearLocalAuthTokens(process.env.NEXT_PUBLIC_CONVEX_URL!),
      });
      try {
        window.sessionStorage.removeItem("endless-ai:signout-notice");
        if (parked > 0) {
          window.sessionStorage.setItem("endless-ai:signout-notice", `${parked} unsynced answers remain on this device for this account. Sign in again to sync them.`);
        }
      } catch {
        // Still report parked work if session storage is unavailable.
        if (parked > 0) window.alert(`${parked} unsynced answers remain on this device. Sign in again to sync them.`);
      }
      // A fresh document also discards mounted query results and pending UI work.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- discard mounted account state after cleanup
      window.location.assign("/");
    } catch {
      setError("Could not sign out. Try again.");
      setBusy(false);
    }
  };
  return { leave, busy, error };
}

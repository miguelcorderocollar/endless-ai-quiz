"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";
import { signOutAndClear } from "./accountState";

export function useLocalSignOut() {
  const { signOut } = useAuthActions();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signOutAndClear(signOut);
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

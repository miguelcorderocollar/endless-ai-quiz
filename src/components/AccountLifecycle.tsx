"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { clearLocalAccountState, handleAuthTokenRemoval } from "@/lib/accountState";
import { writeProfileCache } from "@/lib/quiz/bankCache";

const NOTICE_KEY = "endless-ai:signout-notice";
const subscribe = () => () => {};
function readNotice(): string | null {
  try { return window.sessionStorage.getItem(NOTICE_KEY); } catch { return null; }
}

/** Mounted on every route, including the quiz, independent of Account's UI. */
export function AccountLifecycle() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const wasAuthenticated = useRef(false);
  const me = useQuery(api.users.me, isAuthenticated ? {} : "skip");
  const notice = useSyncExternalStore(subscribe, readNotice, () => null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (me) writeProfileCache(me);
  }, [me]);

  useEffect(() => {
    if (!isLoading && wasAuthenticated.current && !isAuthenticated) {
      clearLocalAccountState({ reason: "signOut" });
      window.location.reload();
    }
    if (!isLoading) wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL!;
    const onStorage = (event: StorageEvent) => {
      handleAuthTokenRemoval(event, url, () => window.location.reload());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (!notice || dismissed) return null;
  return (
    <div role="status" className="mx-auto max-w-2xl px-5 py-3 text-sm text-muted">
      {notice}{" "}
      <button type="button" className="cursor-pointer text-signal" onClick={() => {
        window.sessionStorage.removeItem(NOTICE_KEY);
        setDismissed(true);
      }}>dismiss</button>
    </div>
  );
}

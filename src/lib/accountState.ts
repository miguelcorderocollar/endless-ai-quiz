import { EMPTY_PROGRESS, readProgress, updateProgress, type SavedProgress } from "./progress";
import { clearOutbox, discardUntaggedAnswers, getOutboxSnapshot, invalidateOutboxDrains } from "./answers/outbox";
import { clearProfileCache, clearQuizCaches, readProfileCache } from "./quiz/bankCache";
import { clearQuizSession } from "./quiz/session";

const GUEST_KEY = "endless-ai:guest-progress:v1";
let guestSnapshot: SavedProgress | null = null;

/** Call before authentication can overwrite the guest's progress. */
export function snapshotGuestProgress(): void {
  guestSnapshot = readProgress();
  try {
    window.localStorage.setItem(GUEST_KEY, JSON.stringify(guestSnapshot));
  } catch {
    /* Keep the in-memory snapshot if storage is unavailable. */
  }
}

function restoreGuestProgress(): SavedProgress {
  try {
    const raw = window.localStorage.getItem(GUEST_KEY);
    window.localStorage.removeItem(GUEST_KEY);
    if (raw) return { ...EMPTY_PROGRESS, ...JSON.parse(raw) };
  } catch {
    /* An absent or unreadable snapshot starts an empty guest profile. */
  }
  return guestSnapshot ?? { ...EMPTY_PROGRESS };
}

/**
 * Shared local cleanup for sign-out, reset, and account deletion (#81).
 * Reset and deletion remove this account's queue. Sign-out parks tagged events
 * and drops untagged events. Deletion also discards the guest snapshot.
 * Preferences and the PWA shell survive.
 */
export function clearLocalAccountState(
  options: { reason: "signOut" } | { reason: "reset" | "deletion"; account: string | null },
): void {
  invalidateOutboxDrains();
  if (options.reason !== "signOut") clearOutbox(options.account);
  else discardUntaggedAnswers();
  clearQuizCaches();
  if (options.reason !== "reset") clearProfileCache();
  clearQuizSession();
  updateProgress(options.reason === "signOut" ? restoreGuestProgress() : { ...EMPTY_PROGRESS });
  if (options.reason !== "reset") {
    guestSnapshot = null;
    try { window.localStorage.removeItem(GUEST_KEY); } catch { /* unavailable */ }
  }
}

export const SIGN_OUT_TIMEOUT_MS = 2500;

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Navigation follows a bounded flush, auth teardown, and local cleanup. */
export async function signOutAndClear(
  signOut: () => Promise<void>,
  options: {
    drain?: () => Promise<unknown>;
    clearTokens?: () => void;
    timeoutMs?: number;
  } = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? SIGN_OUT_TIMEOUT_MS;
  discardUntaggedAnswers();
  if (options.drain) {
    try { await bounded(options.drain(), timeoutMs); } catch { /* Park for the owner. */ }
  }
  const account = readProfileCache()?.handle;
  const parked = getOutboxSnapshot().pending.filter(event =>
    event.account !== null && (account == null || event.account === account),
  ).length;
  invalidateOutboxDrains();
  try {
    await bounded(signOut(), timeoutMs);
  } catch (error) {
    if (!options.clearTokens) throw error;
    options.clearTokens();
  }
  clearLocalAccountState({ reason: "signOut" });
  return parked;
}

/** SDK storage keys are scoped to the configured Convex URL. */
export function clearLocalAuthTokens(url: string): void {
  const namespace = url.replace(/[^a-zA-Z0-9]/g, "");
  for (const key of ["__convexAuthJWT", "__convexAuthRefreshToken"]) {
    window.localStorage.removeItem(`${key}_${namespace}`);
  }
}

export function handleAuthTokenRemoval(
  event: Pick<StorageEvent, "key" | "newValue">,
  url: string,
  reload: () => void,
): void {
  const key = `__convexAuthJWT_${url.replace(/[^a-zA-Z0-9]/g, "")}`;
  if (event.key !== key || event.newValue !== null) return;
  clearLocalAccountState({ reason: "signOut" });
  reload();
}

/** Stop replay before issuing the reset mutation, then clear only on success. */
export async function resetProgressAndClear(
  reset: () => Promise<unknown>, account: string | null,
): Promise<void> {
  invalidateOutboxDrains();
  await reset();
  clearLocalAccountState({ reason: "reset", account });
}

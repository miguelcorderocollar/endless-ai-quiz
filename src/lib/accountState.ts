import { EMPTY_PROGRESS, readProgress, updateProgress, type SavedProgress } from "./progress";
import { clearOutbox, invalidateOutboxDrains } from "./answers/outbox";
import { clearProfileCache, clearQuizCaches } from "./quiz/bankCache";
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
 * Shared local cleanup for sign-out, reset, and account deletion (#63).
 * Reset removes this account's events and legacy untagged events; sign-out
 * parks all events for their owners. Preferences and the PWA shell survive.
 */
export function clearLocalAccountState(
  options: { reason: "signOut" } | { reason: "reset"; account: string | null },
): void {
  invalidateOutboxDrains();
  if (options.reason === "reset") clearOutbox(options.account);
  clearQuizCaches();
  if (options.reason === "signOut") clearProfileCache();
  clearQuizSession();
  updateProgress(options.reason === "signOut" ? restoreGuestProgress() : { ...EMPTY_PROGRESS });
  if (options.reason === "signOut") guestSnapshot = null;
}

/** Navigation belongs after both auth teardown and local cleanup. */
export async function signOutAndClear(signOut: () => Promise<void>): Promise<void> {
  invalidateOutboxDrains();
  await signOut();
  clearLocalAccountState({ reason: "signOut" });
}

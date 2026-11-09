import type { Question } from "@/lib/questions/schema";

/**
 * Stale-while-revalidate snapshots for instant screen changes (#31).
 *
 * The quiz draw (20 questions) and the full published list (profile done
 * list) are persisted locally. Repeat visits paint the snapshot instantly and
 * revalidate against Convex in the background; only a true first run with an
 * empty cache shows the skeleton. Same versioning idea as the PWA fallback
 * bank (#17) will reuse, kept in localStorage for now (small: ~20 questions
 * for the draw cache, full list only for the done list).
 */

const DRAW_PREFIX = "endless-ai:draw-cache:v1:";
const LIST_KEY = "endless-ai:bank-list:v1";
const COUNTS_KEY = "endless-ai:counts:v1";
const PROFILE_KEY = "endless-ai:profile:v1";

function filterKey(filter: string[]): string {
  return [...filter].sort().join(",") || "all";
}

function safeRead<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* cache is a nicety, not a requirement */
  }
}

export function readDrawCache(filter: string[]): Question[] | null {
  const cached = safeRead<{ questions: Question[] }>(
    DRAW_PREFIX + filterKey(filter),
  );
  if (!cached || !Array.isArray(cached.questions) || cached.questions.length === 0) {
    return null;
  }
  return cached.questions;
}

export function writeDrawCache(filter: string[], questions: Question[]): void {
  if (questions.length === 0) return;
  safeWrite(DRAW_PREFIX + filterKey(filter), {
    questions,
    at: Date.now(),
  });
}

export function readListCache(): Question[] | null {
  const cached = safeRead<{ questions: Question[] }>(LIST_KEY);
  if (!cached || !Array.isArray(cached.questions) || cached.questions.length === 0) {
    return null;
  }
  return cached.questions;
}

export function writeListCache(questions: Question[]): void {
  if (questions.length === 0) return;
  safeWrite(LIST_KEY, { questions, at: Date.now() });
}

export type CategoryCount = { category: string; count: number };

export function readCountsCache(): CategoryCount[] | null {
  const cached = safeRead<{ counts: CategoryCount[] }>(COUNTS_KEY);
  if (!cached || !Array.isArray(cached.counts)) return null;
  return cached.counts;
}

export function writeCountsCache(counts: CategoryCount[]): void {
  if (counts.length === 0) return;
  safeWrite(COUNTS_KEY, { counts, at: Date.now() });
}

export type CachedProfile = {
  displayName: string | null;
  handle: string | null;
  role: string;
  isAnonymous: boolean;
};

/**
 * Last signed-in header. The profile name is known data: paint it instantly
 * while `users.me` revalidates instead of flashing a skeleton. Cleared on
 * sign-out so a guest never sees the previous account's name.
 */
export function readProfileCache(): CachedProfile | null {
  const cached = safeRead<CachedProfile>(PROFILE_KEY);
  if (!cached || typeof cached !== "object") return null;
  return {
    displayName: typeof cached.displayName === "string" ? cached.displayName : null,
    handle: typeof cached.handle === "string" ? cached.handle : null,
    role: typeof cached.role === "string" ? cached.role : "user",
    isAnonymous: cached.isAnonymous === true,
  };
}

export function writeProfileCache(profile: CachedProfile): void {
  safeWrite(PROFILE_KEY, { ...profile, at: Date.now() });
}

export function clearProfileCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* cache is a nicety */
  }
}

/** Clear every filter's draw, plus the profile list and category counts. */
export function clearQuizCaches(): void {
  if (typeof window === "undefined") return;
  try {
    const keys = Array.from({ length: window.localStorage.length }, (_, i) =>
      window.localStorage.key(i),
    );
    for (const key of keys) {
      if (key && (key.startsWith(DRAW_PREFIX) || key === LIST_KEY || key === COUNTS_KEY)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* Storage may be unavailable. In-memory state is cleared separately. */
  }
}

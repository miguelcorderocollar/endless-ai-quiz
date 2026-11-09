import { rateLimitMessage } from "@shared/lib/answers/errors";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { router } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  ensureStats as ensureStatsRef,
  list as listRef,
  me as meRef,
  myCompleted as myCompletedRef,
  myRecent as myRecentRef,
  myStats as myStatsRef,
  population as populationRef,
  history as historyRef,
} from "@/lib/api";
import { forgetProfile, rememberProfile, resetProgress, saveDisplayName } from "@/lib/account";
import { convexClient } from "@/lib/backend";
import { toQuestions } from "@/lib/bank";
import { localBank } from "@/lib/localBank";
import { Popup } from "@/components/Popup";
import {
  hasHydratedCaches,
  readListCache,
  readProfileCache,
  subscribeCaches,
  writeListCache,
} from "@/lib/profileCache";
import {
  EMPTY_PROGRESS,
  getProgress,
  hasHydrated,
  hydrateProgress,
  subscribeProgress,
  updateProgress,
} from "@/lib/progress";
import { PencilIcon, ResetIcon, SignOutIcon } from "@/components/icons";
import { Distribution, EloChart, PANEL_HEIGHT } from "@/components/Stats";
import { DoneList } from "@/components/DoneList";
import { SyncStatus } from "@/components/SyncStatus";
import {
  getNetworkServerSnapshot,
  getNetworkSnapshot,
  startNetworkListener,
  subscribeNetwork,
} from "@/lib/network";
import { clearOutbox } from "@/lib/outbox";
import {
  readHistory,
  readPopulation,
  subscribeStats,
  writeHistory,
  writePopulation,
} from "@/lib/statsCache";
import type { Question } from "@shared/lib/questions/schema";
import { BOTTOM_INSET, colors, fonts, GUTTER, label } from "@/theme";

type Tab = "you" | "all";

/**
 * The web profile (`src/app/profile/page.tsx`), screen for screen: the identity
 * header with its three actions, the Elo block, the you / all-players tabs over
 * the chart and the distribution, then the browsable done list.
 *
 * Two sources of truth, and which one wins depends on sign-in state. A guest
 * sees device-local totals, because that is all they have (#2: guests play
 * instantly, zero friction, local Elo only). A signed-in player sees the
 * materialized server rollup (#34), which is the same numbers the web shows and
 * the ones that follow you between devices — the device cache is reconciled to
 * them on sign-in by `lib/account.ts`, so the two agree anyway. Reading the
 * local values here while signed in would be a lie the moment you used two
 * phones, so the branch is explicit.
 */
export default function ProfileScreen() {
  const local = useSyncExternalStore(
    subscribeProgress,
    hasHydrated() ? getProgress : () => EMPTY_PROGRESS,
    () => EMPTY_PROGRESS,
  );
  const cachedList = useSyncExternalStore(
    subscribeCaches,
    readListCache,
    readListCache,
  );
  const cachedProfile = useSyncExternalStore(
    subscribeCaches,
    readProfileCache,
    readProfileCache,
  );
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signOut } = useAuthActions();
  const client = convexClient();
  const [popup, setPopup] = useState<"name" | "reset" | null>(null);
  const [tab, setTab] = useState<Tab>("you");
  // Offline, Convex auth and every query hang instead of failing — auth never
  // settles and the hooks stay `undefined` until the socket connects. The web
  // page treats offline as settled and lets device-local progress carry the
  // screen; this subscribes to the same condition so a signed-in player on a
  // plane gets their chart frame and done list instead of skeletons.
  useEffect(() => {
    startNetworkListener();
  }, []);
  const online = useSyncExternalStore(
    subscribeNetwork,
    getNetworkSnapshot,
    getNetworkServerSnapshot,
  ).online;
  const offline = !online;
  // The measured plot box. Both tabs read it, so the chart and the histogram
  // are drawn into the same rectangle rather than each assuming one.
  const [plot, setPlot] = useState({ width: 0, height: 0 });

  const identity = useQuery(meRef, isAuthenticated ? {} : "skip");
  const stats = useQuery(myStatsRef, isAuthenticated ? {} : "skip");
  const completed = useQuery(myCompletedRef, isAuthenticated ? {} : "skip");
  const liveHistory = useQuery(historyRef, isAuthenticated ? {} : "skip");
  const livePopulation = useQuery(populationRef, {});
  const bank = useQuery(listRef, {});
  // Stale-while-revalidate for the two chart queries: the mirrors paint on
  // the first frame so a revisit never goes black-then-chart, and the live
  // values overwrite them (and the disk) when they land. Skeletons are only
  // for a true first run with nothing cached.
  const cachedHistory = useSyncExternalStore(
    subscribeStats,
    readHistory,
    readHistory,
  );
  const cachedPopulation = useSyncExternalStore(
    subscribeStats,
    readPopulation,
    readPopulation,
  );
  const history = liveHistory ?? cachedHistory;
  const population = livePopulation ?? cachedPopulation;

  useEffect(() => {
    if (liveHistory && liveHistory.length > 0) writeHistory(liveHistory);
  }, [liveHistory]);
  useEffect(() => {
    if (livePopulation) writePopulation(livePopulation);
  }, [livePopulation]);
  // Defensive fetch, not useQuery: if the backend predates myRecent, a missing
  // function would throw during render and take the whole screen down. The web
  // page does the same manual fetch for the same reason. Manual fetch lets us
  // fall back to the device-local ring instead of crashing.
  const [recent, setRecent] = useState<
    { questionId: string; correct: boolean; createdAt: number }[] | undefined
  >(undefined);
  const [recentUnsupported, setRecentUnsupported] = useState(false);
  useEffect(() => {
    if (!isAuthenticated || !client) {
      setRecent(undefined);
      setRecentUnsupported(false);
      return;
    }
    let cancelled = false;
    void client
      .query(myRecentRef, { limit: 100 })
      .then(
        (rows) => {
          if (!cancelled) setRecent(rows);
        },
        () => {
          if (!cancelled) {
            setRecent([]);
            setRecentUnsupported(true);
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [client, isAuthenticated]);

  useEffect(() => {
    void hydrateProgress();
  }, []);

  // Remember the last signed-in identity, so the profile header paints the name
  // on the next launch instead of a blank for the length of a query.
  useEffect(() => {
    if (identity) rememberProfile(identity);
  }, [identity]);

  // Signed in with events but no rollup: build it on demand, so the profile
  // never shows device-only totals while authenticated.
  useEffect(() => {
    if (isAuthenticated && stats === null && client) {
      void client.mutation(ensureStatsRef, {}).catch(() => {});
    }
  }, [isAuthenticated, stats, client]);

  // The bank, for the done list. The query first, the AsyncStorage snapshot
  // while it lands, and the bundled bank if neither is here — which is the
  // offline case, and the reason the app can show a done list on a plane.
  //
  // Parsing is memoised on `bank` alone and the cache write is an effect, which
  // is the only shape that works here. Writing inside the memo looks
  // equivalent and is not: `toQuestions` returns a *new* array every call, so
  // writing it replaces the cached list with a fresh identity, which
  // re-renders the `useSyncExternalStore` that owns it, which changes the memo's
  // input, which recomputes, which writes again. The result is an unbounded
  // render loop: the screen paints its first frame and then never responds to
  // anything again, because React is too busy retrying it. The web puts the
  // same write in an effect for the same reason.
  const liveBank = useMemo(() => (bank ? toQuestions(bank) : null), [bank]);
  const questions: Question[] =
    liveBank && liveBank.length > 0 ? liveBank : (cachedList ?? localBank());

  useEffect(() => {
    if (liveBank) writeListCache(liveBank);
  }, [liveBank]);

  // Server truth when signed in, device truth when not. `myStats` is null
  // before a player's first answer, so fall back to the device numbers for a
  // fresh account rather than showing zeros next to a seeded rating.
  const rating = isAuthenticated
    ? (stats?.rating ?? local.rating)
    : local.rating;
  const answered = isAuthenticated
    ? (stats?.answered ?? local.answered)
    : local.answered;
  const correct = isAuthenticated
    ? (stats?.correct ?? local.correct)
    : local.correct;
  const bestStreak = isAuthenticated ? (stats?.bestStreak ?? 0) : 0;
  const doneList = isAuthenticated
    ? (completed ?? local.completed)
    : local.completed;
  const anonymous =
    identity?.isAnonymous ?? cachedProfile?.isAnonymous ?? false;
  const displayMe = identity ?? cachedProfile;
  const name = displayMe?.displayName ?? displayMe?.handle ?? null;
  const guest = !isAuthenticated || anonymous;
  // Offline, auth never settles: `isLoading` stays true and the identity query
  // hangs, so gating the header on loading alone would leave a signed-in
  // player looking at a blank header for the whole flight. The web treats
  // offline as settled — a cached identity renders, otherwise the guest frame —
  // and this mirrors it exactly.
  const mePending = isAuthenticated && identity === undefined;
  const headerPending = !offline && (isLoading || mePending) && !displayMe;
  const showGuest = isLoading
    ? !displayMe || anonymous
    : guest;

  /**
   * Recent attempts, oldest first — the order they happened in, which is what
   * the done list is sorted by. Signed in it is the server event stream (so it
   * crosses devices); a guest it is the device-local ring.
   *
   * Both sources arrive newest-first and are flipped here rather than in
   * `buildDoneList`, so that function has one contract: record order.
   */
  const attempts = useMemo(() => {
    // Both sources arrive newest-first: `myRecent` is `.order("desc")` and the
    // ring is stored oldest-first. Flip each before the outer reverse, exactly
    // like the web page, so `buildDoneList` always gets record order.
    //
    // While the server stream is still loading (`recent === undefined`), use an
    // empty array rather than the device ring: the web does `(serverRecent ??
    // [])` for the same reason, so a signed-in player never flashes
    // device-local misses that the server is about to contradict. A backend
    // that predates `myRecent` sets `recentUnsupported`, and then the ring is
    // the honest fallback rather than a crash — with the caveat that the ring
    // is device-local, so right after signing in on a new phone it still shows
    // guest-era attempts until the server stream lands. The claim reconciles
    // totals, not the ring, and that is deliberate: the ring is this device's
    // history, not the account's.
    const source =
      isAuthenticated && !recentUnsupported
        ? (recent ?? []).map((r) => ({ id: r.questionId, correct: r.correct }))
        : local.recent
            .slice()
            .reverse()
            .map((r) => ({ id: r.id, correct: r.correct }));
    return source.reverse();
  }, [isAuthenticated, recentUnsupported, recent, local.recent]);

  const onPlot = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setPlot((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height },
    );
  }, []);

  const signOutAndLeave = useCallback(() => {
    forgetProfile();
    void signOut();
    router.replace("/");
  }, [signOut]);

  // Nothing to show until the progress store has been read: the whole screen is
  // built out of those numbers, and a frame at 1000/0/0 reads as a real record.
  if (!hasHydrated()) return null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.frame}>
          {/* No title on this bar. The screen is the profile — announced by
              the route, the Elo block and the done list — so a "Your profile"
              label is clutter, not orientation. The bar keeps the sync status
              and the way back, which are the two things that do something. */}
          <View style={styles.bar}>
            <View style={styles.barRight}>
              <SyncStatus />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back to the quiz"
                onPress={() =>
                  router.canGoBack() ? router.back() : router.replace("/")
                }
                hitSlop={12}
              >
                <Text style={styles.close}>close</Text>
              </Pressable>
            </View>
          </View>

        <ScrollView
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[label, styles.kicker]}>profile</Text>

          {headerPending ? null : showGuest ? (
            <View>
              <Text style={styles.guestTitle}>Playing as guest</Text>
              <Text style={styles.note}>
                Your Elo and done list live on this device only. Sign in to keep
                them on every device.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sign in"
                onPress={() => router.push("/account")}
                style={({ pressed }) => [
                  styles.primary,
                  styles.guestCta,
                  pressed && styles.primaryPressed,
                ]}
              >
                <Text style={styles.primaryLabel}>sign in</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.identity}>
              <View style={styles.identityRow}>
                <Text style={styles.name}>{name ?? "player"}</Text>
                <View style={styles.formActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Edit display name"
                    onPress={() => setPopup("name")}
                    hitSlop={12}
                  >
                    <PencilIcon stroke={colors.muted} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Reset progress"
                    onPress={() => setPopup("reset")}
                    hitSlop={12}
                  >
                    <ResetIcon stroke={colors.fail} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Sign out"
                    onPress={signOutAndLeave}
                    hitSlop={12}
                  >
                    <SignOutIcon stroke={colors.muted} />
                  </Pressable>
                </View>
              </View>
              {/* No handle here. It is the account's internal id — a player
                  recognises themselves by their name, and `handle` was noise
                  between the name and the Elo. The role marker stays, because
                  "admin" is something a reader needs and an opaque id is not. */}
              {displayMe?.role === "admin" ? (
                <Text style={[label, styles.handle]}>admin</Text>
              ) : null}
              {anonymous ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push("/account")}
                  style={styles.anonymousNote}
                >
                  <Text style={styles.anonymousLink}>
                    anonymous session — add an email to keep this →
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}

          <View style={styles.block}>
            <Text style={[label, styles.kicker]}>elo rating</Text>
            <Text style={styles.elo}>{rating}</Text>
              <Text style={[label, styles.subhead]}>
                {stats
                  ? `${stats.answered} answered · streak ${stats.streak} · best ${bestStreak}`
                  : isAuthenticated && !offline
                    ? "no answers yet on this account"
                    : "on this device only · sign in to sync"}
              </Text>

            <View style={styles.tabs}>
              {(["you", "all"] as const).map((t) => (
                <Pressable
                  key={t}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: tab === t }}
                  onPress={() => setTab(t)}
                  style={({ pressed }) => [
                    styles.tab,
                    tab === t && styles.tabActive,
                    pressed && tab !== t && styles.tabPressed,
                  ]}
                >
                  <Text
                    style={[
                      label,
                      tab === t ? styles.tabLabelActive : styles.tabLabel,
                    ]}
                  >
                    {t === "you" ? "you" : "all players"}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.chart} onLayout={onPlot}>
              {/* Skeletons need no measurement — fixed heights — so they paint
                  on the first frame instead of null. The old `width === 0`
                  gate left the panel black until layout landed, which is the
                  flash this whole cache exists to kill. */}
              {plot.width === 0 ? (
                tab === "you" ? (
                  <ChartSkeleton />
                ) : (
                  <DistributionSkeleton />
                )
              ) : tab === "you" ? (
                history === undefined && !offline ? (
                  isAuthenticated ? (
                    <ChartSkeleton />
                  ) : (
                    <EloChart
                      points={[]}
                      median={population?.median ?? null}
                      width={plot.width}
                      height={plot.height}
                    />
                  )
                ) : (
                  <EloChart
                    points={history ?? []}
                    median={population?.median ?? null}
                    width={plot.width}
                    height={plot.height}
                  />
                )
              ) : population === undefined && !offline ? (
                <DistributionSkeleton />
              ) : (
                <Distribution
                  buckets={population?.buckets ?? []}
                  count={population?.count ?? 0}
                  median={population?.median ?? null}
                  percentile={population?.percentile ?? null}
                  rating={isAuthenticated ? (stats?.rating ?? null) : null}
                  width={plot.width}
                />
              )}
            </View>
          </View>

          <View style={styles.block}>
            <Text style={[label, styles.kicker]}>done</Text>
            {!hasHydratedCaches() && questions.length === 0 ? (
              <Text style={styles.note}>Loading the bank…</Text>
            ) : (
              <DoneList
                bank={questions}
                completedIds={doneList}
                attempts={attempts}
                correct={correct}
                answered={answered}
                total={questions.length}
              />
            )}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Keep playing"
            onPress={() => router.replace("/")}
            style={({ pressed }) => [
              styles.keepPlaying,
              pressed && styles.keepPlayingPressed,
            ]}
          >
            <Text style={[label, styles.keepPlayingLabel]}>← keep playing</Text>
          </Pressable>

          <Text style={styles.footnote}>
            {isAuthenticated
              ? "Signed in. Your Elo, streak and done list are on the server."
              : "Progress is stored on this device only. No account, no leaderboard."}
          </Text>
        </ScrollView>
      </View>

      {popup === "name" && !guest && displayMe ? (
        <Popup
          label="profile"
          title="Display name"
          onClose={() => setPopup(null)}
        >
          <DisplayNameForm
            client={client}
            current={displayMe.displayName ?? ""}
            onSaved={() => setPopup(null)}
          />
        </Popup>
      ) : null}

      {popup === "reset" && !guest ? (
        <Popup
          label="danger zone"
          title="Reset progress?"
          onClose={() => setPopup(null)}
        >
          <ResetConfirm
            client={client}
            onCancel={() => setPopup(null)}
            onDone={() => {
              setPopup(null);
              clearOutbox();
              updateProgress({ ...EMPTY_PROGRESS });
              router.replace("/");
            }}
          />
        </Popup>
      ) : null}
    </SafeAreaView>
  );
}

function DisplayNameForm({
  client,
  current,
  onSaved,
}: {
  client: ReturnType<typeof convexClient>;
  current: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <View style={styles.form}>
      <TextInput
        value={name}
        onChangeText={setName}
        maxLength={40}
        placeholder="what should we call you"
        placeholderTextColor="rgba(111,117,128,0.5)"
        accessibilityLabel="Display name"
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save display name"
        accessibilityState={{ disabled: busy }}
        disabled={busy || client === null}
        onPress={() => {
          if (!client) return;
          setBusy(true);
          setError(null);
          void saveDisplayName(client, name).then(
            () => onSaved(),
            (cause: unknown) => {
              setBusy(false);
              setError(
                rateLimitMessage(cause) ?? (cause instanceof Error ? cause.message : "Could not save."),
              );
            },
          );
        }}
        style={({ pressed }) => [
          styles.primary,
          pressed && styles.primaryPressed,
        ]}
      >
        <Text style={styles.primaryLabel}>{busy ? "saving…" : "save"}</Text>
      </Pressable>
    </View>
  );
}

function ResetConfirm({
  client,
  onCancel,
  onDone,
}: {
  client: ReturnType<typeof convexClient>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <View style={styles.form}>
      <Text style={styles.note}>
        This deletes every answer you have given: Elo drops back to 1000, your
        streak, per-category accuracy, and done list are wiped. Your account,
        handle, and role stay.{" "}
        <Text style={styles.fail}>There is no undo.</Text>
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.formActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Yes, reset everything"
          accessibilityState={{ disabled: busy }}
          disabled={busy || client === null}
          onPress={() => {
            if (!client) return;
            setBusy(true);
            setError(null);
            void resetProgress(client).then(
              () => onDone(),
              (cause: unknown) => {
                setBusy(false);
                setError(
                  cause instanceof Error ? cause.message : "Could not reset.",
                );
              },
            );
          }}
          style={({ pressed }) => [
            styles.danger,
            pressed && styles.dangerPressed,
          ]}
        >
          <Text style={styles.dangerLabel}>
            {busy ? "resetting…" : "yes, reset everything"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          hitSlop={8}
        >
          <Text style={[label, styles.cancel]}>cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The chart and the distribution share one fixed visual height, the way the
 * web's `min-h-[340px]` tab panel does, so switching tabs never moves the done
 * list below.
 */
function ChartSkeleton() {
  return (
    <View style={styles.skeletonFrame}>
      {[88, 64, 76, 42].map((w, i) => (
        <View key={i} style={[styles.skeletonBar, { width: `${w}%` }]} />
      ))}
      <View style={styles.skeletonMedian} />
    </View>
  );
}

function DistributionSkeleton() {
  const bars = [
    34, 52, 44, 66, 58, 78, 70, 92, 84, 62, 48, 40, 30, 26, 20, 16, 12, 10, 8,
    6,
  ];
  return (
    // Same outer height as the real distribution, with the bars taking the
    // remainder: the skeleton stands in for the panel, so it must be the
    // panel's height or the swap-in shoves the done list down.
    <View style={styles.skeletonPanel}>
      <View style={styles.skeletonHistogram}>
        {bars.map((h, i) => (
          <View
            key={i}
            style={{
              height: `${h}%`,
              flex: 1,
              backgroundColor: "rgba(242,239,233,0.07)",
            }}
          />
        ))}
      </View>
      <Text style={styles.note}>Loading the field…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ink },
  frame: { flex: 1, paddingHorizontal: GUTTER, paddingBottom: BOTTOM_INSET },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.inkLine,
  },
  barRight: { flexDirection: "row", alignItems: "center", gap: 16 },
  close: { ...label, color: colors.muted },
  body: { paddingTop: 24, paddingBottom: 32 },

  kicker: { color: colors.muted },
  guestTitle: {
    fontFamily: fonts.display,
    fontSize: 30,
    color: colors.paper,
    marginTop: 12,
  },
  guestCta: { marginTop: 32, alignSelf: "flex-start" },

  identity: { marginTop: 12 },
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  name: {
    fontFamily: fonts.display,
    fontSize: 30,
    color: colors.paper,
    flexShrink: 1,
  },
  actions: { flexDirection: "row", alignItems: "center", gap: 16 },
  handle: { color: colors.muted, marginTop: 8 },
  anonymousNote: { marginTop: 8, alignSelf: "flex-start", paddingVertical: 4 },
  anonymousLink: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    color: colors.signal,
  },

  block: {
    marginTop: 32,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.inkLine,
    paddingTop: 24,
  },
  elo: {
    fontFamily: fonts.display,
    fontSize: 64,
    lineHeight: 72,
    color: colors.paper,
    marginTop: 8,
  },
  subhead: { color: colors.muted, marginTop: 16 },

  tabs: { flexDirection: "row", gap: 12, marginTop: 32 },
  tab: {
    borderWidth: 1,
    borderColor: colors.inkLine,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  tabActive: { borderColor: colors.signal, backgroundColor: colors.signal },
  tabPressed: { borderColor: colors.signal },
  tabLabel: { color: colors.muted },
  tabLabelActive: { color: colors.ink },
  // The max height both plots adapt to: the chart draws into this exact box,
  // the histogram fills whatever its axis and caption leave of it.
  chart: { marginTop: 12, height: PANEL_HEIGHT },

  skeletonFrame: {
    height: PANEL_HEIGHT,
    borderWidth: 1,
    borderColor: colors.inkLine,
    padding: 16,
    justifyContent: "space-between",
  },
  skeletonBar: { height: 2, backgroundColor: "rgba(242,239,233,0.07)" },
  skeletonMedian: { height: 3, backgroundColor: "rgba(214,255,63,0.3)" },
  skeletonHistogram: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 3,
  },
  skeletonPanel: { height: PANEL_HEIGHT },

  primary: {
    alignSelf: "flex-start",
    backgroundColor: colors.signal,
    borderWidth: 1,
    borderColor: colors.signal,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  primaryPressed: { backgroundColor: colors.paper, borderColor: colors.paper },
  primaryLabel: { ...label, color: colors.ink },
  danger: {
    alignSelf: "flex-start",
    backgroundColor: colors.fail,
    borderWidth: 1,
    borderColor: colors.fail,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  dangerPressed: { backgroundColor: colors.paper, borderColor: colors.paper },
  dangerLabel: { ...label, color: colors.ink },
  cancel: { color: colors.muted },

  form: { gap: 16 },
  input: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.paper,
    backgroundColor: "transparent",
    borderBottomWidth: 1,
    borderBottomColor: colors.inkLine,
    paddingVertical: 6,
  },
  error: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.fail,
  },
  formActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },

  keepPlaying: { marginTop: 40, alignSelf: "flex-start", paddingVertical: 8 },
  keepPlayingPressed: { opacity: 0.6 },
  keepPlayingLabel: { color: colors.muted },
  note: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 22,
    color: colors.muted,
    marginTop: 16,
    maxWidth: 420,
  },
  footnote: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 20,
    color: colors.muted,
    marginTop: 24,
  },
  fail: { color: colors.fail },
});

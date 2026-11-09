/**
 * Service worker: the app shell, nothing else.
 *
 * The quiz is already offline-tolerant without us. `bankCache.ts` persists the
 * drawn page and the published list to localStorage, and `QuizFromConvex`
 * paints that snapshot on a cold start and swallows the draw failure when the
 * network is gone. So the only missing piece to make an installed app launch
 * on a plane is the HTML plus the JS chunks it points at. That is exactly what
 * this file caches, and nothing else.
 *
 * What this deliberately does NOT touch, because caching it would corrupt the
 * app rather than help it:
 *
 * - Convex (`*.convex.cloud`) and the auth domain. Cross-origin, so it never
 *   reaches a handler. Queries and mutations stay live-or-fail, and the app's
 *   own fallbacks decide what a failure looks like.
 * - RSC payloads (`?_rsc=`). Next's client-side navigation is versioned
 *   against the bundle that requested it. Serving a stale payload breaks the
 *   router in ways that are very hard to debug, so they go to the network.
 * - Anything non-GET, or carrying a `Range` header.
 *
 * Two caching strategies, chosen by what each URL means:
 *
 * - Documents (navigations): network-first with a short timeout. A cached
 *   Next HTML page pins the exact content-hashed chunk names it was built
 *   with, so serving it while online is how you get a white screen after a
 *   deploy. Network-first means you only ever read stale HTML when you are
 *   actually offline, and the chunks it names are the chunks in the cache.
 * - Static assets (content-hashed chunks, images, fonts): cache-first. The
 *   hash in the filename is the cache key, so a hit is always correct.
 *
 * `VERSION` is the cache key. `sw.js` is served from `public/`, so Next does
 * not fingerprint it and a deploy will not retire the old caches on its own.
 * Bump VERSION by hand when the shell needs to be rebuilt from scratch; normal
 * deploys need nothing, because the new SW activates after the old clients
 * close and simply repopulates.
 */

const VERSION = "v2";
const SHELL_CACHE = `endless-ai:shell:${VERSION}`;
const ASSET_CACHE = `endless-ai:assets:${VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];

/**
 * The prerendered routes, precached up front. Not just `/`: the manifest's
 * shortcuts point at `/categories` and `/profile`, so a long-press on the home
 * screen icon has to work on a plane, and `npm run build` marks every one of
 * these as static so each is a single cacheable document.
 *
 * Individual `add` calls rather than `addAll`, because one 404 during install
 * would otherwise throw away the whole precache and leave the app with no
 * offline shell at all.
 */
const ROUTES = ["/", "/categories", "/profile"];
// `/bank.json` is the offline fallback bank (#17): a stable-URL snapshot of
// the validated content, generated on every build. It is precached by name,
// which is the whole reason it is a file instead of hashed chunks.
const PRECACHE = [...ROUTES, "/manifest.webmanifest", "/bank.json"];

/** How long a cold navigation waits on the network before trying the cache. */
const NAV_TIMEOUT_MS = 3000;

/** Only reached on a first-ever visit with no network and no cache. */
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Endless AI</title>
<style>
  html { color-scheme: dark; }
  body {
    margin: 0; min-height: 100dvh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 12px; padding: 24px;
    background: #0a0b0d; color: #f2efe9;
    font-family: system-ui, -apple-system, sans-serif; text-align: center;
  }
  h1 { font-family: Georgia, serif; font-size: 2rem; font-weight: 400; margin: 0; }
  p { color: #6f7580; font-size: 0.875rem; line-height: 1.6; max-width: 22rem; margin: 0; }
</style>
</head>
<body>
  <h1>Endless <span style="color:#d6ff3f">AI</span></h1>
  <p>You have not played here yet, so there is nothing saved on this device.
     Connect once and the quiz will work offline after that.</p>
</body>
</html>`;

/** Extension and prefix match for URLs safe to serve cache-first. */
const STATIC_PREFIXES = ["/_next/static/", "/_next/image", "/icons/"];
const STATIC_EXTENSIONS = [
  ".png",
  ".svg",
  ".ico",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".woff",
  ".woff2",
  ".ttf",
  ".webmanifest",
  // `/bank.json` is already precached by name (see PRECACHE), so this only
  // matters for fetches that miss the shell cache — belt and braces.
  ".json",
  ".txt",
];

function isStaticAsset(url) {
  if (STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return true;
  return STATIC_EXTENSIONS.some((ext) => url.pathname.endsWith(ext));
}

/**
 * Fetches with a deadline without aborting the underlying request. Aborting on
 * timeout would also kill a response that was already streaming to the page,
 * truncating a navigation that was about to succeed. Racing instead leaves a
 * request in flight that nobody reads, which is cheap; a half-rendered page is
 * not.
 */
function fetchWithTimeout(request, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([fetch(request), deadline]).finally(() => clearTimeout(timer));
}

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * The cached document for this URL, or the cached `/` for any route we did not
 * precache. Falling back to `/` rather than the offline page is deliberate: a
 * wrong-but-working shell beats a correct dead end, and every route is
 * prerendered so `/` at least boots.
 */
async function cachedDocument(request) {
  const cache = await caches.open(SHELL_CACHE);
  return (await cache.match(request)) ?? (await cache.match("/")) ?? offlineResponse();
}

async function handleDocument(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetchWithTimeout(request, NAV_TIMEOUT_MS);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return cachedDocument(request);
  }
}

async function handleAsset(request) {
  // Global lookup, not the asset cache alone: precached entries live in the
  // shell cache (`/bank.json` among them), and a hit there is as good as one
  // here. Only same-origin static assets ever reach this function, so the
  // global search cannot surface anything it should not.
  const hit = await caches.match(request);
  if (hit) return hit;
  const cache = await caches.open(ASSET_CACHE);
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

/**
 * The bundled bank is the one asset whose content changes without the shell
 * changing: a content-only deploy leaves `sw.js` byte-identical, so no
 * reinstall happens and a cache-first read would serve the old bank
 * indefinitely — on exactly the path that serves content directly (offline
 * first run). Network-first with cache fallback: online players always get
 * the fresh bank, offline players get the last precached one, and a device
 * that never cached it gets a network error the client already handles as an
 * empty bank.
 */
async function handleBankJson(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetchWithTimeout(request, NAV_TIMEOUT_MS);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    return Response.error();
  }
}

/**
 * Warms the asset cache from the precached HTML.
 *
 * Without this there is a one-visit hole. The worker installs and precaches
 * the routes, then claims the page it was registered from — but that page
 * fetched its chunks *before* it was controlled, so those requests never passed
 * through the cache. Go offline on the next launch and the HTML loads from
 * cache while every script 404s, which is worse than having no worker at all.
 *
 * So the activation step reads each shell we just precached, pulls out the
 * `/_next/static/...` URLs it references (scripts, styles, and the font files
 * `next/font` preloads, which are also under that prefix), and fetches them
 * into the asset cache itself. Every route, because each prerendered document
 * pulls in its own page chunk.
 */
async function warmAssetCache() {
  const shell = await caches.open(SHELL_CACHE);
  const assets = await caches.open(ASSET_CACHE);

  const urls = new Set();
  for (const route of ROUTES) {
    const html = await shell.match(route);
    if (!html) continue;
    for (const match of (await html.text()).matchAll(/\/_next\/static\/[A-Za-z0-9._~%/-]+/g)) {
      urls.add(match[0]);
    }
  }
  if (urls.size === 0) return;

  await Promise.all(
    [...urls].map(async (path) => {
      const request = new Request(path, { credentials: "same-origin" });
      if (await assets.match(request)) return;
      try {
        const response = await fetch(request);
        if (response.ok) await assets.put(request, response);
      } catch {
        /* one missing chunk should not abandon the rest */
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
      // No skipWaiting. Letting the waiting worker sit until the last old tab
      // closes means a deploy swaps the whole shell at once. Taking over
      // mid-session would leave a page running the previous bundle while its
      // router fetched next-build RSC payloads from the new one.
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("endless-ai:") && !CURRENT_CACHES.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
      await warmAssetCache();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);
  // Convex, the auth domain, anything third-party: not ours to serve stale.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleDocument(request));
    return;
  }
  if (url.pathname === "/bank.json") {
    event.respondWith(handleBankJson(request));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(handleAsset(request));
  }
  // Anything else falls through to the browser's default handling: network,
  // no cache, no interference.
});

/**
 * Taking over mid-session is refused by default (see the install note), so
 * the page has to ask for it. The only sender is the update prompt's apply
 * button, after the player has been told a reload is coming.
 */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

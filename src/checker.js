// Availability checks for TikTok & Instagram usernames.
//
// Strategy (in order):
//   1. Render the profile page in a real headless browser (most reliable -
//      TikTok runs JS challenges that plain HTTP fails).
//   2. Fall back to plain HTTP probes if no browser is available.
//   3. Last resort for TikTok: search-engine lookup (only proves "taken").
//
// Statuses: 'free' | 'taken' | 'unknown' (unknown = blocked/throttled).

import { withPage } from './browser.js';

export const FREE = 'free';
export const TAKEN = 'taken';
export const UNKNOWN = 'unknown';

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map(); // "platform:name" -> { status, at }

/* Start checks a bit apart per platform: firing several at once is what
   triggers TikTok/Instagram rate limits (results come back as "unknown").
   The gap adapts to how the site is reacting: throttled -> back off,
   clean answers -> speed back up. Long runs (deep hunts) stay healthy. */
const BASE_GAP = { tiktok: 800, instagram: 1000 };
const gates = {
  tiktok: { next: 0, gap: BASE_GAP.tiktok },
  instagram: { next: 0, gap: BASE_GAP.instagram },
};
function stagger(platform) {
  const g = gates[platform];
  if (!g) return Promise.resolve();
  const now = Date.now();
  const at = Math.max(now, g.next);
  g.next = at + g.gap;
  const wait = at - now;
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}
/* A platform that keeps answering "unknown" is being throttled. Hammering it
   burns the whole time budget and turns EVERY name into "unknown" (the user
   then sees zero results), so after a streak of misses we cool it down and
   skip it for a while. Names can still be decided by the other platform, and
   the cooled one is retried once the cooldown passes. */
const COOLDOWN_AFTER = 5; // consecutive unknowns
const COOLDOWN_MS = 60_000;
const streaks = { tiktok: 0, instagram: 0 };
const cooledUntil = { tiktok: 0, instagram: 0 };

/** ms left before this platform accepts checks again (0 = healthy). */
export function platformCooldown(platform) {
  const until = cooledUntil[platform] || 0;
  return Math.max(0, until - Date.now());
}

function noteOutcome(platform, status) {
  const g = gates[platform];
  if (!g) return;
  if (status === UNKNOWN) {
    g.gap = Math.min(3500, g.gap * 1.5);
    streaks[platform] += 1;
    if (streaks[platform] >= COOLDOWN_AFTER) {
      cooledUntil[platform] = Date.now() + COOLDOWN_MS;
      streaks[platform] = 0;
      console.error(`[throttle] ${platform} is answering junk - cooling down ${COOLDOWN_MS / 1000}s`);
    }
    return;
  }
  g.gap = Math.max(BASE_GAP[platform], g.gap * 0.85);
  streaks[platform] = 0;
  cooledUntil[platform] = 0;
}

/* ------------------------------------------------------------------ */
/* Username rules                                                       */
/* ------------------------------------------------------------------ */

export const RULES = {
  tiktok: {
    label: 'TikTok',
    min: 2,
    max: 24,
    pattern: /^[a-zA-Z0-9._]+$/,
    validate(name) {
      if (name.length < this.min || name.length > this.max) return false;
      if (!this.pattern.test(name)) return false;
      if (name.startsWith('.') || name.endsWith('.')) return false;
      if (name.includes('..')) return false;
      if (/_{2,}|\.__|__\./.test(name)) return false;
      return true;
    },
  },
  instagram: {
    label: 'Instagram',
    min: 1,
    max: 30,
    pattern: /^[a-zA-Z0-9._]+$/,
    validate(name) {
      if (name.length < this.min || name.length > this.max) return false;
      if (!this.pattern.test(name)) return false;
      if (name.startsWith('.') || name.endsWith('.')) return false;
      if (name.includes('..')) return false;
      return true;
    },
  },
};

export const ALL_PLATFORMS = ['tiktok', 'instagram'];

const clean = (u) => String(u || '').trim().replace(/^@+/, '');

/* ------------------------------------------------------------------ */
/* Browser-based detection                                              */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DEBUG = !!process.env.DEBUG_CHECK;

// The page can render in the machine's locale, so match the "not found"
// message in the languages our users are likely to see.
const TT_NOT_FOUND =
  /couldn'?t find this account|تعذر العثور على هذا الحساب|لا يمكن العثور على هذا الحساب/i;
const IG_NOT_FOUND =
  /Profile isn'?t available|Page Not Found|Sorry, this page|الملف الشخصي غير متاح|هذه الصفحة غير متاحة/i;

async function safeContent(page) {
  for (let i = 0; i < 5; i += 1) {
    try {
      const html = await page.content();
      if (html) return html;
    } catch {
      /* navigation destroyed the context - retry */
    }
    await sleep(300);
  }
  return '';
}

async function safeText(page) {
  try {
    return (await page.evaluate(() => document.body?.innerText || '')) || '';
  } catch {
    return '';
  }
}

async function safeTitle(page) {
  try {
    return (await page.title()) || '';
  } catch {
    return '';
  }
}

/** Are we actually on the requested profile URL (not a login/challenge page)? */
function onProfileUrl(page, platform, name) {
  try {
    const u = page.url().toLowerCase();
    const n = String(name).toLowerCase();
    return platform === 'tiktok'
      ? u.startsWith(`https://www.tiktok.com/@${n}`)
      : u.startsWith(`https://www.instagram.com/${n}`);
  } catch {
    return false;
  }
}

/* Interstitial pages (login walls, challenges, consent screens) are what a
   throttled visitor gets - they must never be read as "profile is missing". */
const INTERSTITIAL = /\/accounts\/login|\/challenge|\/consent|\/checkpoint|\/captcha/i;

/* ------------------------------------------------------------------ */
/* Control profile: is our view of the site healthy at all?            */
/*                                                                     */
/* If a KNOWN-TAKEN profile also looks "not available" to us, then the */
/* site is serving us junk (throttling / IP block) - every FREE verdict */
/* becomes untrustworthy and is downgraded to UNKNOWN. This is the main */
/* guard against handing the user a name that already belongs to someone.*/
/* ------------------------------------------------------------------ */

const CONTROL = { tiktok: 'nasa', instagram: 'instagram' };
const controlState = { tiktok: { ok: false, at: 0 }, instagram: { ok: false, at: 0 } };

async function controlHealthy(page, platform, currentName) {
  if (String(currentName).toLowerCase() === CONTROL[platform]) return true;

  const state = controlState[platform];
  if (Date.now() - state.at < 60_000) return state.ok;

  const url =
    platform === 'tiktok'
      ? `https://www.tiktok.com/@${CONTROL[platform]}`
      : `https://www.instagram.com/${CONTROL[platform]}/`;

  const probe = async () => {
    let html = '';
    await page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      .then(async () => {
        html = await safeContent(page);
      })
      .catch(() => {});
    const title = await safeTitle(page);
    const text = await safeText(page);

    return platform === 'tiktok'
      ? /"uniqueId":"nasa"/i.test(html) || /\(@nasa\)/i.test(title)
      : /profilePage_/.test(html) ||
        /property="og:description"/i.test(html) ||
        /\(@instagram\)|@instagram/i.test(title) ||
        /followers/i.test(text);
  };

  // One retry: a single stalled control load would otherwise mark the whole
  // view "unhealthy" for 60s and silently turn every FREE into UNKNOWN -
  // exactly the kind of thing that starved the inventory of hits.
  let isTaken = await probe();
  if (!isTaken) isTaken = await probe();

  state.ok = isTaken;
  state.at = Date.now();
  return state.ok;
}

async function detectTikTok(page, name, budgetMs = 20_000) {
  const started = Date.now();
  const url = `https://www.tiktok.com/@${encodeURIComponent(name)}`;
  let httpStatus = 0;
  await page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    .then((r) => {
      httpStatus = r?.status?.() || 0;
    })
    .catch(() => {});

  // "not available" is only believable while we sit on THIS profile page.
  const maybeFree = async () =>
    (await controlHealthy(page, 'tiktok', name)) ? FREE : UNKNOWN;

  const uniqueId = new RegExp(`"uniqueId":"${escapeRe(name)}"`, 'i');
  let freeStreak = 0;
  let titleStreak = 0;
  let reloaded = false;

  while (Date.now() - started < budgetMs) {
    // Login wall / captcha / challenge: no verdict here, and never "free".
    if (INTERSTITIAL.test(page.url())) {
      freeStreak = 0;
      titleStreak = 0;
      await sleep(600);
      continue;
    }

    const html = await safeContent(page);
    if (uniqueId.test(html)) return TAKEN;
    // TikTok's own payload verdict (0 = user exists, 10221 = does not exist).
    // On a GitHub runner the rendered text NEVER appears (hydration does not
    // paint there) while this payload answers within a second - so it is what
    // actually carries the check on a server, and a fast path locally too.
    const verdict = ttVerdictFrom(html, name);
    if (verdict === TAKEN) return TAKEN;

    // The document title is set much earlier than the rendered body text.
    // Guard with url + size checks so a stale title can't fool us.
    const title = await safeTitle(page);
    const onProfile = onProfileUrl(page, 'tiktok', name);
    if (onProfile && html.length > 100_000) {
      if (new RegExp(`\\(@${escapeRe(name)}\\)`, 'i').test(title)) return TAKEN;
      if (TT_NOT_FOUND.test(title)) {
        titleStreak += 1;
        if (titleStreak >= 2) return maybeFree();
      } else {
        titleStreak = 0;
      }
    }

    const text = await safeText(page);
    if (DEBUG) {
      console.error(
        `[tt:${name}] t=${Date.now() - started} html=${html.length} onProfile=${onProfile} ` +
          `status=${httpStatus} title="${title.slice(0, 50)}" notFound=${TT_NOT_FOUND.test(text)} ` +
          `body="${String(text).slice(0, 50).replace(/\s+/g, ' ')}"`
      );
    }
    // Same bar as the title path: we must still be on this profile page and
    // the page must have actually rendered (a half-loaded shell is not proof).
    // Evidence is either the visible "Couldn't find this account" line OR the
    // server payload saying "user not exist" - the latter is what a GitHub
    // runner can actually see (its rendered text stays empty).
    const freeEvidence = TT_NOT_FOUND.test(text) || verdict === FREE;
    if (onProfile && html.length > 50_000 && freeEvidence) {
      freeStreak += 1;
      // Require the message to persist after the page had time to load,
      // so we never report "free" off a half-rendered shell.
      if (freeStreak >= 3 && Date.now() - started >= 3000) return maybeFree();
    } else if (text.trim().length > 200 && verdict !== FREE) {
      // Real content that is NOT the not-found line contradicts "free" ->
      // reset. An EMPTY body does not contradict anything: TikTok re-renders
      // and the message flaps in and out, which used to turn a plainly free
      // name into "unknown" (and starved the inventory of hits).
      freeStreak = 0;
    }

    // Sometimes the first load stalls with a blank body - reloading is
    // much cheaper than failing the whole check and retrying from scratch.
    if (!reloaded && Date.now() - started > 7000) {
      reloaded = true;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      continue;
    }

    await sleep(400);
  }
  return UNKNOWN;
}

async function detectInstagram(page, name, budgetMs = 16_000) {
  const started = Date.now();
  const url = `https://www.instagram.com/${encodeURIComponent(name)}/`;
  // Carry the owner's session (if any, repo secret IG_SESSION): Instagram
  // only serves profile pages to logged-in visitors from datacenter IPs -
  // without it every check lands on the login wall and can only be "unknown".
  if (IG_SESSION) {
    await page
      .setCookie({
        name: 'sessionid',
        value: IG_SESSION,
        domain: '.instagram.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      })
      .catch(() => {});
  }
  let httpStatus = 0;
  await page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    .then((r) => {
      httpStatus = r?.status?.() || 0;
    })
    .catch(() => {});

  // Instagram shows a "not available" style page to throttled visitors too,
  // so EVERY free verdict has to survive the control-profile check (a known
  // taken profile must still render as taken, or our whole view is junk).
  // Note: Instagram answers with HTTP 200 in most regions, so the hard proof
  // here is the rendered "Profile isn't available" text + sane control, both
  // of which must then be reproduced by the second confirmation pass.
  const maybeFree = async () =>
    (await controlHealthy(page, 'instagram', name)) ? FREE : UNKNOWN;

  let freeStreak = 0;
  let titleStreak = 0;

  while (Date.now() - started < budgetMs) {
    // Login wall / challenge / consent: never a "profile is missing" verdict.
    if (INTERSTITIAL.test(page.url())) {
      freeStreak = 0;
      titleStreak = 0;
      await sleep(600);
      continue;
    }

    const html = await safeContent(page);
    if (/profilePage_/.test(html) || /property="og:description"/i.test(html)) return TAKEN;

    const title = await safeTitle(page);
    const text = await safeText(page);
    const onProfile = onProfileUrl(page, 'instagram', name);

    // Instagram answers with a real HTTP 404 for profiles that never existed.
    if (httpStatus === 404 && IG_NOT_FOUND.test(`${title} ${text}`)) return maybeFree();

    if (onProfile && html.length > 100_000) {
      if (IG_NOT_FOUND.test(title)) {
        titleStreak += 1;
        if (titleStreak >= 2) return maybeFree();
      } else {
        titleStreak = 0;
      }
      if (/@/.test(title) && /instagram/i.test(title)) return TAKEN;
    }

    // Only trust the rendered "not available" text on the profile page itself
    // and only after it has been sitting there for a while.
    if (onProfile && html.length > 50_000 && IG_NOT_FOUND.test(text)) {
      freeStreak += 1;
      if (freeStreak >= 3 && Date.now() - started >= 3000) return maybeFree();
    } else if (text.trim().length > 200) {
      // Real content without the not-found line = contradiction -> reset.
      // An empty/half-rendered body is NOT a contradiction (Instagram and
      // TikTok both flap while re-hydrating), so it no longer wipes the
      // streak and turns a free name into "unknown".
      freeStreak = 0;
    }

    await sleep(400);
  }
  return UNKNOWN;
}

async function viaBrowser(name, platform, budget = 16_000) {
  return withPage(async (page) => {
    try {
      return platform === 'tiktok'
        ? await detectTikTok(page, name, budget)
        : await detectInstagram(page, name, budget);
    } catch {
      return UNKNOWN;
    }
  }); // null == browser unavailable
}

/* ------------------------------------------------------------------ */
/* HTTP fallbacks                                                       */
/* ------------------------------------------------------------------ */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function httpGet(url, options = {}, timeout = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      ...options,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
      },
    });
    const text = await res.text().catch(() => '');
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

/* Instagram: only a real HTTP 404 may ever mean "free". A 200 page without
   profile markers is NOT evidence - that is exactly the answer a throttled
   or JS-shelled visitor gets for an account that exists (it once produced a
   confident wrong ✅). Missing evidence can only ever mean UNKNOWN. */
async function viaHttpInstagram(name) {
  try {
    const { res, text } = await httpGet(`https://www.instagram.com/${encodeURIComponent(name)}/`, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-dest': 'document',
        'upgrade-insecure-requests': '1',
        ...(await igAuth()),
      },
    });
    if (res.status === 404) return FREE;
    if (res.status === 200 && /property="og:description"|profilePage_/i.test(text)) return TAKEN;
  } catch {
    /* fall through */
  }
  return UNKNOWN;
}

/** DuckDuckGo html search: a hit proves the profile exists. */
let searchNext = 0;
async function viaSearchTikTok(name) {
  // One search every few seconds - DDG throttles bursts hard.
  const now = Date.now();
  const at = Math.max(now, searchNext);
  searchNext = at + 4000;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));

  try {
    const q = encodeURIComponent(`site:tiktok.com/@${name}`);
    const { res, text } = await httpGet(`https://html.duckduckgo.com/html/?q=${q}`, {
      headers: { Referer: 'https://duckduckgo.com/' },
    });
    if (res.status === 429 || res.status === 202 || !res.ok) return UNKNOWN;

    const hrefs = [...text.matchAll(/class="result__a"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    const decoded = hrefs.map((h) => {
      try {
        const url = new URL(h.startsWith('//') ? `https:${h}` : h);
        return decodeURIComponent(url.searchParams.get('uddg') || h);
      } catch {
        return h;
      }
    });
    const profile = new RegExp(`tiktok\\.com/@${escapeRe(name)}(?:[/?#]|$)`, 'i');
    return decoded.some((d) => profile.test(d)) ? TAKEN : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/* ------------------------------------------------------------------ */
/* TikTok's own verdict, as served in the page payload                  */
/* ------------------------------------------------------------------ */

/* TikTok server-renders the answer into the HTML the app hydrates from:
     <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"> ... ["webapp.user-detail"]
   - an EXISTING profile comes back with statusCode 0 plus its user object
     (uniqueId included) -> proven taken;
   - a handle that does NOT exist comes back with statusCode 10221
     ("user not exist") and NO userInfo at all -> the free signal.
   Anything else (missing blob, another code, a JS shell) is not a verdict
   and must never be read as "free". Verified live from a GitHub runner:
   the visible page text there stays EMPTY forever (hydration never paints),
   while this payload answers correctly in ~0.3s. */
const TT_NOT_EXIST = [10202, 10221, 10222]; // seen: 10221 = "user not exist"
function ttVerdictFrom(html, name) {
  const m = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  let detail;
  try {
    detail = JSON.parse(m[1])?.['__DEFAULT_SCOPE__']?.['webapp.user-detail'];
  } catch {
    return null;
  }
  if (!detail || typeof detail.statusCode !== 'number') return null;
  const user = detail.userInfo?.user;
  if (detail.statusCode === 0 && user?.uniqueId) {
    return user.uniqueId.toLowerCase() === String(name).toLowerCase() ? TAKEN : null;
  }
  if (!user && TT_NOT_EXIST.includes(detail.statusCode)) return FREE;
  return null;
}

/* Is our view of TikTok healthy at all (plain HTTP flavour)? The control
   profile is a known-taken handle: if TikTok stops showing it to us, its
   "not found" answers cannot be trusted either - every FREE is withheld. */
async function controlAlive(platform) {
  if (platform !== 'tiktok') return false; // Instagram has no HTTP control
  const state = controlState.tiktok;
  if (Date.now() - state.at < 60_000) return state.ok;
  let ok = false;
  try {
    const { res, text } = await httpGet(
      `https://www.tiktok.com/@${CONTROL.tiktok}`,
      { headers: { Referer: 'https://www.tiktok.com/' } },
      8000
    );
    ok = Boolean(res.ok) && new RegExp(`"uniqueId":"${CONTROL.tiktok}"`, 'i').test(text);
  } catch {
    /* unhealthy for this minute */
  }
  state.ok = ok;
  state.at = Date.now();
  return ok;
}

/* Instagram, logged in (optional): Instagram redirects every request from a
   datacenter IP (GitHub runners, VPSes) to its login wall - profile pages are
   simply not served, so from a server the bot can only ever answer "unknown"
   for Instagram. Putting the owner's own session cookie here (repo secret
   IG_SESSION = the "sessionid" cookie value) makes Instagram answer normally
   even from a server. Use a SPARE account: automating with a session is
   against Instagram's terms and the account can be limited. Without it
   nothing breaks - Instagram just stays "unknown" and TikTok carries on.
   The cookie is re-validated once an hour against the control profile; an
   expired/garbage cookie is dropped instead of breaking the checks. */
const IG_SESSION = process.env.IG_SESSION || '';
const igSessionState = { at: 0, ok: false, probed: false };
async function igAuth() {
  if (!IG_SESSION) return {};
  const now = Date.now();
  if (!igSessionState.probed || now - igSessionState.at > 60 * 60_000) {
    igSessionState.at = now;
    igSessionState.probed = true;
    try {
      const { res, text } = await httpGet(
        `https://www.instagram.com/${CONTROL.instagram}/`,
        {
          headers: {
            Referer: 'https://www.instagram.com/',
            cookie: `sessionid=${IG_SESSION}`,
          },
        },
        10_000
      );
      // Profile markers only reach a logged-in visitor from a server IP, so
      // their presence means the session really works right now.
      igSessionState.ok =
        Boolean(res.ok) &&
        (/profilePage_/.test(text) || /property="og:description"/i.test(text));
      if (!igSessionState.ok) {
        console.warn('[ig] session cookie did not open the control profile - ignoring it');
      }
    } catch {
      /* network hiccup: keep the previous verdict */
    }
  }
  return igSessionState.ok ? { cookie: `sessionid=${IG_SESSION}` } : {};
}

/* Instagram over plain HTTP: only a POSITIVE profile marker counts, and only
   as "taken" (og:description / profilePage_ / the page's own username JSON).
   Instagram answers a throttled visitor with a generic shell that looks
   IDENTICAL to a missing profile, so "nothing found" can never mean free
   here - the browser decides that (it hydrates to "Profile isn't available"
   for handles that do not exist). */
let igScreenNext = 0;
async function screenIG(name) {
  const now = Date.now();
  const at = Math.max(now, igScreenNext);
  igScreenNext = at + 1200; // Instagram throttles far harder than TikTok
  if (at > now) await new Promise((r) => setTimeout(r, at - now));

  try {
    const { res, text } = await httpGet(
      `https://www.instagram.com/${encodeURIComponent(name)}/`,
      {
        headers: {
          Referer: 'https://www.instagram.com/',
          ...(await igAuth()),
        },
      },
      8000
    );
    if (res.ok) {
      if (/profilePage_/.test(text) || /property="og:description"/i.test(text)) return TAKEN;
      if (new RegExp(`"username":"${escapeRe(name)}"`, 'i').test(text)) return TAKEN;
    }
  } catch {
    /* throttled - the browser decides */
  }
  return UNKNOWN;
}

async function viaHttpTikTok(name) {
  try {
    const { res, text } = await httpGet(
      `https://www.tiktok.com/@${encodeURIComponent(name)}`,
      { headers: { Referer: 'https://www.tiktok.com/' } },
      8000
    );
    if (res.status === 404) return FREE;
    if (res.ok) {
      if (new RegExp(`"uniqueId":"${escapeRe(name)}"`, 'i').test(text)) return TAKEN;
      const v = ttVerdictFrom(text, name);
      // "free" over plain HTTP still needs our control profile to be visible,
      // otherwise we are looking at junk (WAF / edge node / shell page).
      if (v === TAKEN) return TAKEN;
      if (v === FREE && (await controlAlive('tiktok'))) return FREE;
    }
  } catch {
    /* WAF / network - try search */
  }
  return viaSearchTikTok(name);
}

const HTTP = { tiktok: viaHttpTikTok, instagram: viaHttpInstagram };

/* ------------------------------------------------------------------ */
/* Cheap reject screen                                                 */
/* ------------------------------------------------------------------ */

/* Most candidates are already taken, and a plain HTTP response can PROVE
   that for TikTok (the profile payload embeds "uniqueId":"<name>") in about a
   second - instead of a 15-second browser load. The same payload also proves
   the opposite: statusCode 10221 with no user object means "this handle does
   not exist". The verdict is always TikTok's own JSON, never guesswork from a
   missing marker, and the FREE answer is only trusted by checkUsername after
   a second independent read plus the control profile. Instagram is skipped on
   purpose - its HTTP 200s say nothing, which is exactly how a wrong ✅ once
   happened. */
let screenNext = 0;
async function screenTikTok(name) {
  if (process.env.HTTP_SCREEN === '0') return UNKNOWN;

  const now = Date.now();
  const at = Math.max(now, screenNext);
  screenNext = at + 400; // screens are cheap but still hit TikTok
  if (at > now) await new Promise((r) => setTimeout(r, at - now));

  try {
    const { res, text } = await httpGet(
      `https://www.tiktok.com/@${encodeURIComponent(name)}`,
      { headers: { Referer: 'https://www.tiktok.com/' } },
      8000
    );
    if (res.ok) {
      if (new RegExp(`"uniqueId":"${escapeRe(name)}"`, 'i').test(text)) return TAKEN;
      const v = ttVerdictFrom(text, name);
      if (v) return v;
    }
  } catch {
    /* WAF / network - the browser decides */
  }
  return UNKNOWN;
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {string} username
 * @param {'tiktok'|'instagram'} platform
 * @param {{fresh?: boolean, confirm?: boolean}} [opts]
 *   fresh:true   ignores the cache (double-checking)
 *   confirm:false skips the mandatory second pass (only for callers that
 *                already run their own delayed re-check, e.g. deep hunt)
 * @returns {Promise<'free'|'taken'|'unknown'>}
 */
export async function checkUsername(username, platform, opts = {}) {
  const name = clean(username);
  const rule = RULES[platform];
  if (!rule) throw new Error(`Unknown platform: ${platform}`);
  if (!rule.validate(name)) return UNKNOWN;

  const key = `${platform}:${name.toLowerCase()}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < (hit.ttl || CACHE_TTL)) return hit.status;

  // Throttled platform: it would only answer junk. Skip it cheaply instead of
  // burning the time budget - the caller can use the other platform and this
  // one is retried after the cooldown (nothing is cached for this answer).
  if (!opts.force && platformCooldown(platform) > 0) return UNKNOWN;

  // Solid verdicts over plain HTTP, straight from TikTok's own page payload:
  // a taken handle is rejected in about a second, and a handle the payload
  // calls "user not exist" is verified twice (fresh request) with the control
  // profile in the loop - so a FREE can be handed over in ~2s without ever
  // opening a browser. A disagreement between the two reads falls through to
  // the browser, which decides as always. TikTok only - Instagram's HTML says
  // nothing about a missing profile (a login wall looks identical to it).
  if (platform === 'tiktok' && !opts.fresh && !opts.confirming) {
    const screened = await screenTikTok(name);
    if (screened === TAKEN) {
      noteOutcome(platform, TAKEN);
      cache.set(key, { status: TAKEN, at: Date.now(), ttl: CACHE_TTL });
      return TAKEN;
    }
    if (screened === FREE) {
      await new Promise((r) => setTimeout(r, 1300));
      const again = await screenTikTok(name);
      if (again === FREE && (await controlAlive(platform))) {
        noteOutcome(platform, FREE);
        cache.set(key, { status: FREE, at: Date.now(), ttl: 15 * 60_000 });
        return FREE;
      }
    }
  }

  // Instagram: the only HTTP answer worth anything is the POSITIVE proof that
  // a profile exists (og:description / profilePage_ / its own username JSON).
  // That rejects taken candidates fast; everything else goes to the browser.
  if (platform === 'instagram' && !opts.fresh && !opts.confirming) {
    const screened = await screenIG(name);
    if (screened === TAKEN) {
      noteOutcome(platform, TAKEN);
      cache.set(key, { status: TAKEN, at: Date.now(), ttl: CACHE_TTL });
      return TAKEN;
    }
  }

  await stagger(platform);

  let status = await viaBrowser(name, platform);
  // Throttling is usually transient - one more try with a shorter budget.
  if (status === UNKNOWN) {
    await new Promise((r) => setTimeout(r, 1500));
    status = await viaBrowser(name, platform, 12_000);
  }

  if (status === null) {
    // No browser at all: plain HTTP probe (TikTok ends up at search).
    status = await HTTP[platform](name);
  } else if (status === UNKNOWN) {
    // The browser loaded the page but got no verdict: try the side doors.
    const rescued =
      platform === 'tiktok' ? await viaSearchTikTok(name) : await viaHttpInstagram(name);
    if (rescued !== UNKNOWN) status = rescued;
  }

  // Belt & braces: if the browser says "free" on Instagram, cross-check with
  // a plain HTTP request - profile markers there mean the name IS taken
  // (this only ever downgrades free -> taken, never the other way).
  if (status === FREE && platform === 'instagram') {
    const cross = await viaHttpInstagram(name);
    if (cross === TAKEN) status = TAKEN;
  }

  /* ---------------------------------------------------------------- *
   * The ONLY verdict that can hurt the user is "free" - a wrong one    *
   * hands them a name that is already registered. So "free" must be    *
   * reproduced on a brand-new page before we ever say it out loud;     *
   * anything that cannot be reproduced is downgraded and never shown   *
   * as available. "taken"/"unknown" cost nothing when they are wrong,  *
   * so they are never re-run (keeps the fast paths fast).              *
   * ---------------------------------------------------------------- */
  if (status === FREE && opts.confirm !== false && !opts.confirming) {
    await new Promise((r) => setTimeout(r, 1200));
    const again = await checkUsername(name, platform, {
      fresh: true,
      confirming: true,
    });
    if (again !== FREE) status = again === TAKEN ? TAKEN : UNKNOWN;
  }

  noteOutcome(platform, status);

  // Cache lifetimes: "unknown" means "retry later" (short), "taken" is
  // stable (long) - but a free name can be registered by someone else at
  // any moment, so never serve a stale "free" answer.
  const ttl = status === UNKNOWN ? 60_000 : status === FREE ? 15 * 60_000 : CACHE_TTL;
  cache.set(key, { status, at: Date.now(), ttl });
  return status;
}

/** Check one handle on the given platforms (in parallel). */
export async function checkOn(username, platforms, opts = {}) {
  const results = await Promise.all(
    platforms.map(async (p) => [p, await checkUsername(username, p, opts)])
  );
  return Object.fromEntries(results);
}

/** Run `fn` over items with bounded concurrency (keeps the page pool fed). */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

export function clearCache() {
  cache.clear();
}

export function emoji(status) {
  return status === FREE ? '✅' : status === TAKEN ? '❌' : '⚠️';
}

export function statusText(status) {
  return status === FREE
    ? 'غير محجوز (مؤكد مرتين)'
    : status === TAKEN
      ? 'محجوز'
      : 'مش مؤكد — مستبعد من النتايج';
}

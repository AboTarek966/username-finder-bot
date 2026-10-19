// Rolling inventory of verified-free handles.
//
// The user should never wait for a search: this module keeps checking names in
// the BACKGROUND while the bot is idle, so a "generate" tap can be answered
// from a warm buffer in a second - and only ever with names that survived the
// mandatory double verification (checker.js).
//
// One SHARED pool holds every hit (tagged with the type it really is). Serving
// prefers the exact requested type and then widens through that type's ladder,
// so a starving bucket (3-letter handles are all taken) can never block the
// others - the fill work also rotates over all types with the most recently
// requested one first. The pool is saved to disk so a bot restart keeps it.

import fs from 'node:fs';
import path from 'node:path';
import { generateCandidates, GEN_MODES } from './generator.js';
import {
  checkOn,
  FREE,
  TAKEN,
  ALL_PLATFORMS,
  RULES,
  mapPool,
  platformCooldown,
} from './checker.js';

const PARALLEL = Math.max(1, Number(process.env.CHECK_PARALLEL) || 4);
const PER_MODE = 16; // keep up to this many fresh names per type
const STALE_MS = 20 * 60_000; // a hit older than this is dropped and refilled
const WIDEN_AFTER = 8; // checks without a hit -> try the next type
const WAVE = Math.max(4, PARALLEL); // one batch: results stream in ~every 20s
const IDLE_SLEEP = 15_000; // every type full: rest so we stop burning quota
const SAVE_EVERY = 60_000;
const DATA_FILE = process.env.INVENTORY_FILE || 'data/inventory.json';

export const GEN_LADDER = {
  tri: ['tri', 'quasi3'],
  quad: ['quad', 'quasi4'],
  quasi3: ['quasi3', 'tri', 'quad'],
  quasi4: ['quasi4', 'quasi3', 'normal'],
  premium: ['premium', 'normal'],
  normal: ['normal', 'premium'],
};
const MODES = Object.keys(GEN_LADDER);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* [{ name, mode, freeOn, at }] - shared by every type. */
const pool = [];
const misses = new Map(); // mode -> { checks, step }
for (const mode of MODES) misses.set(mode, { checks: 0, step: 0 });

/* What the chats are asking for right now: the background checks only spend
   time on the platforms somebody actually wants. */
const demand = { platforms: [...ALL_PLATFORMS], priority: null };

const isFresh = (i) => Date.now() - i.at < STALE_MS;
const matchesDemand = (i) => i.freeOn.some((p) => demand.platforms.includes(p));

/* A request is answered ONLY by its exact type: pressing "ثلاثي" must hand
   over three-character names, never the widened "شبه ثلاثي" cousins - the
   ladder substitution is exactly what the user complained about ("choose
   quad, get quasi4"). The ladder still widens what the FILLER searches for
   in the background, but a widened name only ever answers its own button. */
function eligible(mode) {
  return pool
    .filter((i) => isFresh(i) && matchesDemand(i) && i.mode === mode)
    .sort((a, b) => b.at - a.at); // newest first
}

const countFor = (mode) => eligible(mode).length;

/* ------------------------------------------------------------------ */
/* Waiters: a generation request blocks here until the pool can answer  */
/* ------------------------------------------------------------------ */

const waiters = [];

function notify() {
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    const w = waiters[i];
    if (countFor(w.mode) >= w.need) {
      clearTimeout(w.timer);
      waiters.splice(i, 1);
      w.resolve();
    }
  }
}

/** Resolve when `count` fresh names exist for `mode`, or after `timeoutMs`. */
export function waitForInventory(mode, count, timeoutMs) {
  demand.priority = mode; // the filler works on THIS type first now
  // A fresh press restarts the search on the EXACT type: the previous
  // request's widening step must never answer this one.
  const miss = misses.get(mode);
  if (miss) {
    miss.step = 0;
    miss.checks = 0;
  }
  if (countFor(mode) >= count) return Promise.resolve();
  return new Promise((resolve) => {
    const w = { mode, need: count, resolve, timer: null };
    w.timer = setTimeout(() => {
      const at = waiters.indexOf(w);
      if (at >= 0) waiters.splice(at, 1);
      resolve();
    }, timeoutMs);
    waiters.push(w);
  });
}

/**
 * Hand `count` verified names to a chat (they leave the pool so the next
 * request gets fresh ones). Exact requested type first, newest first.
 */
export function takeFromInventory(mode, count, platforms) {
  const picked = eligible(mode)
    .filter((i) => i.freeOn.some((p) => platforms.includes(p)))
    .slice(0, Math.max(0, count));
  if (picked.length) {
    const used = new Set(picked.map((p) => p.name));
    for (let i = pool.length - 1; i >= 0; i -= 1) {
      if (used.has(pool[i].name)) pool.splice(i, 1);
    }
    for (const name of used) served.set(name, Date.now());
  }
  return picked;
}

/* Names handed to a chat must not come back on the next tap: remember them
   for a few hours and skip them while refilling. */
const served = new Map(); // name -> servedAt
function wasServed(name) {
  const at = served.get(name);
  if (!at) return false;
  if (Date.now() - at > 6 * 60 * 60_000) served.delete(name);
  return true;
}

export function setDemand(platforms) {
  if (Array.isArray(platforms) && platforms.length) demand.platforms = platforms;
}

/** Fresh exact-type count for a mode (diagnostics / tests). */
export function inventoryFill(mode) {
  return pool.filter((i) => isFresh(i) && i.mode === mode).length;
}

/* ------------------------------------------------------------------ */
/* Persistence: a restart must not cost the user a warm buffer         */
/* ------------------------------------------------------------------ */

function save() {
  try {
    const items = pool.filter(isFresh);
    if (!items.length) return;
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(items));
  } catch (err) {
    console.error('[inventory] save failed:', err?.message || err);
  }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(raw)) return;
    for (const i of raw) {
      if (
        i &&
        typeof i.name === 'string' &&
        // A persisted name must still be a legal handle on some platform -
        // kills any hand-edited or ancient junk before it can be served.
        (RULES.tiktok.validate(i.name) || RULES.instagram.validate(i.name)) &&
        GEN_LADDER[i.mode] &&
        Array.isArray(i.freeOn) &&
        isFresh(i)
      ) {
        // A platform claim is only honoured if THIS run earned it: old files
        // may still carry Instagram claims produced by an earlier, weaker
        // verification - never hand one out unverified (the pool is a
        // 20-minute buffer anyway, nothing is lost by dropping them).
        const freeOn = i.freeOn.filter((p) => p === 'tiktok');
        if (freeOn.length) pool.push({ name: i.name, mode: i.mode, freeOn, at: i.at });
      }
    }
  } catch {
    /* no file yet - start empty */
  }
  if (pool.length) console.log(`[inventory] restored ${pool.length} names from disk`);
}

/* ------------------------------------------------------------------ */
/* Background filling                                                  */
/* ------------------------------------------------------------------ */

let running = false;
let startedOnce = false;
let holds = 0; // interactive checks (manual check/scan/deep) hold the loop back
let rr = MODES.indexOf('normal'); // round-robin cursor (start on a productive type)

/** Interactive commands take priority: pause the background waves. */
export function holdInventory() {
  holds += 1;
}
export function releaseInventory() {
  holds = Math.max(0, holds - 1);
}

function pickWork() {
  const order = [];
  if (demand.priority) order.push(demand.priority);
  for (let i = 0; i < MODES.length; i += 1) {
    const mode = MODES[(rr + i) % MODES.length];
    if (!order.includes(mode)) order.push(mode);
  }
  const mode = order.find((m) => countFor(m) < PER_MODE);
  if (!mode) return null;
  rr = (MODES.indexOf(mode) + 1) % MODES.length;
  return { mode };
}

/* Which platform to fill with right now. A hit on EITHER requested platform
   answers a "both" request, so one is enough - and TikTok is the healthy,
   productive one (Instagram mostly answers "unknown" and costs ~30s a name,
   which is what starved the inventory). One platform per wave = twice the
   speed for the same result. */
function activePlatform() {
  const healthy = demand.platforms.filter((p) => platformCooldown(p) === 0);
  if (!healthy.length) return null;
  return healthy.includes('tiktok') ? 'tiktok' : healthy[0];
}

async function fillWave(mode) {
  const platform = activePlatform();
  if (!platform) return 0;

  const ladder = GEN_LADDER[mode] || [mode];
  const miss = misses.get(mode);
  // Somebody is waiting for THIS exact type right now -> never widen
  // mid-request: the button must deliver what it promised. Widening stays a
  // background/stock strategy for when nobody is waiting.
  const step = demand.priority === mode ? 0 : Math.min(ladder.length - 1, miss.step);
  const waveMode = ladder[step];

  const wave = generateCandidates(WAVE, { platform, mode: waveMode });

  const t0 = Date.now();
  let gained = 0;
  let checked = 0;
  await mapPool(wave, PARALLEL, async (name) => {
    if (wasServed(name)) return null;
    const res = await checkOn(name, [platform]);
    checked += 1;
    if (res[platform] === FREE && !pool.some((i) => i.name === name)) {
      pool.push({ name, mode: waveMode, freeOn: [platform], at: Date.now() });
      gained += 1;
      notify(); // serve a waiting request NOW, not at the end of the wave
    }
    return res;
  });

  console.log(
    `[inventory] ${mode} -> ${waveMode} @${platform}: ${checked} checked in ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s -> ${gained} free | pool=${pool.length}`
  );

  miss.checks += checked;
  if (gained > 0) miss.checks = 0;
  else if (miss.checks >= WIDEN_AFTER && step < ladder.length - 1) {
    miss.step = step + 1; // the requested type is dry -> widen
    miss.checks = 0;
  }
  return gained;
}

/* Accuracy upkeep: while everything is stocked, re-verify the OLDEST names
   instead of idling. A name someone registered in the meantime is dropped
   immediately; a name that is still free gets its timestamp renewed, so what
   we hand out is always freshly confirmed - not just "checked20 minutes ago".
   A single fresh pass is enough here: the name already survived two full
   verifications when it entered the pool. */
async function refreshOldest() {
  const platform = activePlatform();
  if (!platform || holds > 0 || !pool.length) return;
  const oldest = [...pool].sort((a, b) => a.at - b.at).slice(0, 2);
  for (const item of oldest) {
    // A renewed TikTok name already earned its double verification on the way
    // into the pool. An Instagram claim on a TikTok item is NEW evidence, so
    // it must survive the full reproduction pass - never one lucky read
    // (a single unconfirmed "free" here once became a "TikTok+Instagram"
    // label the user then found registered on Instagram).
    const res = await checkOn(item.name, [platform], {
      fresh: true,
      confirm: platform !== 'instagram',
    });
    const at = pool.indexOf(item);
    if (at < 0) continue;
    if (res[platform] === FREE) {
      item.at = Date.now();
      if (!item.freeOn.includes(platform)) item.freeOn.push(platform);
      console.log(`[inventory] refresh ${item.name}: still free -> renewed`);
    } else if (res[platform] === TAKEN) {
      pool.splice(at, 1);
      console.log(`[inventory] refresh ${item.name}: GONE (taken) -> dropped`);
    }
  }
}

async function loop() {
  let sinceSave = 0;
  while (running) {
    try {
      for (let i = pool.length - 1; i >= 0; i -= 1) {
        if (!isFresh(pool[i])) pool.splice(i, 1);
      }

      const work = pickWork();
      if (!work) {
        await refreshOldest(); // keep the stock honest while it is complete
        await sleep(IDLE_SLEEP);
        continue;
      }
      if (holds > 0 || activePlatform() === null) {
        await sleep(1500);
        continue;
      }
      await fillWave(work.mode);
      notify();

      if (Date.now() - sinceSave > SAVE_EVERY) {
        sinceSave = Date.now();
        save();
      }
    } catch (err) {
      console.error('[inventory] wave failed:', err?.message || err);
      await sleep(3000);
    }
  }
}

export function startInventory() {
  if (startedOnce) return;
  startedOnce = true;
  running = true;
  load();
  console.log('[inventory] background fill started');
  loop();
}

export function stopInventory() {
  running = false;
  save();
  for (const w of waiters) clearTimeout(w.timer);
  waiters.length = 0;
}

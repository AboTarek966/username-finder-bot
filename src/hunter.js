// Deep hunt: generate a large pool of candidates, check them, and only
// report handles that were confirmed free TWICE (fresh page, no cache).
//
// A single "free" answer can be a fluke (rate limit / half-rendered page),
// so a name only reaches the user after it passes a second, uncached check.

import { checkOn, FREE, UNKNOWN, mapPool } from './checker.js';
import { generateCandidates, variations, baseCombos } from './generator.js';

const BATCH = 4;
const CONFIRM_DELAY = 2000;

/**
 * @param {object} opts
 * @param {string} [opts.base] base word (null/'random' = fully random names)
 * @param {string} [opts.mode] generator mode when there is no base
 * @param {string[]} opts.platforms
 * @param {number} [opts.target] stop early after this many confirmed-free
 * @param {number} [opts.maxChecks] hard cap on checks performed
 * @param {(p:{checked:number,total:number,free:number,unknown:number})=>void} [opts.onProgress]
 */
export async function deepHunt(opts) {
  const {
    base,
    mode = 'normal',
    platforms,
    target = 6,
    maxChecks = 48,
    onProgress,
  } = opts;

  const platform = platforms[0];
  const withBase = !!base && !['random', 'عشوائي', 'عشوائى'].includes(base.toLowerCase());

  const pool = [];
  const seen = new Set();
  const push = (list) => {
    for (const n of list) {
      const k = n.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      pool.push(n);
    }
  };

  if (withBase) {
    // Realistic patterns around the word people care about, then filler.
    push(variations(base, { platform, limit: 20 }));
    push(baseCombos(base, { platform, count: 26 }));
    push(generateCandidates(24, { platform, mode: 'quasi3' }));
  } else {
    push(generateCandidates(maxChecks, { platform, mode }));
  }

  const targets = pool.slice(0, maxChecks);
  const free = [];
  let checked = 0;
  let unknown = 0;
  let flipped = 0;
  let stoppedEarly = false;

  // Wave 1 = names around the base word. Wave 2 = widen the net with random
  // names so the user still walks away with something usable.
  const queue = targets.slice();
  const totalBase = targets.length;
  let extra = [];
  let total = totalBase;

  while (queue.length && !stoppedEarly) {
    const batch = queue.splice(0, BATCH);

    const rows = await mapPool(batch, BATCH, async (name) => {
      const res = await checkOn(name, platforms);
      checked += 1;
      return { name, res };
    });

    for (const { name, res } of rows) {
      const freeOn = platforms.filter((p) => res[p] === FREE);
      if (freeOn.length === 0) {
        if (platforms.every((p) => res[p] === UNKNOWN)) unknown += 1;
        continue;
      }

      // --- confirmation pass: fresh page, cache bypassed ---
      await new Promise((r) => setTimeout(r, CONFIRM_DELAY));
      const again = await checkOn(name, platforms, { fresh: true });
      const confirmed = platforms.filter((p) => again[p] === FREE);

      if (confirmed.length) free.push({ name, platforms: confirmed });
      else flipped += 1; // said free once, then not - correctly filtered out
    }

    // Nothing found around the base word -> widen the net with random names.
    if (!queue.length && free.length === 0 && extra.length === 0) {
      extra = generateCandidates(12, { platform, mode }).filter(
        (n) => !seen.has(n.toLowerCase())
      );
      for (const n of extra) {
        seen.add(n.toLowerCase());
        queue.push(n);
      }
      total = totalBase + extra.length;
    }

    await onProgress?.({ checked, total, free: free.length, unknown });
    if (free.length >= target) stoppedEarly = true;
  }

  return { free, checked, total, unknown, flipped, stoppedEarly };
}

/** True when at least one platform has no browser + no working fallback. */
export function worstCaseNote(unknown) {
  return unknown > 0 ? `\n⚠️ ${unknown} يوزر طلع "متأكدش" (حظر مؤقت) — ممكن يكون فيهم متاح.` : '';
}

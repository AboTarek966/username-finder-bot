// Username candidate generator + variation builder.
// Produces handles that satisfy the platform rules in checker.js.

import { RULES } from './checker.js';

/* ------------------------------------------------------------------ */
/* Word pools                                                          */
/* ------------------------------------------------------------------ */

const WORDS = [
  'nova', 'zen', 'echo', 'flux', 'drift', 'pulse', 'orbit', 'vibe', 'frost', 'blaze',
  'shadow', 'ghost', 'pixel', 'turbo', 'rapid', 'cosmic', 'atomic', 'stellar', 'lunar', 'solar',
  'neon', 'crisp', 'swift', 'bold', 'epic', 'prime', 'ultra', 'hyper', 'mega',
  'sky', 'wave', 'storm', 'thunder', 'lightning', 'ember', 'ash', 'iron', 'steel', 'gold',
  'silver', 'ruby', 'onyx', 'jade', 'coral', 'ivory', 'velvet', 'silk', 'stone', 'river',
  'ocean', 'desert', 'forest', 'mountain', 'island', 'breeze', 'sunset', 'sunrise', 'midnight', 'dawn',
  'glow', 'shine', 'spark', 'flame', 'cloud', 'star', 'moon', 'comet', 'meteor',
  'knight', 'ronin', 'samurai', 'viking', 'ninja', 'wizard', 'titan', 'giant', 'legend', 'hero',
  'gamer', 'pro', 'ace', 'x', 'z', 'q', 'k', 'j', 'm', 'n',
];

// Short words keep 3- and 4-part names inside TikTok's 24 char limit.
const SHORT = [
  'zen', 'ace', 'fox', 'sky', 'jay', 'rex', 'ivy', 'ice', 'sun', 'moon', 'star', 'tide',
  'flow', 'rain', 'wind', 'fire', 'snow', 'bolt', 'dark', 'fast', 'wild', 'cool', 'epic',
  'king', 'lord', 'atom', 'volt', 'zap', 'orb', 'vex', 'hex', 'nova', 'flux', 'drift',
  'pulse', 'blaze', 'storm', 'swift', 'turbo', 'pixel', 'echo', 'vibe', 'wolf', 'hawk',
  'rose', 'lake', 'hill', 'dune', 'reef', 'glow', 'ark', 'zen', 'nyx', 'rei',
];

const PREFIXES = ['the', 'its', 'real', 'only', 'og', 'mr', 'dr', 'lord', 'captain'];
const SUFFIXES = ['hq', 'yt', 'tv', 'ig', 'tk', 'xd', 'gg', 'iq', 'zz', 'v2', 'x', 'z', 'pro'];
const SEPARATORS = ['_', '.', 'x', ''];

export const GEN_MODES = {
  normal: { label: 'عادي', desc: 'أسماء طويلة: كلمة + رقم (nova42, flame_orbit)' },
  quasi3: { label: 'شبه ثلاثي', desc: '4-5 أحرف: kr.1, ab12, z.x9' },
  tri: { label: 'ثلاثي', desc: '3 أحرف تمامًا: kr1, a.b, zx9' },
  quad: { label: 'رباعي', desc: '4 أحرف تمامًا: rh23, zx42, kr.x' },
  quasi4: { label: 'شبه رباعي', desc: '5-6 أحرف: rh234, ab.xy, kr.12' },
  premium: { label: 'مميز', desc: 'حروف وأرقام مميزة: zx.99, kz.zk, 0xkq7' },
};

export const MODE_KEYS = Object.keys(GEN_MODES);
/** Backwards-compatible alias list used by the CLI. */
export const STYLES = MODE_KEYS;

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const num = (max) => Math.floor(Math.random() * max);
const digits = () => String(10 + num(990));
const sep = () => rand(SEPARATORS) || '_';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const pick = (s) => s[Math.floor(Math.random() * s.length)];

/**
 * Short letter+digit handle of exactly `len` characters, e.g. kr1, rh23, kr.1.
 * `digits` = how many of the characters are digits; a single dot may replace a
 * middle character (never first/last - the platforms reject those).
 */
function shortName(len, { digits: digitCount = 1, dotChance = 0.3 } = {}) {
  const slots = Array.from({ length: len }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const digitSet = new Set(slots.slice(0, Math.min(digitCount, len)));
  const chars = Array.from({ length: len }, (_, i) =>
    digitSet.has(i) ? pick(DIGITS) : pick(LETTERS)
  );
  if (len >= 3 && Math.random() < dotChance) {
    const at = 1 + Math.floor(Math.random() * (len - 2));
    chars[at] = '.';
  }
  return chars.join('');
}

function build(mode) {
  const w = rand(WORDS);
  const w2 = rand(WORDS);

  switch (mode) {
    // --- short letter+digit handles: the ones people actually fight over ---
    case 'quasi3': {
      // almost-three: 4-5 characters, dots common -> kr.1, ab12, z.x9
      const len = num(2) === 0 ? 4 : 5;
      const digitCount = len === 4 ? 1 + num(2) : 1 + num(3);
      return shortName(len, { digits: digitCount, dotChance: 0.45 });
    }
    case 'tri': {
      // exactly 3 characters -> kr1, a.b, zx9
      return shortName(3, { digits: num(3), dotChance: 0.35 });
    }
    case 'quad': {
      // exactly 4 characters -> rh23, zx42, kr.x
      return shortName(4, { digits: 1 + num(2), dotChance: 0.2 });
    }
    case 'quasi4': {
      // almost-four: 5-6 characters -> rh234, ab.xy, kr.12
      const len = num(2) === 0 ? 5 : 6;
      return shortName(len, { digits: 1 + num(3), dotChance: 0.3 });
    }
    case 'premium': {
      // eye-catching letter+number mixes: doubles, mirrors, repeated digits.
      const L = () => pick(LETTERS);
      const D = () => pick(DIGITS);
      const DD = () =>
        rand(['99', '99', '99', '77', '00', '11', '88', `${D()}${D()}`]);
      const p = num(8);
      if (p === 0) return `${L()}${L()}.${DD()}`; // zx.99
      if (p === 1) return `${DD()}.${L()}${L()}`; // 99.kx
      if (p === 2) return `${L()}${L()}.${L()}${D()}`; // kx.q7
      if (p === 3) {
        const a2 = L();
        const b2 = L();
        return `${a2}${b2}.${b2}${a2}`; // mirror: kz.zk
      }
      if (p === 4) return `${L()}${L()}${DD()}.${L()}`; // zx99.q
      if (p === 5) return `0x${L()}${L()}${D()}`; // 0xkq7
      if (p === 6) {
        const c2 = L();
        return `${c2}${c2}.${DD()}`; // vv.99
      }
      return `${L()}${DD()}.${L()}${L()}`; // k99.qx
    }
    case 'normal':
    default: {
      const p = num(5);
      if (p === 0) return `${w}${num(99)}`;
      if (p === 1) return `${w}${sep()}${w2}`;
      if (p === 2) return `${rand(PREFIXES)}${sep()}${w}`;
      if (p === 3) return `${w}${rand(SUFFIXES)}`;
      return `${w}${10 + num(90)}`;
    }
  }
}

/**
 * @param {number} count
 * @param {{platform?: 'tiktok'|'instagram', mode?: string, style?: string}} opts
 * @returns {string[]}
 */
export function generateCandidates(count, opts = {}) {
  const { platform = 'tiktok' } = opts;
  // `style` kept as an alias so old CLI calls keep working.
  const mode = MODE_KEYS.includes(opts.mode)
    ? opts.mode
    : MODE_KEYS.includes(opts.style)
      ? opts.style
      : 'normal';
  const rule = RULES[platform];
  const out = new Set();
  const guard = count * (mode === 'quad' ? 200 : 80);

  for (let i = 0; out.size < count && i < guard; i += 1) {
    const name = build(mode).replace(/[^a-zA-Z0-9._]/g, '').toLowerCase();
    // Every generated name must carry a letter: Instagram refuses
    // numeric-only handles outright, and a digit-only typo-shape is useless
    // on TikTok too.
    if (/[a-z]/.test(name) && rule.validate(name)) out.add(name);
  }
  return [...out].slice(0, count);
}

/**
 * Build plausible variations of a base handle
 * e.g. "ahmad" -> ahmad, ahmad_, ahmad.x, theahmad, ahmadofficial, ...
 */export function variations(base, opts = {}) {
  const { platform = 'tiktok', limit = 20 } = opts;
  const rule = RULES[platform];
  const clean = base.replace(/[^a-zA-Z0-9._]/g, '').toLowerCase();
  if (!clean) return [];

  const ideas = [
    clean,
    `${clean}_`,
    `_${clean}`,
    `.${clean}`,
    `${clean}.`,
    `${clean}x`,
    `x${clean}`,
    `${clean}0`,
    `${clean}1`,
    `${clean}00`,
    `${clean}01`,
    `${clean}${10 + num(90)}`,
    `${clean}.${10 + num(90)}`,
    `${clean}_official`,
    `${clean}official`,
    `${clean}.official`,
    `${clean}_hq`,
    `${clean}hq`,
    `${clean}_yt`,
    `${clean}yt`,
    `${clean}_tv`,
    `${clean}gg`,
    `${clean}xd`,
    `the${clean}`,
    `its${clean}`,
    `real${clean}`,
    `og${clean}`,
    `${clean}iq`,
    `${clean}zz`,
    `${clean}v2`,
    `mr${clean}`,
    `${clean}_tk`,
    `${clean}tk`,
  ];

  const seen = new Set();
  const out = [];
  for (const name of ideas) {
    const v = name.replace(/[^a-zA-Z0-9._]/g, '');
    if (seen.has(v) || !rule.validate(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Deep pool of candidates built around one base word, e.g. "gamer" ->
 * gamer_x_fox, the.gamer.zen, gamer407, realgamer_hq ...
 * These are the patterns people actually pick, so the hit rate is much
 * better than pure random names.
 */
export function baseCombos(base, opts = {}) {
  const { platform = 'tiktok', count = 30 } = opts;
  const rule = RULES[platform];
  const clean = String(base || '').replace(/[^a-zA-Z0-9._]/g, '').toLowerCase();
  if (!clean) return [];

  const out = new Set();
  const guard = count * 50;

  for (let i = 0; out.size < count && i < guard; i += 1) {
    const w = rand(SHORT);
    const n2 = digits();
    const s = Math.random() < 0.7 ? '_' : '.';
    const p = num(9);
    let name;

    if (p === 0) name = `${clean}${s}${w}`;
    else if (p === 1) name = `${w}${s}${clean}`;
    else if (p === 2) name = `${clean}${s}${w}${s}${n2}`;
    else if (p === 3) name = `the${s}${clean}${s}${w}`;
    else if (p === 4) name = `${clean}${10 + num(990)}`;
    else if (p === 5) name = `${clean}x${w}`;
    else if (p === 6) name = `${clean}${s}${rand(SUFFIXES)}`;
    else if (p === 7) name = `${rand(PREFIXES)}${clean}`;
    else name = `${clean}${s}${n2}${s}${w}`;

    name = name.replace(/[^a-zA-Z0-9._]/g, '');
    if (rule.validate(name)) out.add(name);
  }
  return [...out].slice(0, count);
}

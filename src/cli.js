#!/usr/bin/env node
// CLI for testing without Telegram:
//   npm run check -- nasa zzzqqq123456xx
//   npm run check -- nasa insta
//   npm run gen -- 8 tiktok
//   npm run scan -- ahmad instagram

import { checkOn, emoji, statusText, RULES, FREE, mapPool } from './checker.js';
import { generateCandidates, variations, GEN_MODES, MODE_KEYS } from './generator.js';
import { deepHunt } from './hunter.js';
import { closeBrowser } from './browser.js';

const [cmd, ...args] = process.argv.slice(2);

function resolvePlatforms(arg) {
  if (arg === 'tiktok' || arg === 'tk') return ['tiktok'];
  if (arg === 'insta' || arg === 'ig' || arg === 'instagram') return ['instagram'];
  return ['tiktok', 'instagram'];
}

async function print(names, platforms) {
  const rows = await mapPool(names, 4, async (name) => {
    const res = await checkOn(name, platforms);
    const parts = platforms.map((p) => `${RULES[p].label}: ${emoji(res[p])} ${statusText(res[p])}`);
    const free = platforms.some((p) => res[p] === FREE);
    return `${free ? '🎯 ' : ''}@${name} -> ${parts.join(' | ')}`;
  });
  for (const row of rows) console.log(row);
}

if (cmd === 'check') {
  if (!args.length) {
    console.error('Usage: npm run check -- <username> [username...] [tiktok|insta]');
    process.exit(1);
  }
  const tail = args[args.length - 1].toLowerCase();
  const hasFlag = ['tiktok', 'tk', 'insta', 'ig', 'instagram'].includes(tail);
  const platforms = resolvePlatforms(tail);
  const names = hasFlag ? args.slice(0, -1) : args;
  await print(names, platforms);
} else if (cmd === 'gen') {
  const count = Math.min(Number(args[0]) || 8, 20);
  const mode = MODE_KEYS.includes(args[1])
    ? args[1]
    : MODE_KEYS.includes(args[2])
      ? args[2]
      : 'normal';
  const platform = ['insta', 'ig', 'instagram'].some((a) => args.includes(a))
    ? 'instagram'
    : 'tiktok';
  const candidates = generateCandidates(count, { platform, mode });
  console.log(
    `Generated ${candidates.length} candidates [${GEN_MODES[mode].label}] for ${RULES[platform].label}:`
  );
  await print(candidates, [platform]);
} else if (cmd === 'scan') {
  const base = args[0];
  if (!base) {
    console.error('Usage: npm run scan -- <base> [tiktok|insta]');
    process.exit(1);
  }
  const platforms = resolvePlatforms(args[1]);
  const list = variations(base, { platform: platforms[0], limit: 20 });
  console.log(`Variations of "${base}" (${list.length}):`);
  await print(list, [platforms[0]]);
} else if (cmd === 'deep') {
  const base = args.find(
    (a) =>
      !/^\d+$/.test(a) &&
      !MODE_KEYS.includes(a) &&
      !['tiktok', 'tk', 'insta', 'ig', 'instagram'].includes(a)
  );
  const mode = MODE_KEYS.find((m) => args.includes(m)) || 'normal';
  const flag = args.find((a) => ['tiktok', 'tk', 'insta', 'ig', 'instagram'].includes(a));
  const platforms = resolvePlatforms(flag);
  const target = Math.min(Number(args.find((a) => /^\d+$/.test(a))) || 4, 10);

  console.log(
    `Deep hunt: base="${base || 'random'}" mode=${GEN_MODES[mode].label} ` +
      `platforms=${platforms.join('+')} target=${target}`
  );
  const t0 = Date.now();
  const res = await deepHunt({
    base: base || null,
    mode,
    platforms,
    target,
    maxChecks: 30,
    onProgress: ({ checked, total, free }) =>
      process.stdout.write(`\r  ${checked}/${total} checked, ${free} free confirmed...`),
  });
  console.log(`\nChecked ${res.checked} names in ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const f of res.free) console.log(`🎯 @${f.name} -> ${f.platforms.join('+')} FREE (confirmed twice)`);
  if (!res.free.length) console.log('No confirmed-free names in this batch.');
  if (res.flipped) console.log(`${res.flipped} name(s) said free once, then not - filtered out.`);
} else {
  console.log('Commands: check | gen | scan | deep   (see package.json scripts)');
}

await closeBrowser().catch(() => {});
// Browser child processes can keep the event loop alive for a while.
setTimeout(() => process.exit(0), 300).unref();

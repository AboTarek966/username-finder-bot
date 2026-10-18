/* Round 3: run the REAL checker from a GitHub runner.
   Proves the fix end-to-end: known controls keep their verdict, and a wave of
   generated candidates now resolves (taken/free) instead of "unknown". */

import { checkUsername } from '../src/checker.js';
import { generateCandidates } from '../src/generator.js';

const ms = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

console.log('== known controls ==');
for (const [name, expect] of [
  ['nasa', 'taken'],
  ['zzzqqq123456xxplm9qqq', 'free'],
  ['8zzp0', 'free'],
]) {
  const t = Date.now();
  const s = await checkUsername(name, 'tiktok', { fresh: true });
  console.log(`CHECK ${name.padEnd(24)} -> ${s} (want ${expect}) in ${ms(t)}`);
}

console.log('== generated wave (quasi3, 10) ==');
const wave = generateCandidates(10, { platform: 'tiktok', mode: 'quasi3' });
let free = 0;
let taken = 0;
let unknown = 0;
const t0 = Date.now();
for (const name of wave) {
  const t = Date.now();
  const s = await checkUsername(name, 'tiktok', { fresh: true });
  if (s === 'free') free += 1;
  else if (s === 'taken') taken += 1;
  else unknown += 1;
  console.log(`WAVE ${name.padEnd(16)} -> ${s} in ${ms(t)}`);
}
console.log(
  `WAVE SUMMARY: ${wave.length} checked in ${ms(t0)} -> free=${free} taken=${taken} unknown=${unknown}`
);
process.exit(0);

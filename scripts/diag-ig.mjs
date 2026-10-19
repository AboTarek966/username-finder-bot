/* Temporary diagnostic - delete after reading.
 *
 * Question: can the production Instagram path say "free" for a name that is
 * actually registered? That wrong ✅ showed up as a "TikTok+Instagram" label.
 *
 * Every name below was verified by hand from a normal browser minutes ago:
 *   nasa / 8zzp0 / d0v.d / z17b -> REGISTERED on Instagram
 *   v7nkh / 0g4s3               -> free on Instagram
 *
 * This runs the exact call confirmInstagram makes (checkOn with fresh:true,
 * full double-verification) from a GitHub runner with the owner's session
 * cookie - i.e. the exact production conditions.
 */
import { checkOn } from '../src/checker.js';

const EXPECT = {
  nasa: 'taken',
  '8zzp0': 'taken',
  'd0v.d': 'taken', // a name the bot actually served (taken on IG)
  z17b: 'taken', // same - served + registered on IG
  v7nkh: 'free',
  '0g4s3': 'free',
};

console.log(`[diag] start ${new Date().toISOString()} ig_session=${process.env.IG_SESSION ? 'set' : 'MISSING'}`);

for (const [name, want] of Object.entries(EXPECT)) {
  const t = Date.now();
  const res = await checkOn(name, ['instagram'], { fresh: true }).catch((e) => ({
    instagram: 'ERR:' + (e?.message || e),
  }));
  const got = res?.instagram;
  console.log(`[diag] ${got === want ? 'OK  ' : 'FAIL'} ${name}: want=${want} got=${got} (${Date.now() - t}ms)`);
}

console.log('[diag] done');
process.exit(0);

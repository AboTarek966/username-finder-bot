/* Instagram on a GitHub runner: can it be verified at all from a datacenter
   IP? Runs the real checker on controls, then samples the real browser to
   show what Instagram actually serves there. */

import { checkUsername } from '../src/checker.js';
import { withPage, closeBrowser, findBrowser } from '../src/browser.js';

console.log('browser binary:', findBrowser());

const CASES = [
  ['nasa', 'instagram', 'taken'],
  ['8zzp0', 'instagram', 'taken'],
  ['zzzqqq123456xxplm9qqq', 'instagram', 'free'],
  ['nasa', 'tiktok', 'taken'], // sanity: the runner itself is fine
];

for (const [name, platform, want] of CASES) {
  const t = Date.now();
  const s = await checkUsername(name, platform, { fresh: true });
  console.log(
    `CHECK ${platform.padEnd(9)} ${name.padEnd(24)} -> ${s} (want ${want}) ${((Date.now() - t) / 1000).toFixed(1)}s`
  );
}

console.log('== instagram browser sample (free handle) ==');
await withPage(async (page) => {
  const t0 = Date.now();
  const name = 'zzzqqq123456xxplm9qqq';
  try {
    await page.goto(`https://www.instagram.com/${name}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
  } catch (err) {
    console.log(`goto error: ${err.message}`);
  }
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    let html = '';
    let title = '';
    let text = '';
    try {
      html = await page.content();
      title = await page.title();
      text = await page.evaluate(() => document.body?.innerText || '');
    } catch {
      break;
    }
    console.log(
      JSON.stringify({
        t: Date.now() - t0,
        url: page.url().slice(0, 60),
        htmlBytes: html.length,
        title: title.slice(0, 45),
        ogDesc: /property="og:description"/i.test(html),
        profilePage: /profilePage_/.test(html),
        notAvail: /Profile isn'?t available/i.test(`${title} ${text}`),
        textChars: text.length,
        textSample: text.slice(0, 60).replace(/\s+/g, ' '),
      })
    );
    if (/Profile isn'?t available/i.test(`${title} ${text}`)) break;
  }
});
await closeBrowser();
console.log('== done ==');
process.exit(0);

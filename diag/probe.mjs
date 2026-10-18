/* Does the IG_SESSION cookie actually open Instagram from a datacenter IP?
   Runs the real checker on Instagram controls, then samples the browser to
   show whether the login wall is gone. */

import { checkUsername } from '../src/checker.js';
import { withPage, closeBrowser, findBrowser } from '../src/browser.js';

console.log('browser binary:', findBrowser());
console.log('IG_SESSION present:', Boolean(process.env.IG_SESSION));

const CASES = [
  ['nasa', 'instagram', 'taken'],
  ['8zzp0', 'instagram', 'taken'],
  ['zzzqqq123456xxplm9qqq', 'instagram', 'free'],
];

for (const [name, platform, want] of CASES) {
  const t = Date.now();
  const s = await checkUsername(name, platform, { fresh: true });
  console.log(
    `CHECK ${platform} ${name.padEnd(24)} -> ${s} (want ${want}) ${((Date.now() - t) / 1000).toFixed(1)}s`
  );
}

console.log('== instagram browser sample (free handle) ==');
await withPage(async (page) => {
  const name = 'zzzqqq123456xxplm9qqq';
  const t0 = Date.now();
  try {
    await page.goto(`https://www.instagram.com/${name}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
  } catch (err) {
    console.log(`goto error: ${err.message}`);
  }
  for (let i = 0; i < 10; i += 1) {
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
        url: page.url().slice(0, 55),
        title: title.slice(0, 40),
        ogDesc: /property="og:description"/i.test(html),
        profilePage: /profilePage_/.test(html),
        notAvail: /Profile isn'?t available/i.test(`${title} ${text}`),
        textSample: text.slice(0, 55).replace(/\s+/g, ' '),
      })
    );
    if (/Profile isn'?t available/i.test(`${title} ${text}`)) break;
  }
});
await closeBrowser();
console.log('== done ==');
process.exit(0);

/* One-off diagnostic: what does TikTok answer FROM A GITHUB RUNNER?
   1) plain HTTP (desktop + mobile UA) - this is what screenTaken uses
   2) the REAL bot browser (src/browser.js -> system Chrome, same UA/headers)
   Used once to pick a verification path that survives datacenter IPs. */

import { withPage, closeBrowser, findBrowser } from '../src/browser.js';

const NAMES = ['nasa', 'zzzqqq123456xxplm9qqq', '8zzp0'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

console.log('browser binary:', findBrowser());

function summarise(name, html, extra = {}) {
  return {
    name,
    bytes: html.length,
    notFoundText: /Couldn't find this account/i.test(html),
    uniqueIdHit: new RegExp(`"uniqueId":"${name}"`, 'i').test(html),
    controlHit: /"uniqueId":"nasa"/i.test(html),
    shell: /Please wait/i.test(html) && html.length < 8000,
    ...extra,
  };
}

console.log('== plain HTTP ==');
for (const name of NAMES) {
  for (const [label, ua] of [
    ['desktop', UA],
    ['mobile', MOBILE_UA],
  ]) {
    try {
      const res = await fetch(`https://www.tiktok.com/@${name}`, {
        headers: {
          'user-agent': ua,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      const html = await res.text();
      console.log(JSON.stringify({ label, http: res.status, ...summarise(name, html) }));
    } catch (err) {
      console.log(`${name} ${label}: fetch error ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

console.log('== mobile api ==');
for (const name of NAMES) {
  try {
    const res = await fetch(
      `https://m.tiktok.com/api/user/detail?uniqueId=${name}&aid=1988`,
      { headers: { 'user-agent': MOBILE_UA, accept: 'application/json' } }
    );
    const text = await res.text();
    let sc = null;
    let uid = '';
    try {
      const j = JSON.parse(text);
      sc = j?.status_code;
      uid = j?.user?.uniqueId ?? '';
    } catch {}
    console.log(`${name}: http=${res.status} bytes=${text.length} status_code=${sc} uniqueId="${uid}"`);
  } catch (err) {
    console.log(`${name}: api error ${err.message}`);
  }
}

console.log('== bot browser ==');
for (const name of NAMES) {
  const out = await withPage(async (page) => {
    const t0 = Date.now();
    let last = null;
    try {
      await page.goto(`https://www.tiktok.com/@${name}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
    } catch (err) {
      console.log(`${name}: goto error ${err.message}`);
    }
    for (let i = 0; i < 26; i += 1) {
      await new Promise((r) => setTimeout(r, 900));
      let html = '';
      let title = '';
      try {
        html = await page.content();
        title = await page.title();
      } catch {
        break;
      }
      last = summarise(name, html, {
        title,
        t: Date.now() - t0,
        url: page.url(),
      });
      console.log(JSON.stringify(last));
      if (last.notFoundText || last.uniqueIdHit) break;
    }
    return last;
  });
  console.log(`${name}: browser final -> ${JSON.stringify(out)}`);
}
await closeBrowser();
console.log('== done ==');

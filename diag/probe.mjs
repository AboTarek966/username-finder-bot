/* Round 2 of the runner probe.
   1) The server-rendered JSON TikTok hydrates the page with
      (__UNIVERSAL_DATA_FOR_REHYDRATION__) - is it an authoritative
      taken/free signal we can read from plain HTTP?
   2) What the bot's browser loop actually SEES (document.body.innerText)
      - the loop keys off that text, so if it is empty on the runner that
      is why every check ended up "unknown". */

import { withPage, closeBrowser, findBrowser } from '../src/browser.js';

const NAMES = ['nasa', 'zzzqqq123456xxplm9qqq', '8zzp0'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

console.log('browser binary:', findBrowser());

/** Pull the rehydration JSON out of the raw HTML and report the verdict it holds. */
function rehydration(name, html) {
  const m =
    html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
    ) || null;
  if (!m) return { hasJson: false };
  let json = null;
  try {
    json = JSON.parse(m[1]);
  } catch {
    return { hasJson: true, parseError: true };
  }
  const scope = json?.['__DEFAULT_SCOPE__'] || {};
  const detail = scope?.['webapp.user-detail'] || {};
  const user = detail?.userInfo?.user || null;
  return {
    hasJson: true,
    detailKeys: Object.keys(detail),
    statusCode: detail?.statusCode ?? null,
    hasUser: Boolean(user),
    userUniqueId: user?.uniqueId ?? '',
    userStatus: user?.status ?? null,
    match: user?.uniqueId?.toLowerCase() === name.toLowerCase(),
    // any other interesting top-level entries?
    scopeKeys: Object.keys(scope).slice(0, 12),
  };
}

console.log('== plain HTTP -> rehydration JSON ==');
for (const name of NAMES) {
  for (const attempt of [1, 2]) {
    try {
      const res = await fetch(`https://www.tiktok.com/@${name}`, {
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      const html = await res.text();
      console.log(
        JSON.stringify({
          name,
          attempt,
          http: res.status,
          bytes: html.length,
          uniqueIdRaw: new RegExp(`"uniqueId":"${name}"`, 'i').test(html),
          ...rehydration(name, html),
        })
      );
    } catch (err) {
      console.log(`${name}#${attempt}: fetch error ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 900));
  }
}

console.log('== bot browser -> rendered text ==');
for (const name of NAMES) {
  await withPage(async (page) => {
    const t0 = Date.now();
    try {
      await page.goto(`https://www.tiktok.com/@${name}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
    } catch (err) {
      console.log(`${name}: goto error ${err.message}`);
    }
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      let text = '';
      let html = '';
      try {
        text = await page.evaluate(() => document.body?.innerText || '');
        html = await page.content();
      } catch {
        break;
      }
      console.log(
        JSON.stringify({
          name,
          t: Date.now() - t0,
          htmlBytes: html.length,
          textChars: text.length,
          textHasNotFound: /couldn'?t find this account|تعذر العثور على هذا الحساب/i.test(text),
          textSample: text.slice(0, 70).replace(/\s+/g, ' '),
        })
      );
      if (/couldn'?t find this account|تعذر العثور على هذا الحساب/i.test(text)) break;
    }
  });
}
await closeBrowser();
console.log('== done ==');

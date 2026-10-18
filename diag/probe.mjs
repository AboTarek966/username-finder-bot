/* One-off diagnostic: what does TikTok answer FROM A GITHUB RUNNER?
   Plain HTTP (desktop + mobile UA), then a real browser sample-by-sample.
   Used once to pick a verification path that survives datacenter IPs. */

const NAMES = ['nasa', 'zzzqqq123456xxplm9qqq', '8zzp0'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

function summarise(name, html, extra = {}) {
  const notFound = /Couldn't find this account/i.test(html);
  const uniqueIdHit = new RegExp(`"uniqueId":"${name}"`, 'i').test(html);
  const shell = /Please wait/i.test(html) && html.length < 8000;
  return {
    name,
    bytes: html.length,
    notFoundText: notFound,
    uniqueIdHit,
    shell,
    ...extra,
  };
}

console.log('== plain HTTP ==');
for (const name of NAMES) {
  for (const [label, ua] of [
    ['desktop', UA],
    ['mobile', MOBILE_UA],
  ]) {
    for (const attempt of [1, 2]) {
      try {
        const res = await fetch(`https://www.tiktok.com/@${name}`, {
          headers: {
            'user-agent': ua,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
          },
        });
        const html = await res.text();
        console.log(
          JSON.stringify({ label, attempt, http: res.status, ...summarise(name, html) })
        );
      } catch (err) {
        console.log(`${name} ${label}#${attempt}: fetch error ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

console.log('== oembed ==');
for (const name of NAMES) {
  try {
    const res = await fetch(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(`https://www.tiktok.com/@${name}`)}`,
      { headers: { 'user-agent': UA } }
    );
    const text = (await res.text()).slice(0, 160);
    console.log(`${name}: http=${res.status} body=${text}`);
  } catch (err) {
    console.log(`${name}: oembed error ${err.message}`);
  }
}

console.log('== browser ==');
const { chromium } = await import('playwright');
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
for (const name of NAMES) {
  const page = await browser.newPage({ userAgent: UA, locale: 'en-US' });
  const t0 = Date.now();
  try {
    await page.goto(`https://www.tiktok.com/@${name}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
  } catch (err) {
    console.log(`${name}: goto error ${err.message}`);
  }
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 800));
    let html = '';
    let title = '';
    try {
      html = await page.content();
      title = await page.title();
    } catch {
      break;
    }
    const s = summarise(name, html, { title, t: Date.now() - t0, url: page.url() });
    console.log(JSON.stringify(s));
    if (s.notFoundText || s.uniqueIdHit) break;
  }
  await page.close().catch(() => {});
}
await browser.close();
console.log('== done ==');

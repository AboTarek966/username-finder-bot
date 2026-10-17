// Headless browser pool (puppeteer-core + the system Chrome/Edge).
// Sites like TikTok run JS challenges that plain HTTP requests fail, so the
// bot renders pages in a real browser and inspects the result.

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_PAGES = Math.max(1, Number(process.env.BROWSER_PAGES) || 4);
const RECYCLE_AFTER = Math.max(10, Number(process.env.BROWSER_RECYCLE_AFTER) || 150);

let browser = null;
let launchPromise = null;
let launchFailed = false;
let navCount = 0;
const allPages = new Set();
const freePages = [];
const waiters = [];

export function findBrowser() {
  return CANDIDATES.find((p) => p && existsSync(p)) || null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function doLaunch() {
  const executablePath = findBrowser();
  if (!executablePath) {
    launchFailed = true;
    console.warn('No Chrome/Edge found - browser checks disabled (set BROWSER_PATH)');
    return null;
  }

  const b = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US',
      '--disable-gpu',
    ],
    protocolTimeout: 90_000,
  });
  b.on('disconnected', () => {
    if (browser === b) browser = null;
    allPages.clear();
    freePages.length = 0;
    // Never leave callers hanging - they fall back to HTTP checks.
    for (const w of waiters.splice(0)) w(null);
  });
  browser = b;
  navCount = 0;
  return b;
}

/** Memoized so concurrent checks share ONE browser instance. */
async function launch() {
  if (launchFailed) return null;
  if (browser && browser.connected) return browser;
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    try {
      return await doLaunch();
    } catch (err) {
      launchFailed = true;
      console.warn('Browser launch failed:', err.message);
      return null;
    }
  })().finally(() => {
    launchPromise = null;
  });
  return launchPromise;
}

async function newPage(b) {
  const page = await b.newPage();
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1366, height: 768 });
  await page.setRequestInterception(true);
  const mode = process.env.BLOCK_RESOURCES || '2'; // 0=none, 1=images+fonts+media, 2=media+video CDNs
  page.on('request', (req) => {
    if (mode === '0') return req.continue();
    const type = req.resourceType();
    if (mode === '1' && (type === 'media' || type === 'font' || type === 'image')) return req.abort();
    if (mode === '2' && type === 'media') return req.abort();
    // Video streams/CDNs too - we only need the profile data, not the clips.
    if (/(?:\.mp4|\.m4s|\.webm)(?:\?|$)|tiktokcdn|p16-sign\.|p\d+-sign\./i.test(req.url())) {
      return req.abort();
    }
    req.continue();
  });
  page.setDefaultTimeout(45_000);
  allPages.add(page);
  return page;
}

async function acquire() {
  const b = await launch();
  if (!b) return null;

  // Recycle the browser once it has done a lot of work (memory safety).
  if (navCount >= RECYCLE_AFTER && freePages.length === allPages.size) {
    await closeBrowser();
    const b2 = await launch();
    if (!b2) return null;
  }

  if (freePages.length) return freePages.pop();

  if (allPages.size < MAX_PAGES) {
    try {
      return await newPage(b);
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => waiters.push(resolve));
}

function release(page) {
  if (!page) return;
  const waiter = waiters.shift();
  if (waiter) waiter(page);
  else freePages.push(page);
}

/** Run `fn` with an exclusive browser page. Returns null if no browser. */
export async function withPage(fn) {
  const page = await acquire();
  if (!page) return null;
  navCount += 1;
  try {
    return await fn(page);
  } finally {
    release(page);
  }
}

export async function closeBrowser() {
  allPages.clear();
  freePages.length = 0;
  for (const w of waiters.splice(0)) w(null);

  const b = browser;
  browser = null;
  navCount = 0;
  if (!b) return;

  // Closing the browser also closes every page; doing it per-page first made
  // the browser's process-tree kill print errors for already-dead processes.
  await Promise.race([b.close().catch(() => {}), delay(7000)]);

  try {
    const proc = b.process?.();
    if (proc && proc.exitCode === null && !proc.killed) proc.kill();
  } catch {
    /* ignore */
  }
}

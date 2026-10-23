// Telegram bot entry point (Arabic UI, button-driven).
// Running under PM2 (ecosystem.config.cjs): edits to src/ auto-restart it.
//
// Main menu (reply keyboard):
//   🔍 فحص يوزر  🎲 توليد يوزر
// Slash commands still work: /check /gen /scan /deep /platform /help

import 'dotenv/config';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import {
  checkOn,
  checkUsername,
  emoji,
  statusText,
  RULES,
  ALL_PLATFORMS,
  FREE,
  TAKEN,
  UNKNOWN,
  mapPool,
  platformCooldown,
} from './checker.js';
import {
  generateCandidates,
  variations,
  baseCombos,
  GEN_MODES,
  MODE_KEYS,
} from './generator.js';
import { deepHunt, worstCaseNote } from './hunter.js';
import {
  startInventory,
  stopInventory,
  waitForInventory,
  takeFromInventory,
  setDemand,
  holdInventory,
  releaseInventory,
  isInventoryPaused,
  startContinuousMode,
  stopContinuousMode,
  isContinuousModeActive,
} from './inventory.js';
import { closeBrowser, findBrowser } from './browser.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env (get one from @BotFather)');
  process.exit(1);
}

const MAX_PER_CHECK = 10;
// Keep the check workers in step with the browser page pool (browser.js).
const PARALLEL = Math.max(1, Number(process.env.CHECK_PARALLEL) || 4);

/* User-typed text lands inside HTML messages - escape it, or a single "<"
   from the keyboard turns the whole report into a Telegram parse error. */
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** chatId -> { platforms: string[], awaiting: 'check'|'scan'|'deep'|null, genMode: string } */
const chats = new Map();
const WAITING = ['check', 'scan', 'deep'];
function stateOf(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, { platforms: [...ALL_PLATFORMS], awaiting: null, genMode: 'normal' });
  }
  const st = chats.get(chatId);
  // Sanitize: never keep a platform key we don't know about.
  const valid = (st.platforms || []).filter((p) => p === 'tiktok' || p === 'instagram');
  st.platforms = valid.length ? [...new Set(valid)] : [...ALL_PLATFORMS];
  st.awaiting = WAITING.includes(st.awaiting) ? st.awaiting : null;
  if (!MODE_KEYS.includes(st.genMode)) st.genMode = 'normal';
  return st;
}

const bot = new Bot(TOKEN);

const HELP = [
  '<b>🔎 بوت البحث عن يوزرات غير محجوزة</b> (تيكتوك + إنستا)',
  '',
  '<b>استخدم الزرين التاليين:</b>',
  '🔍 <b>فحص يوزر</b> — أرسل الأسماء ليتم فحصها',
  '🎲 <b>توليد يوزر</b> — يولّد أسماء باستمرار ويبيّن المتاح منها',
  '',
  '<b>أنواع التوليد:</b>',
  'عادي (nova42) • مميز (the.nova.official)',
  'ثلاثي (kr1, a.b) • رباعي (rh23, zx42)',
  'شبه ثلاثي (kr.1, ab12) • شبه رباعي (rh234, ab.xy)',
  '',
  '🔁 يستمر التوليد تلقائيًا حتى تضغط <b>⏹ إيقاف</b> تحت الرسالة.',
  '',
  '<b>أوامر مكتوبة (اختيارية):</b>',
  '/check &lt;user1&gt; [user2] — فحص أسماء (حد أقصى 10)',
  '/gen [النوع] — توليد مستمر (يتوقف بـ ⏹ فقط)',
  '/deep [كلمة] [النوع] — بحث عميق يعرض المتاح المؤكد فقط',
  '/scan &lt;الاسم&gt; [العدد] — صيغ بديلة',
  '/platform — اختيار المنصة',
  '',
  '✅ غير محجوز | ❌ محجوز | ⚠️ غير مؤكد (حظر مؤقت — أعد المحاولة لاحقًا)',
  '',
  'ℹ️ على إنستا: «متاح» = لا يوجد حساب وخانة اسم المستخدم في التسجيل نفسها رفضت الاسم (نفس اختبارك).',
  '',
  '⚠️ النتيجة تُحفظ لمدة 6 ساعات — راجع اليوزر بـ /check قبل تسجيله.',
].join('\n');

/* ------------------------------ keyboards ------------------------------ */

function mainKeyboard() {
  return new Keyboard().text('🔍 فحص يوزر').text('🎲 توليد يوزر').resized();
}

function platformKeyboard(chatId) {
  const { platforms } = stateOf(chatId);
  const mark = (p) => (platforms.includes(p) ? '✅ ' : '');
  return new InlineKeyboard()
    .text(`${mark('tiktok')}تيكتوك`, 'pf:tiktok')
    .text(`${mark('instagram')}انستا`, 'pf:instagram')
    .row()
    .text('الاتنين', 'pf:both');
}

function genModeKeyboard() {
  return new InlineKeyboard()
    .text(`🔁 ${GEN_MODES.normal.label} (مستمر)`, 'gen:continuous:normal')
    .text(`🔁 ${GEN_MODES.premium.label} (مستمر)`, 'gen:continuous:premium')
    .row()
    .text(`🔁 ${GEN_MODES.tri.label} (مستمر)`, 'gen:continuous:tri')
    .text(`🔁 ${GEN_MODES.quad.label} (مستمر)`, 'gen:continuous:quad')
    .row()
    .text(`🔁 ${GEN_MODES.quasi3.label} (مستمر)`, 'gen:continuous:quasi3')
    .text(`🔁 ${GEN_MODES.quasi4.label} (مستمر)`, 'gen:continuous:quasi4');
}

/** Buttons under a finished batch: repeat it or pick another style. */
function againKeyboard(mode) {
  return new InlineKeyboard()
    .text('🔁 توليد مرة أخرى', `gen:continuous:${mode}`)
    .text('🔁 نوع توليد آخر', 'modes:open')
    .row()
    .text('🔬 بحث عميق بنفس النوع', `deep:${mode}`);
}

function continuousKeyboard(mode) {
  return new InlineKeyboard()
    .text('⏹ إيقاف التوليد المستمر', `gen:stop:${mode}`)
    .text('🔁 نوع توليد آخر', 'modes:open')
    .row()
    .text('🔬 بحث عميق بنفس النوع', `deep:${mode}`);
}

function parseHandles(raw) {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
}

/** "quad" أو "رباعي" — both spellings work in commands and free text. */
function modeFrom(s) {
  if (!s) return null;
  const key = String(s).toLowerCase();
  return MODE_KEYS.find((m) => m === key || GEN_MODES[m].label === key) || null;
}

/** Edits a status message at most every 2s to stay under Telegram limits. */
function progressEditor(ctx, messageId) {
  let last = 0;
  return async (done, total, note = 'يفحص') => {
    const now = Date.now();
    if (now - last < 2000 && done < total) return;
    last = now;
    const filled = Math.round((done / total) * 10);
    await ctx.api
      .editMessageText(ctx.chat.id, messageId, `${note} ${done}/${total}\n[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]`)
      .catch(() => {});
  };
}

/* ------------------------------ actions ------------------------------ */

async function runCheckInner(ctx, names) {
  const { platforms } = stateOf(ctx.chat.id);
  const labels = platforms.map((p) => RULES[p].label).join(' + ');

  const msg = await ctx.reply(`🔎 بفحص ${names.length} يوزر على ${labels} ...`);
  const update = progressEditor(ctx, msg.message_id);

  const rows = await mapPool(names, PARALLEL, async (name, i) => {
    const res = await checkOn(name, platforms);
    await update(i + 1, names.length);
    const parts = platforms.map(
      (p) => `  ${RULES[p].label}: ${emoji(res[p])} ${statusText(res[p])}`
    );
    const free = platforms.some((p) => res[p] === FREE);
    return `${free ? '🎯 ' : ''}<b>@${esc(name)}</b>\n${parts.join('\n')}`;
  });

  const freeCount = rows.filter((r) => r.startsWith('🎯')).length;
  const footer = freeCount
    ? `\n\n🎯 يوزرات متاحة (مؤكدة بفحصين): ${freeCount}`
    : '\n\nلا توجد يوزرات متاحة في هذه القائمة.';
  await ctx.api
    .editMessageText(ctx.chat.id, msg.message_id, rows.join('\n\n') + footer, {
      parse_mode: 'HTML',
    })
    .catch(() => {});
}

/* Manual commands (check / scan / deep) get the page pool to themselves:
   the background inventory holds off until they are done. */
const guarded = (fn) => (...args) => {
  holdInventory();
  return fn(...args).finally(releaseInventory);
};
const runCheck = guarded(runCheckInner);
const runScan = guarded(runScanInner);
const runDeep = guarded(runDeepInner);

/* Reply contract (what the user asked for):
     - never answer with "nothing found"
     - never keep them waiting longer than ~30 seconds
   Both only work if the search is already running in the background, so the
   answer comes from a warm inventory (src/inventory.js) and the FIRST reply
   only ever goes out with real, double-verified names in it. Anything still
   missing is appended to that same message by edit - no second ping, no
   "try again". */
const GEN_FIRST_WAIT = 20_000; // warm buffer: full answer, or whatever we have
const GEN_EMPTY_WAIT = 60_000; // cold buffer: wait for real names, not a report
const GEN_TOPUP_MS = 12 * 60_000; // keep topping the message up after replying
const GEN_MAX = 16; // inventory keeps up to 16 per type

function genLines(entries, mode) {
  return [...entries.values()].map((item) => {
    const plats = item.freeOn.map((p) => RULES[p].label).join('+');
    // A name is served as soon as one platform confirms it; when Instagram
    // then answers in the background, the line is upgraded in place
    // ("TikTok" -> "TikTok+Instagram") - and if Instagram says it is TAKEN
    // there, that is spelled out so the user is never misled.
    const igNote = item.ig === TAKEN ? ' (محجوز على إنستا)' : '';
    return `  • @${item.name}${
      item.mode === mode ? '' : ` (${GEN_MODES[item.mode].label})`
    } — ${plats}${igNote}`;
  });
}

function genText(rows, mode, target, filling, paused = false, continuous = false) {
  const head = filling
    ? `🎯 <b>وجد ${rows.size} — الباقي في طريقه:</b>`
    : rows.size >= target && !continuous
      ? `🎯 <b>تم العثور على ${target} يوزرات متاحة مؤكدة:</b>`
      : continuous
        ? `🔁 <b>توليد مستمر — ${rows.size} يوزر متاح (اضغط ⏹ للإيقاف):</b>`
        : `🎯 <b>${rows.size} يوزر متاح مؤكد (من ${target}):</b>`;
  const foot = filling
    ? paused
      ? '\n\n⏸ البحث متوقف مؤقتًا — اضغط ▶️ تشغيل البحث وسنواصل هنا.'
      : continuous
        ? '\n\n🔁 <b>الوضع المستمر يعمل</b> — يضيف أسماء بسرعة للرسالة. اضغط ⏹ <b>إيقاف</b> لتوقيفه.'
        : '\n\n⏳ كل اسم هنا مؤكد بفحصين — والباقي سيضاف في نفس الرسالة.'
    : rows.size >= target && !continuous
      ? '\n\n✅ الكل مؤكد بفحصين ومتاح فعليًا الآن.'
      : paused
        ? '\n\n⏸ البحث متوقف — اضغط ▶️ تشغيل البحث وسيصل الباقي هنا.'
        : '\n\n⚠️ المنصات ترد ببطء (حظر مؤقت) — الباقي سيصل في نفس الرسالة.';
  const note = filling
    ? ''
    : '\n\nℹ️ «متاح» على إنستا = لا يوجد حساب + خانة التسجيل قبلت الاسم' +
      ' (نفس التي تغير بها اسمك). وعلى تيكتوك = لا يوجد حساب على الاسم' +
      ' — إن رفضت المنصة تغيير الاسم فهذا احتفاظ لديها لا حساب موجود.';
  return head + '\n' + genLines(rows, mode).join('\n') + foot + note;
}

/* Grow the very same message until the requested count is on it (or forever in continuous mode). */
async function topUp(ctx, messageId, rows, mode, target, platforms, continuous = false) {
  const deadline = continuous ? Infinity : Date.now() + GEN_TOPUP_MS;
  let lastEdit = 0;
  const pollInterval = continuous ? 800 : 2500; // much faster polling in continuous mode
  
  while (rows.size < target && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));
    
    // Check if continuous mode was stopped
    if (continuous && !isContinuousModeActive(ctx.chat.id)) {
      break;
    }
    
    // ⏸ paused: keep the line honest and WAIT for the resume - the names the
    // user asked for still belong in this very message afterwards.
    if (isInventoryPaused()) {
      if (Date.now() - lastEdit > 5000) {
        lastEdit = Date.now();
        await ctx.api
          .editMessageText(
            ctx.chat.id,
            messageId,
            genText(rows, mode, target, rows.size < target, true, continuous),
            { parse_mode: 'HTML' }
          )
          .catch(() => {});
      }
      continue;
    }
    const more = takeFromInventory(mode, continuous ? 50 : target - rows.size, platforms);
    if (!more.length) continue;
    for (const item of more) rows.set(item.name, item);
    const now = Date.now();
    if (rows.size >= target || now - lastEdit > 3000) {
      lastEdit = now;
      await ctx.api
        .editMessageText(ctx.chat.id, messageId, genText(rows, mode, target, rows.size < target, false, continuous), {
          parse_mode: 'HTML',
          reply_markup: continuous ? continuousKeyboard(mode) : undefined,
        })
        .catch(() => {});
    }
  }
  
  // In continuous mode, don't add final keyboard - the continuous keyboard is already there
  if (continuous) {
    if (rows.size === 0) {
      await ctx.api
        .editMessageText(ctx.chat.id, messageId, 
          `⏳ لا يزال البحث جاريًا عن ${GEN_MODES[mode].label} — أي اسم جديد مؤكد سيصل هنا.`, {
            parse_mode: 'HTML',
            reply_markup: continuousKeyboard(mode),
          })
        .catch(() => {});
    }
    return;
  }
  
  // Never end on a bare "0" (the user asked never to be told "nothing"): if
  // the rare exact type could not fill in time, keep the status line honest
  // and leave the retry button under it.
  const doneText = rows.size
    ? genText(rows, mode, target, false, isInventoryPaused())
    : isInventoryPaused()
      ? `⏸ البحث متوقف — اضغط ▶️ تشغيل البحث وسيصل باقي ${GEN_MODES[mode].label} هنا.`
      : `⏳ لا يزال البحث جاريًا عن ${GEN_MODES[mode].label} — أي اسم جديد مؤكد سيصل هنا.`;
  await ctx.api
    .editMessageText(ctx.chat.id, messageId, doneText, {
      parse_mode: 'HTML',
      reply_markup: againKeyboard(mode),
    })
    .catch(() => {});
}

/* Quietly confirm the names we actually served on Instagram.
   The reply itself never waits for this: it goes out as soon as TikTok has
   verified a name, and then each SERVED name (a handful - never the whole
   inventory, so the owner's Instagram account is not hammered) is checked on
   Instagram and its line updated in place: "— TikTok" becomes
   "— TikTok+Instagram", or "(محجوز على إنستا)" when Instagram says it is
   taken there. An Instagram "unknown" is left silent - no noise, no lies. */
async function confirmInstagram(ctx, messageId, rows, mode, target) {
  if (!stateOf(ctx.chat.id).platforms.includes('instagram')) return;
  const deadline = Date.now() + GEN_TOPUP_MS;
  let lastEdit = 0;
  while (Date.now() < deadline) {
    if (isInventoryPaused()) {
      await new Promise((r) => setTimeout(r, 3000)); // ⏸: hold the IG checks too
      continue;
    }
    const item = [...rows.values()].find((i) => !i.ig && !i.freeOn.includes('instagram'));
    if (!item) {
      await new Promise((r) => setTimeout(r, 3000)); // new rows may still arrive
      continue;
    }
    item.ig = 'busy'; // claim it so the next pass does not pick it twice
    // fresh:true - the label we are about to print must come from a brand-new
    // verification, never from a cache entry another path left behind.
    const res = await checkOn(item.name, ['instagram'], { fresh: true }).catch(() => ({}));
    if (res?.instagram === FREE) {
      item.freeOn = [...new Set([...item.freeOn, 'instagram'])];
      item.ig = 'free';
    } else {
      item.ig = res?.instagram || UNKNOWN;
    }
    const now = Date.now();
    if (now - lastEdit > 5000) {
      lastEdit = now;
      await ctx.api
        .editMessageText(
          ctx.chat.id,
          messageId,
          genText(rows, mode, target, rows.size < target),
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  }
}

async function runGen(ctx, mode, count, continuous = false) {
  const st = stateOf(ctx.chat.id);
  st.genMode = mode;
  const { platforms } = st;
  setDemand(platforms);
  const target = continuous ? 999999 : Math.max(1, Math.min(GEN_MAX, Number(count) || 8));

  if (continuous) {
    startContinuousMode(ctx.chat.id, mode, platforms);
  }

  // --- silent wait: never reply with a report when the user wants names --
  await waitForInventory(mode, continuous ? 1 : target, GEN_FIRST_WAIT);
  let picked = takeFromInventory(mode, continuous ? 1 : target, platforms);
  if (!picked.length) {
    // Nothing on hand at all (cold start): the user asked never to be told
    // "nothing found", so we stay silent until the first name is verified.
    // The status line below is the last resort for a full double outage.
    await waitForInventory(mode, 1, GEN_EMPTY_WAIT);
    picked = takeFromInventory(mode, continuous ? 1 : target, platforms);
  }

  const rows = new Map(picked.map((i) => [i.name, i]));
  const filling = rows.size < target;

  // Cold start / both platforms throttled: say ONE short status line (never
  // "nothing found") and let the same message collect the names as they are
  // verified.
  if (!rows.size) {
    // Paused (⏸): no stock and no background search - never claim otherwise.
    if (isInventoryPaused() && !continuous) {
      await ctx.reply(
        '⏸ البحث متوقف حاليًا ولا يوجد اسم جاهز الآن — اضغط ▶️ تشغيل البحث من القائمة وحاول مجددًا.'
      );
      return;
    }
    const msg = await ctx.reply('⏳ جارٍ التحقق من أسماء جديدة — فور توفرها ستصل هنا.');
    topUp(ctx, msg.message_id, rows, mode, target, platforms, continuous).catch(() => {});
    confirmInstagram(ctx, msg.message_id, rows, mode, target).catch(() => {});
    return;
  }

  const msg = await ctx.reply(genText(rows, mode, target, filling, false, continuous), {
    parse_mode: 'HTML',
    reply_markup: filling ? undefined : (continuous ? continuousKeyboard(mode) : againKeyboard(mode)),
  });
  topUp(ctx, msg.message_id, rows, mode, target, platforms, continuous).catch(() => {});
  confirmInstagram(ctx, msg.message_id, rows, mode, target).catch(() => {});
}

async function runScanInner(ctx, base, limit) {
  const st = stateOf(ctx.chat.id);
  const { platforms } = st;
  const platform = platforms[0];

  const list = variations(base, { platform, limit });
  if (!list.length) return ctx.reply('هذا الاسم غير صالح كيوزر في هذه المنصة.');

  const msg = await ctx.reply(
    `🧩 ${list.length} صيغة لـ <b>${esc(base)}</b> على ${RULES[platform].label} ...`,
    { parse_mode: 'HTML' }
  );
  const update = progressEditor(ctx, msg.message_id);

  const rows = await mapPool(list, PARALLEL, async (name, i) => {
    const status = await checkUsername(name, platform);
    await update(i + 1, list.length, 'يجرب');
    return { name, status };
  });

  // The obvious variations are usually taken. Rather than answering "none",
  // widen the net around the same word (base_x_nova, the.base, base407...)
  // before we report anything.
  if (!rows.some((r) => r.status === FREE)) {
    const extra = baseCombos(base, { platform, count: 18 }).filter(
      (n) => !list.includes(n)
    );
    if (extra.length) {
      await ctx.api
        .editMessageText(
          ctx.chat.id,
          msg.message_id,
          `🧩 لا توجد في الصيغ المباشرة — يبحث أوسع حول <b>${esc(base)}</b> (${extra.length} تركيبة) ...`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      const more = await mapPool(extra, PARALLEL, async (name, i) => {
        const status = await checkUsername(name, platform);
        await update(i + 1, extra.length, 'يركب تركيبات');
        return { name, status };
      });
      rows.push(...more);
    }
  }

  // Same rule as generation: name only what survived the double check.
  const freeOnes = rows
    .filter((r) => r.status === FREE)
    .map((r) => `  • <code>@${r.name}</code>`);
  const takenCount = rows.filter((r) => r.status === TAKEN).length;
  const unknownCount = rows.filter((r) => r.status === UNKNOWN).length;
  const stats =
    `\n\n📊 فحصت <b>${rows.length}</b> صيغة:` +
    ` <b>${freeOnes.length}</b> متاحة ✅` +
    ` — ${takenCount} محجوزة ❌` +
    (unknownCount ? ` — ${unknownCount} مش مؤكدة (مخفية عمدًا) ⠶` : '');
  const body = freeOnes.length
    ? `🎯 <b>المتاحة فعلاً (مؤكدة بفحصين):</b>\n${freeOnes.join('\n')}`
    : `لم يُعثر على صيغة متاحة حول <b>${esc(base)}</b> بعد ${rows.length} محاولة — الاسم مطلوب جدًا.`;
  await ctx.api
    .editMessageText(ctx.chat.id, msg.message_id, body + stats, {
      parse_mode: 'HTML',
    })
    .catch(() => {});
}

/**
 * Deep hunt: check a large pool, then re-check every "free" hit on a fresh
 * page (cache bypassed) so we only report names that are really available.
 */
async function runDeepInner(ctx, base, mode) {
  const st = stateOf(ctx.chat.id);
  const { platforms } = st;
  const labels = platforms.map((p) => RULES[p].label).join(' + ');
  const withBase = !!base && !['random', 'عشوائي', 'عشوائى'].includes(base.toLowerCase());
  const scope = withBase ? `كلمة <b>${esc(base)}</b>` : `نوع <b>${GEN_MODES[mode].label}</b>`;

  const msg = await ctx.reply(
    `🔬 بحث عميق (${scope}) على ${labels}\n` +
      'سيفحص دفعة كبيرة ويعرض المتاح <b>المؤكد</b> فقط (فحصين لكل اسم)...',
    { parse_mode: 'HTML' }
  );

  let last = 0;
  const result = await deepHunt({
    base: withBase ? base : null,
    mode,
    platforms,
    target: 6,
    maxChecks: 48,
    onProgress: async ({ checked, total, free, unknown }) => {
      const now = Date.now();
      if (now - last < 2500) return;
      last = now;
      await ctx.api
        .editMessageText(
          ctx.chat.id,
          msg.message_id,
          `🔬 بحث عميق (${scope})\nيفحص ${checked}/${total}` +
            `\n🎯 وجد ${free} متاح حتى الآن` +
            (unknown ? ` | ⚠️ ${unknown} غير مؤكد` : ''),
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    },
  });

  const lines = result.free.map(
    (f) =>
      `🎯 <b>@${f.name}</b>\n${f.platforms
        .map((p) => `  ${RULES[p].label}: ✅ غير محجوز`)
        .join('\n')}`
  );
  const header =
    `🔬 <b>بحث عميق</b> (${scope}) — فحصت <b>${result.checked}</b> يوزر` +
    (result.stoppedEarly ? ' وتوقفت بعد إيجاد القدر الكافي ✅' : '');
  const body = lines.length
    ? lines.join('\n\n')
    : 'لا يوجد يوزر متاح مؤكد في هذه الدفعة — جرّب كلمة/نوع آخر أو أعد الضغط على 🔬 بعد قليل.';
  const note =
    `\n\n💡 <b>مهم:</b> كل اسم تم تأكيده مرتين (فحص ثانٍ بدون كاش).` +
    `\nسارع بالتسجيل قبل أن يأخذه غيرك، وراجعه بـ /check قبل التسجيل.` +
    worstCaseNote(result.unknown);

  st.lastDeep = { base: withBase ? base : null, mode };
  await ctx.api
    .editMessageText(ctx.chat.id, msg.message_id, `${header}\n\n${body}${note}`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('🔬 إعادة البحث بنفس الكلمة', 'deep:again')
        .text('🎲 توليد يوزرات', 'modes:open'),
    })
    .catch(() => {});
}

function showMenu(ctx, text) {
  return ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainKeyboard() });
}

/* ------------------------------ commands ------------------------------ */

bot.command('start', (ctx) => showMenu(ctx, HELP));
bot.command('help', (ctx) => showMenu(ctx, HELP));

bot.command('platform', (ctx) =>
  ctx.reply('اختر المنصة المراد الفحص عليها:', {
    reply_markup: platformKeyboard(ctx.chat.id),
  })
);

bot.callbackQuery(/^pf:(tiktok|instagram|both)$/, async (ctx) => {
  // ctx.match[1] is the platform key itself ('tiktok'), NOT 'pf:tiktok'.
  const arg = ctx.match?.[1] || ctx.callbackQuery.data.split(':')[1];
  const st = stateOf(ctx.chat.id);
  st.platforms = arg === 'both' ? [...ALL_PLATFORMS] : [arg];
  await ctx.answerCallbackQuery({ text: 'تم الحفظ ✔️' });
  // Same text/keyboard = Telegram returns "message is not modified"; ignore it.
  await ctx
    .editMessageText('اختر المنصة المراد الفحص عليها:', {
      reply_markup: platformKeyboard(ctx.chat.id),
    })
    .catch(() => {});
});

bot.callbackQuery(/^gen:([a-z0-9]+)$/, async (ctx) => {
  const mode = GEN_MODES[ctx.match?.[1]] ? ctx.match[1] : 'normal';
  await ctx.answerCallbackQuery({ text: `توليد ${GEN_MODES[mode].label} ✔️` }).catch(() => {});
  // Old messages still carry non-continuous buttons: honour them the same way
  // as the current menu - run until the user presses ⏹.
  await runGen(ctx, mode, 999999, true).catch((e) => console.error('gen error:', e));
});

bot.callbackQuery(/^gen:stop:([a-z0-9]+)$/, async (ctx) => {
  const mode = ctx.match?.[1];
  stopContinuousMode(ctx.chat.id);
  await ctx.answerCallbackQuery({ text: '⏹ تم إيقاف التوليد المستمر' }).catch(() => {});
  // Update the message to show it's stopped
  await ctx.api
    .editMessageReplyMarkup(ctx.chat.id, ctx.callbackQuery.message.message_id, {
      reply_markup: againKeyboard(mode),
    })
    .catch(() => {});
});

bot.callbackQuery('modes:open', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'اختر النوع 👇' }).catch(() => {});
  await ctx
    .reply('اختر نوع التوليد:', {
      reply_markup: genModeKeyboard(),
    })
    .catch(() => {});
});

bot.callbackQuery(/^gen:continuous:([a-z0-9]+)$/, async (ctx) => {
  const mode = GEN_MODES[ctx.match?.[1]] ? ctx.match[1] : 'normal';
  await ctx.answerCallbackQuery({ text: `🔁 توليد ${GEN_MODES[mode].label} مستمر ✔️` }).catch(() => {});
  await runGen(ctx, mode, 999999, true).catch((e) => console.error('continuous gen error:', e));
});

bot.callbackQuery('deep:again', async (ctx) => {
  const st = stateOf(ctx.chat.id);
  await ctx.answerCallbackQuery({ text: 'بحث عميق آخر 🔬' }).catch(() => {});
  const last = st.lastDeep || { base: null, mode: st.genMode };
  await runDeep(ctx, last.base, last.mode).catch((e) => console.error('deep error:', e));
});

bot.callbackQuery(/^deep:([a-z0-9]+)$/, async (ctx) => {
  const mode = GEN_MODES[ctx.match?.[1]] ? ctx.match[1] : 'normal';
  await ctx.answerCallbackQuery({ text: `بحث عميق (${GEN_MODES[mode].label}) 🔬` }).catch(() => {});
  await runDeep(ctx, null, mode).catch((e) => console.error('deep error:', e));
});

bot.command('check', async (ctx) => {
  const raw = ctx.match.trim();
  if (!raw) return showMenu(ctx, 'الاستخدام: <code>/check user1 user2</code>\nأو اضغط 🔍 فحص يوزر من القائمة.');
  const names = parseHandles(raw).slice(0, MAX_PER_CHECK);
  await runCheck(ctx, names);
});

bot.command('gen', async (ctx) => {
  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  // Continuous by default: it never stops on its own, only via ⏹ under the message.
  const mode = modeFrom(args[0]) || modeFrom(args[1]) || 'normal';
  await runGen(ctx, mode, 999999, true).catch((e) => console.error('gen error:', e));
});

bot.command('deep', async (ctx) => {
  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  const mode = modeFrom(args[1]) || stateOf(ctx.chat.id).genMode;
  await runDeep(ctx, args[0] ? args[0].replace(/^@/, '') : null, mode);
});

bot.command('scan', async (ctx) => {
  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  if (!args[0]) return showMenu(ctx, 'الاستخدام: <code>/scan ahmad 10</code>');
  const limit = Math.min(Math.max(Number(args[1]) || 12, 1), 20);
  await runScan(ctx, args[0].replace(/^@/, ''), limit);
});

/* ------------------------------ button & text routing ------------------------------ */

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (/^\/./.test(text)) return; // commands have their own handlers

  const st = stateOf(ctx.chat.id);

  // --- main menu buttons ---
  switch (text) {
    case '🔍 فحص يوزر':
      st.awaiting = 'check';
      return showMenu(ctx, 'أرسل اليوزرات التي تريد فحصها (أسماء متعددة مفصولة بفواصل أو مسافات):');
    case '🎲 توليد يوزر':
      return ctx.reply('اختر نوع التوليد:', {
        reply_markup: genModeKeyboard(),
      });
    default:
      break;
  }

  // --- pending mode from a menu button ---
  if (st.awaiting === 'check') {
    st.awaiting = null;
    const names = parseHandles(text).slice(0, MAX_PER_CHECK);
    if (!names.length) return showMenu(ctx, 'أرسل أسماء صحيحة مثل: <code>ahmad, sara_x</code>');
    return runCheck(ctx, names);
  }
  if (st.awaiting === 'scan') {
    st.awaiting = null;
    const [base, cnt] = text.split(/\s+/);
    const limit = Math.min(Math.max(Number(cnt) || 12, 1), 20);
    return runScan(ctx, base.replace(/^@/, ''), limit);
  }
  if (st.awaiting === 'deep') {
    st.awaiting = null;
    const [word, maybeMode] = text.split(/\s+/);
    const mode = modeFrom(maybeMode) || st.genMode;
    return runDeep(ctx, word.replace(/^@/, ''), mode);
  }

  // --- bare handle = quick check ---
  if (/^@?[a-zA-Z0-9._]{1,30}$/.test(text)) {
    return runCheck(ctx, [text.replace(/^@/, '')]);
  }

  return showMenu(ctx, 'اضغط أحد الأزرار أدناه 👇 أو اكتب /help');
});

bot.catch(async (err) => {
  console.error('bot error:', err.error ?? err);
  // Never leave the user staring at silence after a failed command.
  try {
    await err.ctx.reply('⚠️ حدث خطأ أثناء تنفيذ الأمر — جرّب مجددًا بعد قليل.\nإن تكرر أرسل /help من جديد.');
  } catch {
    /* ignore */
  }
});

/* ------------------------------ lifecycle ------------------------------ */

async function shutdown(signal) {
  console.log(`\n${signal} - closing browser...`);
  stopInventory();
  await closeBrowser().catch(() => {});
  await bot.stop().catch(() => {});
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

if (!findBrowser()) {
  console.warn('⚠️ No Chrome/Edge found - falling back to HTTP checks (less accurate).');
}

// Test hook: DISABLE_POLLING=1 lets a local script import this module and
// drive runGen/runScan/runDeep directly - without ever touching Telegram.
// Never set it on the server: the deployed bot must always poll.
export { runGen, runScan, runDeep, runCheck, mainKeyboard, genModeKeyboard };

// Fill the inventory right away so the first "generate" tap of the day is
// answered from a warm buffer instead of making the user wait for a search.
startInventory();

if (process.env.DISABLE_POLLING !== '1') {
  bot.start({
    onStart: (me) => console.log(`Bot running as @${me.username}`),
    drop_pending_updates: true,
  });
}

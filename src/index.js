// Telegram bot entry point (Arabic UI, button-driven).
// Running under PM2 (ecosystem.config.cjs): edits to src/ auto-restart it.
//
// Main menu (reply keyboard):
//   🔍 فحص يوزر  🎲 توليد يوزر
//   🔬 بحث عميق  🧩 صيغ بديلة
//   ⚙️ المنصة     ❓مساعدة
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
import { closeBrowser, findBrowser } from './browser.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env (get one from @BotFather)');
  process.exit(1);
}

const MAX_PER_CHECK = 10;
const MAX_PER_GEN = 20;
// Keep the check workers in step with the browser page pool (browser.js).
const PARALLEL = Math.max(1, Number(process.env.CHECK_PARALLEL) || 4);

/** chatId -> { platforms: string[], awaiting: 'check'|'scan'|'deep'|null, genMode: string, genCount: number } */
const chats = new Map();
const WAITING = ['check', 'scan', 'deep'];
function stateOf(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, { platforms: [...ALL_PLATFORMS], awaiting: null, genMode: 'normal', genCount: 8 });
  }
  const st = chats.get(chatId);
  // Sanitize: never keep a platform key we don't know about.
  const valid = (st.platforms || []).filter((p) => p === 'tiktok' || p === 'instagram');
  st.platforms = valid.length ? [...new Set(valid)] : [...ALL_PLATFORMS];
  st.awaiting = WAITING.includes(st.awaiting) ? st.awaiting : null;
  if (!MODE_KEYS.includes(st.genMode)) st.genMode = 'normal';
  if (!Number.isFinite(st.genCount) || st.genCount < 1 || st.genCount > MAX_PER_GEN) {
    st.genCount = 8;
  }
  return st;
}

const bot = new Bot(TOKEN);

const HELP = [
  '<b>🔎 بوت البحث عن يوزرات غير محجوزة</b> (تيكتوك + انستا)',
  '',
  '<b>استخدم الأزرار القائمة تحت:</b>',
  '🔍 <b>فحص يوزر</b> — تكتب الأسماء وهو يفحصها',
  '🎲 <b>توليد يوزر</b> — يولّد ويقولك أنهيهم متاحين',
  '🔬 <b>بحث عميق</b> — يدور بعمق على أي يوزر متاح فعلياً ويأكّده بفحصين',
  '🧩 <b>صيغ بديلة</b> — صيغ مختلفة لاسم أساسي (ahmad.x, theahmad...)',
  '⚙️ <b>المنصة</b> — تيكتوك بس / انستا بس / الاتنين',
  '❓ <b>مساعدة</b> — الرسالة دي',
  '',
  '<b>أنواع التوليد:</b>',
  'عادي (nova42) • مميز (the.nova.official)',
  'ثلاثي (kr1, a.b) • رباعي (rh23, zx42)',
  'شبه ثلاثي (kr.1, ab12) • شبه رباعي (rh234, ab.xy)',
  '',
  '<b>أوامر مكتوبة (اختياري):</b>',
  '/check &lt;user1&gt; [user2] — فحص أسماء (حد أقصى10)',
  '/gen [العدد] [النوع] — توليد وفحص (حد أقصى20)',
  '/deep [كلمة] [النوع] — بحث عميق يعرض المتاح المؤكد بس',
  '/scan &lt;الاسم&gt; [العدد] — صيغ بديلة',
  '/platform — اختيار المنصة',
  '',
  '✅ غير محجوز | ❌ محجوز | ⚠️ متأكدش (حظر مؤقت — جرّب تاني)',
  '',
  '⚠️ النتيجة بتتخزن6 ساعات — راجع اليوزر بـ /check قبل ما تسجله.',
].join('\n');

/* ------------------------------ keyboards ------------------------------ */

function mainKeyboard() {
  return new Keyboard()
    .text('🔍 فحص يوزر')
    .text('🎲 توليد يوزر')
    .row()
    .text('🔬 بحث عميق')
    .text('🧩 صيغ بديلة')
    .row()
    .text('⚙️ المنصة')
    .text('❓مساعدة')
    .resized();
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

function genModeKeyboard(count) {
  return new InlineKeyboard()
    .text(`🎲 ${GEN_MODES.normal.label}`, 'gen:normal')
    .text(`💎 ${GEN_MODES.premium.label}`, 'gen:premium')
    .row()
    .text(`🔹 ${GEN_MODES.tri.label}`, 'gen:tri')
    .text(`🔹 ${GEN_MODES.quad.label}`, 'gen:quad')
    .row()
    .text(`✨ ${GEN_MODES.quasi3.label}`, 'gen:quasi3')
    .text(`🔸 ${GEN_MODES.quasi4.label}`, 'gen:quasi4')
    .row()
    .text(count === 6 ? '✅6 يوزرات' : '6 يوزرات', 'cnt:6')
    .text(count === 10 ? '✅10 يوزرات' : '10 يوزرات', 'cnt:10')
    .text(count === 16 ? '✅16 يوزر' : '16 يوزر', 'cnt:16');
}

/** Buttons under a finished batch: repeat it or pick another style. */
function againKeyboard(mode) {
  return new InlineKeyboard()
    .text('🎲 توليد مرة أخرى', `gen:${mode}`)
    .text('🔁 نوع توليد تاني', 'modes:open')
    .row()
    .text('🔬 بحث عميق بنفس النوع', `deep:${mode}`);
}

function parseHandles(raw) {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
}

/** Edits a status message at most every 2s to stay under Telegram limits. */
function progressEditor(ctx, messageId) {
  let last = 0;
  return async (done, total, note = 'بيفحص') => {
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

async function runCheck(ctx, names) {
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
    return `${free ? '🎯 ' : ''}<b>@${name}</b>\n${parts.join('\n')}`;
  });

  const freeCount = rows.filter((r) => r.startsWith('🎯')).length;
  const footer = freeCount
    ? `\n\n🎯 يوزرات متاحة (مؤكدة بفحصين): ${freeCount}`
    : '\n\nمفيش يوزرات متاحة في القائمة دي.';
  await ctx.api
    .editMessageText(ctx.chat.id, msg.message_id, rows.join('\n\n') + footer, {
      parse_mode: 'HTML',
    })
    .catch(() => {});
}

/* The user asked for a delivery, not a report: keep searching until the
   requested number is really on the table. Hard caps (checks + minutes) still
   apply so an impossible type cannot hang the bot forever. */
const GEN_MAX_CHECKS = (target) => Math.min(150, target * 10 + 15);
const GEN_TIME_BUDGET = 10 * 60_000;

/* Short types (3-4 letters) are practically all registered. Instead of
   answering "nothing found", widen one step at a time - and LABEL every widened
   hit with its real type - so the user still gets usable, verified names. */
const GEN_WIDEN = {
  tri: ['tri', 'quasi3'],
  quad: ['quad', 'quasi4'],
  quasi3: ['quasi3', 'tri', 'quad'],
  quasi4: ['quasi4', 'quasi3', 'normal'],
  premium: ['premium', 'normal'],
  normal: ['normal', 'premium'],
};

async function runGen(ctx, mode, count) {
  const st = stateOf(ctx.chat.id);
  st.genMode = mode;
  const { platforms } = st;
  const order = GEN_WIDEN[mode] || [mode];
  const label = GEN_MODES[mode].label;
  const platform = platforms[0];

  const target = Math.max(1, Number(count) || 8);
  const maxChecks = GEN_MAX_CHECKS(target);

  const msg = await ctx.reply(
    `🎲 توليد <b>${label}</b> — هدور <b>لحد ما ألاقي ${target}</b> يوزر متاح مؤكد` +
      ` (ممكن ياخد لحد ~10 دقايق لو النوع ده نادر). لو قلّ <b>${label}</b> هوسّع` +
      ` لحد الأنواع المجاورة وأكتبلك نوع كل اسم. على ${platforms
        .map((p) => RULES[p].label)
        .join(' + ')} ...`,
    { parse_mode: 'HTML' }
  );

  const started = Date.now();
  const seen = new Set();
  const found = new Map(); // name -> { mode, ps: [platforms where it is free] }
  const unknownSet = new Set();
  let checked = 0;
  let taken = 0;
  let unknown = 0;
  let waveIndex = 0;
  let lastEdit = 0;

  const stopReason = () => {
    if (found.size >= target) return 'وصلت للعدد المطلوب ✅';
    if (checked >= maxChecks) return 'وصلت لأقصى عدد فحوصات';
    return 'خلص الوقت المحدد';
  };

  const progress = async (note = 'بيفحص') => {
    const now = Date.now();
    if (now - lastEdit < 2500) return;
    lastEdit = now;
    const filled = Math.min(10, Math.round((checked / maxChecks) * 10));
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        msg.message_id,
        `🎲 ${label}\n${note} ${checked}/${maxChecks} فحص` +
          ` — 🎯 لقيت ${found.size}/${target}` +
          `\n[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]`
      )
      .catch(() => {});
  };

  const consider = (name, res, waveMode) => {
    const freeOn = platforms.filter((p) => res[p] === FREE);
    if (freeOn.length) {
      found.set(name, { mode: waveMode, ps: freeOn });
      unknownSet.delete(name);
      return;
    }
    // A single firm "taken" on any platform settles the name; only when
    // nobody answered at all do we keep it out as uncertain.
    if (platforms.some((p) => res[p] === TAKEN)) {
      taken += 1;
      unknownSet.delete(name);
      return;
    }
    if (!unknownSet.has(name)) {
      unknownSet.add(name);
      unknown += 1;
    }
  };

  const budgetLeft = () =>
    found.size < target && checked < maxChecks && Date.now() - started < GEN_TIME_BUDGET;

  // If every platform is cooling down from throttling, wait out the shortest
  // cooldown instead of burning checks on guaranteed-"unknown" answers.
  const waitOutCooldown = async () => {
    const left = platforms.map((p) => platformCooldown(p)).filter((ms) => ms > 0);
    if (!left.length) return;
    await progress('المنصات راجعة من الحظر — مستني شوية');
    await new Promise((r) => setTimeout(r, Math.min(15_000, ...left)));
  };

  // --- wave after wave of fresh candidates until the target is met -------
  while (budgetLeft()) {
    const step =
      waveIndex < 4 ? 0 : Math.min(order.length - 1, Math.floor((waveIndex - 4) / 3) + 1);
    const waveMode = order[step];
    waveIndex += 1;

    const wave = generateCandidates(Math.max(target * 2, 12), {
      platform,
      mode: waveMode,
    }).filter((n) => !seen.has(n.toLowerCase()));
    if (!wave.length) {
      if (step >= order.length - 1) break; // the whole ladder is dry
      continue;
    }
    for (const n of wave) seen.add(n.toLowerCase());

    const rows = await mapPool(wave, PARALLEL, async (name) => {
      if (!budgetLeft()) return null;
      await waitOutCooldown();
      if (!budgetLeft()) return null;
      checked += 1;
      const res = await checkOn(name, platforms);
      await progress(step > 0 ? `بيوسّع: ${GEN_MODES[waveMode].label}` : 'بيفحص');
      return { name, res, waveMode };
    });

    for (const row of rows) {
      if (!row) continue;
      consider(row.name, row.res, row.waveMode);
      if (found.size >= target) break;
    }
  }

  // --- an "unknown" is usually a transient throttle: give it one more go --
  if (found.size < target && unknownSet.size) {
    const retry = [...unknownSet].slice(0, 20);
    for (const name of retry) {
      if (!budgetLeft()) break;
      await waitOutCooldown();
      if (!budgetLeft()) break;
      checked += 1;
      unknown = Math.max(0, unknown - 1);
      consider(name, await checkOn(name, platforms, { fresh: true }), mode);
      await progress('برجّع المش مؤكد');
    }
  }

  const freeRows = [...found.entries()].map(([name, info]) => {
    const typeTag = info.mode === mode ? '' : ` (${GEN_MODES[info.mode].label})`;
    return `  • @${name}${typeTag} — ${info.ps.map((p) => RULES[p].label).join('+')}`;
  });
  const widened = [...found.values()].filter((i) => i.mode !== mode).length;
  const stats =
    `\n\n📊 فحصت <b>${checked}</b> يوزر (${stopReason()}):` +
    ` <b>${found.size}</b> متاحة ✅` +
    ` — ${taken} محجوز ❌` +
    (unknown ? ` — ${unknown} مش مؤكد (مخفى) ⚠️` : '') +
    (widened ? `\n🔎 منه ${widened} من الأنواع المجاورة (مكتوب جنبها نوعها)` : '');

  const body = freeRows.length
    ? (found.size >= target
        ? `🎯 <b>تمام — ${target} يوزر متاح مؤكد:</b>\n`
        : `🎯 <b>لقيت ${found.size} من ${target} لحد دلوقتي:</b>\n`) + freeRows.join('\n')
    : `🔍 فحصت <b>${checked}</b> يوزر وكلهم محجوزين أو المنصات كانت مقفولة (حظر مؤقت).` +
      ' البوت مش بوريك غير المتاح فعلًا — عشان كده مفيش اسم يظهر دلوقتي.';

  await ctx.api
    .editMessageText(ctx.chat.id, msg.message_id, body + stats, {
      parse_mode: 'HTML',
      reply_markup: againKeyboard(mode),
    })
    .catch(() => {});
}

async function runScan(ctx, base, limit) {
  const st = stateOf(ctx.chat.id);
  const { platforms } = st;
  const platform = platforms[0];

  const list = variations(base, { platform, limit });
  if (!list.length) return ctx.reply('الاسم ده مش صالح كيوزر في المنصة دي.');

  const msg = await ctx.reply(
    `🧩 ${list.length} صيغة لـ <b>${base}</b> على ${RULES[platform].label} ...`,
    { parse_mode: 'HTML' }
  );
  const update = progressEditor(ctx, msg.message_id);

  const rows = await mapPool(list, PARALLEL, async (name, i) => {
    const status = await checkUsername(name, platform);
    await update(i + 1, list.length, 'بيجرب');
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
          `🧩 مافيش في الصيغ المباشرة — بيدوس أوسع حول <b>${base}</b> (${extra.length} تركيبة) ...`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      const more = await mapPool(extra, PARALLEL, async (name, i) => {
        const status = await checkUsername(name, platform);
        await update(i + 1, extra.length, 'بيركّب تركيبات');
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
    : `لسه مالقيت صيغة متاحة حول <b>${base}</b> بعد ${rows.length} محاولة — الاسم ده شعبي جدًا.`;
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
async function runDeep(ctx, base, mode) {
  const st = stateOf(ctx.chat.id);
  const { platforms } = st;
  const labels = platforms.map((p) => RULES[p].label).join(' + ');
  const withBase = !!base && !['random', 'عشوائي', 'عشوائى'].includes(base.toLowerCase());
  const scope = withBase ? `كلمة <b>${base}</b>` : `نوع <b>${GEN_MODES[mode].label}</b>`;

  const msg = await ctx.reply(
    `🔬 بحث عميق (${scope}) على ${labels}\n` +
      'هفحص دفعة كبيرة وأعرض المتاح <b>المؤكد</b> بس (فحصين لكل اسم)...',
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
          `🔬 بحث عميق (${scope})\nبيفحص ${checked}/${total}` +
            `\n🎯 لقيت ${free} متاح لحد دلوقتي` +
            (unknown ? ` | ⚠️ ${unknown} متأكدش` : '')
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
    (result.stoppedEarly ? ' ووقفت بعد ما لقيت الكفاية ✅' : '');
  const body = lines.length
    ? lines.join('\n\n')
    : 'مفيش يوزر متاح مؤكد في الدفعة دي — جرّب كلمة/نوع تاني أو ارجع اضغط 🔬 تاني بعد شوية.';
  const note =
    `\n\n💡 <b>مهم:</b> كل اسم ده اتأكد منه مرتين (فحص تاني من غير كاش).` +
    `\nسجّل بسرعة قبل ما حد ياخدو، وراجعه بـ /check قبل التسجيل.` +
    worstCaseNote(result.unknown);

  st.lastDeep = { base: withBase ? base : null, mode };
  await ctx.api
    .editMessageText(ctx.chat.id, msg.message_id, `${header}\n\n${body}${note}`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('🔬 بحث تاني بنفس الكلمة', 'deep:again')
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
  ctx.reply('اختار المنصة اللي عايز تفحص عليها:', {
    reply_markup: platformKeyboard(ctx.chat.id),
  })
);

bot.callbackQuery(/^pf:(tiktok|instagram|both)$/, async (ctx) => {
  // ctx.match[1] is the platform key itself ('tiktok'), NOT 'pf:tiktok'.
  const arg = ctx.match?.[1] || ctx.callbackQuery.data.split(':')[1];
  const st = stateOf(ctx.chat.id);
  st.platforms = arg === 'both' ? [...ALL_PLATFORMS] : [arg];
  await ctx.answerCallbackQuery({ text: 'تمام، اتحفظ ✔️' });
  // Same text/keyboard = Telegram returns "message is not modified"; ignore it.
  await ctx
    .editMessageText('اختار المنصة اللي عايز تفحص عليها:', {
      reply_markup: platformKeyboard(ctx.chat.id),
    })
    .catch(() => {});
});

bot.callbackQuery(/^gen:([a-z0-9]+)$/, async (ctx) => {
  const mode = GEN_MODES[ctx.match?.[1]] ? ctx.match[1] : 'normal';
  await ctx.answerCallbackQuery({ text: `توليد ${GEN_MODES[mode].label} ✔️` }).catch(() => {});
  const count = stateOf(ctx.chat.id).genCount;
  await runGen(ctx, mode, count).catch((e) => console.error('gen error:', e));
});

bot.callbackQuery(/^cnt:(\d+)$/, async (ctx) => {
  const n = Math.min(Math.max(Number(ctx.match?.[1]) || 8, 1), MAX_PER_GEN);
  const st = stateOf(ctx.chat.id);
  st.genCount = n;
  await ctx.answerCallbackQuery({ text: `العدد بقى ${n} يوزرات ✔️` }).catch(() => {});
  await ctx
    .editMessageText(`اختار نوع التوليد (عدد: ${st.genCount}):`, {
      reply_markup: genModeKeyboard(st.genCount),
    })
    .catch(() => {});
});

bot.callbackQuery('modes:open', async (ctx) => {
  const st = stateOf(ctx.chat.id);
  await ctx.answerCallbackQuery({ text: 'اختار النوع 👇' }).catch(() => {});
  await ctx
    .reply(`اختار نوع التوليد (عدد: ${st.genCount}):`, {
      reply_markup: genModeKeyboard(st.genCount),
    })
    .catch(() => {});
});

bot.callbackQuery('deep:again', async (ctx) => {
  const st = stateOf(ctx.chat.id);
  await ctx.answerCallbackQuery({ text: 'بحث عميق تاني 🔬' }).catch(() => {});
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
  const count = Math.min(Math.max(Number(args[0]) || 8, 1), MAX_PER_GEN);
  const mode = MODE_KEYS.includes(args[1]) ? args[1] : 'normal';
  await runGen(ctx, mode, count);
});

bot.command('deep', async (ctx) => {
  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  const mode = MODE_KEYS.includes(args[1]) ? args[1] : stateOf(ctx.chat.id).genMode;
  await runDeep(ctx, args[0] ? args[0].replace(/^@/, '') : null, mode);
});

bot.command('scan', async (ctx) => {
  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  if (!args[0]) return showMenu(ctx, 'الاستخدام: <code>/scan ahmad 10</code>\nأو اضغط 🧩 صيغ بديلة من القائمة.');
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
      return showMenu(ctx, 'ابعتلي اليوزر(s) اللي عايز تفحصها (الأسماء متعددة بفواصل أو مسافات):');
    case '🎲 توليد يوزر':
      return ctx.reply(`اختار نوع التوليد (دلوقتي ${st.genCount} يوزرات):`, {
        reply_markup: genModeKeyboard(st.genCount),
      });
    case '🔬 بحث عميق':
      st.awaiting = 'deep';
      return showMenu(
        ctx,
        '🔬 <b>بحث عميق</b> — ابعتلي كلمة أساسية تدوّر حواليها (زي <code>gamer</code> أو <code>ahmad</code>),' +
          '\nأو اكتب <code>random</code> لبحث عشوائي شامل.' +
          '\nممكن تزود النوع كمان: <code>gamer quad</code> أو <code>random premium</code>'
      );
    case '🧩 صيغ بديلة':
      st.awaiting = 'scan';
      return showMenu(ctx, 'ابعتلي الاسم الأساسي زي <code>ahmad</code> وهجرب الصيغ اللي حواليه:');
    case '⚙️ المنصة':
      return ctx.reply('اختار المنصة اللي عايز تفحص عليها:', {
        reply_markup: platformKeyboard(ctx.chat.id),
      });
    case '❓مساعدة':
      return showMenu(ctx, HELP);
    default:
      break;
  }

  // --- pending mode from a menu button ---
  if (st.awaiting === 'check') {
    st.awaiting = null;
    const names = parseHandles(text).slice(0, MAX_PER_CHECK);
    if (!names.length) return showMenu(ctx, 'ابعتلي أسماء صحيحة زي: <code>ahmad, sara_x</code>');
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
    const mode = MODE_KEYS.includes(maybeMode) ? maybeMode : st.genMode;
    return runDeep(ctx, word.replace(/^@/, ''), mode);
  }

  // --- bare handle = quick check ---
  if (/^@?[a-zA-Z0-9._]{1,30}$/.test(text)) {
    return runCheck(ctx, [text.replace(/^@/, '')]);
  }

  return showMenu(ctx, 'اضغط أحد الأزرار تحت 👇 أو اكتب /help');
});

bot.catch(async (err) => {
  console.error('bot error:', err.error ?? err);
  // Never leave the user staring at silence after a failed command.
  try {
    await err.ctx.reply('⚠️ حصل خطأ أثناء تنفيذ الأمر — جرّب تاني بعد شوية.\nلو كرر ابعت /help من الأول.');
  } catch {
    /* ignore */
  }
});

/* ------------------------------ lifecycle ------------------------------ */

async function shutdown(signal) {
  console.log(`\n${signal} - closing browser...`);
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
export { runGen, runScan, runDeep, runCheck };

if (process.env.DISABLE_POLLING !== '1') {
  bot.start({
    onStart: (me) => console.log(`Bot running as @${me.username}`),
    drop_pending_updates: true,
  });
}

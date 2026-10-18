process.env.DISABLE_POLLING = '1';

const { runGen } = await import('./src/index.js');

const strip = (t) =>
  String(t)
    .replace(/<[^>]+>/g, '')
    .replace(/\n+/g, ' | ');

const ctx = {
  chat: { id: 1 },
  reply: async (t) => {
    console.log(`\n[reply] ${strip(t)}`);
    return { message_id: 1 };
  },
  api: {
    editMessageText: async (_c, _m, t) => {
      console.log(`[edit] ${strip(t)}`);
      return {};
    },
  },
};

console.log('=== runGen: mode=quasi3 target=3 ===');
const t0 = Date.now();
await runGen(ctx, 'quasi3', 3);
console.log(`took ${Math.round((Date.now() - t0) / 1000)}s`);

const { closeBrowser } = await import('./src/browser.js');
await closeBrowser().catch(() => {});
console.log('DONE');
process.exit(0);

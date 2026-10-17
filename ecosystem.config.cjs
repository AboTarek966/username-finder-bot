// PM2 config: keeps the bot running 24/7.
//   pm2 start ecosystem.config.cjs   -> start + auto-restart on crash
//   pm2 save                        -> remember the list
//   pm2 resurrect                   -> bring it back after a reboot
//
// `watch` makes pm2 restart the bot automatically whenever a file in src/
// changes, so every edit/update goes live on its own.

module.exports = {
  apps: [
    {
      name: 'username-finder',
      script: 'src/index.js',
      watch: 'src',
      ignore_watch: ['node_modules', '.git'],
      max_memory_restart: '600M',
      // If a check wedges (network stall), restart instead of hanging forever.
      min_uptime: '10s',
      max_restarts: 20,
    },
  ],
};

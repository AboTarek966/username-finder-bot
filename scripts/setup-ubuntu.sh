#!/usr/bin/env bash
# One-time setup for a plain Ubuntu/Debian VPS (no Docker needed).
#   scp -r username-finder-bot/ user@SERVER:~
#   ssh user@SERVER
#   cd username-finder-bot && bash scripts/setup-ubuntu.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==>1) Node.js22"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==>2) Google Chrome (the headless browser the checker renders pages with)"
if [ ! -x /usr/bin/google-chrome-stable ] && [ ! -x /usr/bin/google-chrome ]; then
  sudo apt-get update
  sudo apt-get install -y wget gnupg fonts-liberation libnss3 libatk-bridge2.0-0 \
    libgtk-3-0 libx11-xcb1 libasound2t64 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0
  wget -q "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" -O /tmp/chrome.deb
  sudo apt-get install -y /tmp/chrome.deb || sudo dpkg -i /tmp/chrome.deb
fi

echo "==>3) pm2 + project dependencies"
sudo npm install -g pm2
npm install

echo "==>4) Start the bot for good"
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u "$USER" --cwd "$PWD" || true

echo
echo "✅ Done. Useful commands:"
echo "   pm2 status                    # is it online?"
echo "   pm2 logs username-finder      # live logs"
echo "   pm2 restart username-finder   # manual restart"

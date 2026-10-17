# Runs the bot in a container so any VPS/host can keep it alive 24/7.
# Build & run (or use docker-compose.yml, which is easier).

FROM node:22-slim

# Chromium = the real browser the checker needs. Chrome itself also works
# but Chromium is smaller and is what most server images ship.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Point the bot at the browser we just installed.
ENV BROWSER_PATH=/usr/bin/chromium \
    BROWSER_PAGES=4 \
    CHECK_PARALLEL=4 \
    NODE_ENV=production

WORKDIR /app

# Dependencies first (cached unless package.json changes).
COPY package*.json ./
RUN npm install --omit=dev

# App source.
COPY src ./src
COPY ecosystem.config.cjs ./

# pm2-runtime keeps the app alive inside the container and stays in the
# foreground so the container itself never exits.
RUN npm install -g pm2
CMD ["pm2-runtime", "start", "ecosystem.config.cjs"]

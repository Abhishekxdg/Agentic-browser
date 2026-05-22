FROM oven/bun:1.3 AS base

RUN apt-get update && apt-get install -y \
  chromium \
  chromium-sandbox \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_PATH=/usr/bin/chromium
ENV HEADLESS=true

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

EXPOSE 3001
CMD ["bun", "run", "src/agent-browser/server.ts"]

# Hypit + remote MCP server, for Railway (or any Docker host).
# The image carries the Hypit Distribution at /app and the MCP server at /app/mcp-server.
# Projects, prepared browsers, Python helpers and caches live under /data: mount a volume there.
FROM node:24.14.1-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_DOWNLOAD=1

# FFmpeg for local media; shared libraries and fonts for the managed Chrome Headless Shell that
# @hypit/provider-html-local downloads on first use; git/python3 for project tooling; tini as PID 1
# so detached Hypit Workers are reaped.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 tini unzip xz-utils \
      ffmpeg \
      fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 \
      libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
 && rm -rf /var/lib/apt/lists/*

# uv builds the locked Python environments of local Programs (OpenCV, yt-dlp, WhisperX).
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /usr/local/bin/

RUN npm install --global --no-audit --no-fund pnpm@10.33.0

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile \
 && pnpm build:public-types \
 && ln -s /app/hypit /usr/local/bin/hypit \
 && hypit --version

RUN cd mcp-server \
 && npm ci --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

# HOME on the volume keeps Chrome (~/.cache/hypit), Hypit host state (~/.local/state/hypit),
# uv and npm caches across deploys.
ENV HOME=/data/home \
    HYPIT_HOME=/app \
    HYPIT_WORKSPACE=/data/projects \
    HYPIT_JOBS_DIR=/data/jobs \
    PORT=8080

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/app/mcp-server/docker-entrypoint.sh"]

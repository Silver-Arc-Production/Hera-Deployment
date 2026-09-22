# syntax=docker/dockerfile:1

# The bot and the dashboard are both Node. `node:sqlite` needs Node 22.5+, and
# this glibc image is what the prebuilt @napi-rs/canvas binary links against, so
# no compiler or system library install is required.
FROM node:22-bookworm-slim

# NODE_ENV stays unset until after the build: typescript and tsx are dev
# dependencies, and `npm ci` skips them when NODE_ENV=production. The dashboard
# port is read from WEB_PORT at runtime.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app

# Dependencies first: editing application code then doesn't invalidate this
# layer. `npm ci` is reproducible from the lockfile checked into the repo.
COPY package.json package-lock.json ./
RUN npm ci

# Everything the compiler and the runtime read.
COPY tsconfig.json tsconfig.build.json ./
COPY hera/ ./hera/
COPY dashboard/ ./dashboard/
COPY scripts/ ./scripts/

# `npm prune` drops typescript and tsx once dist/ exists, so the runtime image
# carries only the shipped dependencies.
RUN npm run build \
 && npm prune --omit=dev \
 && npm cache clean --force

# The runtime user is created after the sources are copied so they can be
# chowned in one step. A platform that mounts a disk grants ownership of it to
# the group configured in the image, so this gid is what the disk gets chowned to.
RUN groupadd --gid 10001 hera \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin hera \
 && chmod -R a+rX /app/hera /app/dashboard /app/dist /app/node_modules \
 && mkdir -p /data \
 && chown -R hera:hera /data

# The dashboard binds a port, so a deployment that serves it must publish this.
EXPOSE 8080

# The SQLite file holding every balance and position. A host that wants durable
# data must mount a persistent volume at /data, otherwise each redeploy resets
# the whole economy.
VOLUME ["/data"]
ENV DATABASE_PATH=/data/hera.db \
    NODE_ENV=production

USER 10001:10001

# CMD starts the bot, which also serves the dashboard when WEB_ENABLED=true.
# `dockerCommand` can instead run `node dist/dashboard/index.js` for a
# dashboard-only container. Docker sends SIGTERM on stop/restart, and both
# entrypoints turn that into a graceful shutdown: the dashboard stops, then the
# ticker is cancelled and the database closed. SQLite's WAL mode makes even an
# abrupt kill safe, so no committed tick is lost either way.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/hera/index.js"]

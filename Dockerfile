# The shop as a self-contained image, for any Docker host. Production today
# runs from a Pterodactyl egg (git pull, npm install, node server.js on boot);
# this reproduces the same app with the data on a mounted volume (DATA_DIR).
#
#   docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t reforgedz-shop .
#   see compose.yaml for the run side and docs/MIGRATION.md for the whole move.

FROM node:24-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 and ssh2 compile native parts when no prebuilt binary matches;
# the full image carries the toolchain, the runtime image below does not.
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
ARG GIT_SHA=unknown
ENV SHOP_VERSION=$GIT_SHA \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/shop/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

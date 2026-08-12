# ─── aster build stage (Rust) ─────────────────────────────────────────────────
# aster publishes no prebuilt release binaries yet, so we compile the CLI from
# source. Pinned to a commit for reproducible builds — bump ASTER_REF to update.
FROM rust:1-bookworm AS aster-build
ARG ASTER_REF=58ddc5c7e4da14f267c2e4c62e3dc123e956240d
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev libsqlite3-dev build-essential cmake git \
 && rm -rf /var/lib/apt/lists/*
RUN cargo install \
      --git https://github.com/Zfinix/aster \
      --rev "${ASTER_REF}" \
      --locked \
      aster-cli \
 && /usr/local/cargo/bin/aster --version

# ─── node build stage ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# Runtime libs aster links against + git/ca-certs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git libssl3 libsqlite3-0 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=aster-build /usr/local/cargo/bin/aster /usr/local/bin/aster
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
RUN aster --version

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]

# syntax=docker/dockerfile:1

# ---- deps: every dependency (build + evaluation) ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# onnxruntime-node only needs its bundled CPU binaries; skip the optional CUDA download.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript, keep production dependencies ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- eval: HTTP evaluation runner (`docker compose --profile eval run --rm eval`) ----
FROM deps AS eval
COPY tsconfig.json ./
COPY src ./src
COPY eval ./eval
COPY data ./data
ENTRYPOINT ["npx", "tsx", "eval/run.ts"]

# ---- runtime (default target) ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# `GIT_SHA=$(git rev-parse --short HEAD) docker compose build` stamps the image; /health reports it.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA} \
    NODE_ENV=production \
    MODEL_CACHE_DIR=/app/.models \
    PORT=3000 \
    DB_PATH=/app/var/app.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY data ./data
# Download the embedding model at build time so the container starts offline and fast.
RUN node -e "import('./dist/rag/embedder.js').then(async m => { await new m.E5Embedder().embedQuery('warmup'); console.log('embedding model cached'); })"
# SQLite database and the generated JWT key live in /app/var (a named volume in compose).
RUN mkdir -p /app/var && chown -R node:node /app
USER node
VOLUME /app/var
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]

# syntax=docker/dockerfile:1

# ---- build: compile TypeScript ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# onnxruntime-node only needs its bundled CPU binaries; skip the optional CUDA download.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MODEL_CACHE_DIR=/app/.models \
    PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY data ./data
# Download the embedding model at build time so the container starts offline and fast.
RUN node -e "import('./dist/rag/embedder.js').then(async m => { await new m.E5Embedder().embedQuery('warmup'); console.log('embedding model cached'); })"
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

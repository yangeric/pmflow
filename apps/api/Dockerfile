# PMFlow API — Node 22 / Fastify / PostgreSQL
# 多階段建置：builder 裝 devDependencies 編譯 TypeScript，
# 最終映像只留 production 相依與編譯結果。

# ─── Stage 1：安裝相依 ───────────────────────────────────
#
# `--platform=$BUILDPLATFORM`＝**永遠用建置機器自己的架構跑這一段**，不要模擬。
#
# 沒有這行的話，建 arm64 映像時 npm ci 會在 QEMU 底下跑，而 Node 在模擬的
# arm64 上會直接 `uncaught target signal 4 (Illegal instruction) - core dumped`，
# release workflow 就停在那裡不動。
#
# 前提：**相依全部是純 JavaScript**（fastify / postgres / jose / zod），
# 沒有原生模組，所以裝出來的 node_modules 兩種架構通用。
# 哪天加了會編 C 的套件（bcrypt、sharp、better-sqlite3…），這裡就不能再跨架構裝，
# 得改成在目標架構上安裝，或改用預編好的 binary。
FROM --platform=$BUILDPLATFORM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && cp -R node_modules /prod_node_modules && npm ci

# ─── Stage 2：編譯 ──────────────────────────────────────
# 同上：tsc 產出的是 JavaScript，跟架構無關
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ─── Stage 3：執行 ──────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

RUN apk add --no-cache tzdata wget \
 && addgroup -g 10001 -S pmflow \
 && adduser  -u 10001 -S pmflow -G pmflow \
 && mkdir -p /data/attachments \
 && chown -R pmflow:pmflow /data /app

ENV NODE_ENV=production TZ=Asia/Taipei

COPY --from=deps    --chown=pmflow:pmflow /prod_node_modules ./node_modules
COPY --from=builder --chown=pmflow:pmflow /app/dist ./dist
# migration 是 .sql，tsc 不會複製，要自己搬
COPY --chown=pmflow:pmflow src/migrations ./dist/migrations
COPY --chown=pmflow:pmflow package.json ./

USER 10001
EXPOSE 8080
VOLUME ["/data/attachments"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/index.js"]

LABEL org.opencontainers.image.title="PMFlow API" \
      org.opencontainers.image.description="開源專案管理系統後端" \
      org.opencontainers.image.licenses="MIT"

# PMFlow Web — React 19 + Vite，由 Caddy 提供靜態檔並反向代理 /api
# 只暴露這一個容器對外，後端與資料庫留在內部網路。

# ─── Stage 1：建置 ──────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# 授權掃描擋在 build 裡：哪天有人 PR 進 GPL 套件，這裡就會失敗。
# 專案要維持 MIT，這道關卡比事後才發現便宜太多。
RUN npm run build

# ─── Stage 2：執行 ──────────────────────────────────────
FROM caddy:2-alpine
COPY --from=builder /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80

LABEL org.opencontainers.image.title="PMFlow Web" \
      org.opencontainers.image.description="開源專案管理系統前端" \
      org.opencontainers.image.licenses="MIT"

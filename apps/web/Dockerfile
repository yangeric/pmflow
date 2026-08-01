# PMFlow Web — React 19 + Vite，由 Caddy 提供靜態檔並反向代理 /api
# 只暴露這一個容器對外，後端與資料庫留在內部網路。

# ─── Stage 1：建置 ──────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# 授權白名單掃描刻意不放在這裡，只留在 ci.yml 的 license-scan job。
# 放進 Dockerfile 的話 amd64 / arm64 兩份映像會各再跑一次同樣的檢查，
# 而 arm64 是在 QEMU 模擬下建置的，npx 下載加掃描很容易拖到超時。
RUN npm run build

# ─── Stage 2：執行 ──────────────────────────────────────
FROM caddy:2-alpine
COPY --from=builder /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80

LABEL org.opencontainers.image.title="PMFlow Web" \
      org.opencontainers.image.description="開源專案管理系統前端" \
      org.opencontainers.image.licenses="MIT"

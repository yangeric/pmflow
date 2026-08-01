#!/usr/bin/env bash
# PMFlow 一鍵啟動（macOS / Linux）
# 這台電腦只需要安裝 Docker，不用裝 Node 或 PostgreSQL。
set -e

echo
echo "  PMFlow 啟動中…（第一次執行要建置映像，需要幾分鐘）"
echo

docker compose -f docker-compose.dev.yml up --build -d

echo
echo "  ===================================================="
echo "    PMFlow 已啟動： http://localhost:8480"
echo
echo "    示範帳號： demo@pmflow.local"
echo "    密碼：     demo1234"
echo "  ===================================================="
echo
echo "  停止：      docker compose -f docker-compose.dev.yml down"
echo "  清空重來：  docker compose -f docker-compose.dev.yml down -v"
echo "  看日誌：    docker compose -f docker-compose.dev.yml logs -f"
echo

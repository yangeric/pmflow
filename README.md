# PMFlow

開源專案管理系統。任務可以**上下左右關聯**，並且內建**跨單位發文追蹤**。

授權 MIT ｜ Docker 一鍵自架 ｜ 支援 amd64 / arm64（NAS 可跑）

---

## 一分鐘跑起來

你的電腦只需要裝 **Docker Desktop**。不用裝 Node、不用裝 PostgreSQL。

**Windows** — 直接雙擊 `start.bat`

**macOS / Linux**

```bash
./start.sh
```

或者手動：

```bash
docker compose -f docker-compose.dev.yml up --build -d
```

打開 <http://localhost:8480>，用示範帳號登入：

```
demo@pmflow.local
demo1234
```

第一次啟動會自動建立示範資料：兩個專案、八張有階層的任務、四種依賴各一條、四筆發文追蹤（含一筆逾期、一筆轉單位回覆）。

```bash
docker compose -f docker-compose.dev.yml logs -f    # 看日誌
docker compose -f docker-compose.dev.yml down       # 停止
docker compose -f docker-compose.dev.yml down -v    # 清空資料重來
```

---

## 三個核心設計

### 1. 任務關聯拆成三種，刻意分開存

| 方向 | 意義 | 儲存 | 影響排程 |
|---|---|---|---|
| **上下** | 父子階層 / WBS | `task.parent_id` + `task_closure` 閉包表 | 彙總 |
| **左右** | 時序依賴 FS / SS / FF / SF + lag | `task_link` 邊表 | **是** |
| **旁邊** | 語意關聯 relates / blocks / duplicates | `task_link` 邊表（不同 type） | 否 |

市面上十套主流開源 PM 系統，**沒有一套把 FS/SS/FF/SF 四種都做完**——事實標準只有 Finish-to-Start。

排程引擎在後端（`apps/api/src/lib/schedule.ts`）：拓撲排序 → 前向推算 → 後向推算求 total float → 關鍵路徑。dhtmlx-gantt 的自動排程與關鍵路徑是 PRO 功能，我們自己算就繞開了，而且伺服器端算才能保證多人同時操作看到同一份結果。

循環偵測把**階層邊與依賴邊一起看**（`apps/api/src/lib/graph.ts`）。只檢查依賴邊的話，「A 是 B 的父任務、同時 B 又前置於 A」這種混合環會漏掉。

### 2. 跨單位發文追蹤：提問側與回覆側分開存

每張任務底下可以掛多筆詢問單，一筆就是「發文給一個單位」：

| | 欄位 |
|---|---|
| **提問側** | 提給哪個單位、承辦人、聯絡方式、提問日、期望回覆日 |
| **回覆側** | 回了沒、**實際回覆單位**、回覆人、回覆日 |

**回覆單位不一定等於提問單位**——發文給資訊部、實際是他們的委外廠商回，或案子被轉給別的單位承辦。這在機關與大企業裡是常態，所以兩側必須是獨立欄位。共用一欄就記不下這件事。

勾「回了沒」時系統自動帶入提問單位與今天，但兩個欄位都可以改。

這是**純資料欄位，不是身分系統**：外部單位不登入、不收系統信、不填任何表單，一切由我方人員登錄。系統因此只有一種驗證主體，權限模型維持在最不容易出漏洞的形狀。

單位是**自由文字**（沒有主檔、不用先去設定裡新增），但輸入時會列出你在這個工作區用過的名稱當提示，順便讓「資訊部 / 資訊處 / IT」不那麼容易變成三個值。

逾期不存成欄位，而是查詢時算（`v_inquiry` view）——逾期會隨日期自己改變，存下來就得天天更新，漏更新就顯示錯的東西。

因為單位是獨立欄位而不是埋在留言裡，這些查詢才做得出來：各單位平均回覆天數、逾期率排行、「這個月發文給資訊部的都在這」、以及「哪些案子是轉單位回的」。

### 3. 授權從第一天就管

專案要 MIT，所以相依只允許 MIT / Apache-2.0 / BSD / ISC / PostgreSQL。CI 的授權掃描是必須關卡——WeKan 就是因為甘特函式庫是 GPL，最後只能把甘特功能拆成完全獨立的 repo 分開 build。

已查證並排除的地雷：

- `wx-react-gantt` (SVAR) — 1.3.1 起改成 **GPLv3**，但官網行銷頁至今仍寫「MIT licensed core」
- FullCalendar `timeline` / `resource-timeline` — 商業 / CC-BY-NC-ND / GPLv3 三選一，**沒有寬鬆授權出路**
- `dhtmlx-gantt` ≤ 9.1.4 是 GPL-2.0，**只有 10.0.0+ 是 MIT**（所以鎖 `^10`）
- Schedule-X 免費版**不含拖曳與 resize**（在 €479/年的私有 registry）
- MinIO — 2026-04 已封存，AGPL，社群版無預編譯 binary
- Redis 7.4–7.8 **完全不是開源**（RSALv2/SSPL）

CI 會擋掉這些套件，並檢查 `dhtmlx-gantt` 有沒有鎖到 10 以上。

---

## 技術棧

**前端** React 19 + TypeScript + Vite ｜ Tailwind v4 ｜ **dnd-kit**（看板拖曳）｜ **dhtmlx-gantt ^10**（甘特，MIT）｜ TanStack Query

**後端** Node 22 + Fastify + TypeScript ｜ **PostgreSQL 17** ｜ 密碼用 Node 內建 scrypt（零原生相依，Alpine 容器不會有編譯問題）｜ JWT + refresh token rotation + reuse detection

**部署** Caddy（靜態檔 + API 反向代理）｜ Docker Compose ｜ GHCR multi-arch

沒有 Redis、沒有 MinIO、沒有 ORM、沒有 migration 框架。少一個相依就少一個授權風險與一層魔法。

---

## 專案結構

```
apps/api/           後端
  src/lib/
    schedule.ts     排程引擎：四種依賴推算 + 關鍵路徑
    graph.ts        閉包表維護 + 循環偵測
    inquiry.ts      發文追蹤彙總 + 逾期掃描
    auth.ts         scrypt + JWT + 權限檢查
    rank.ts         fractional ranking（拖曳排序只 UPDATE 一列）
  src/routes/       auth / projects / tasks / links / inquiries
  src/migrations/   0001_init.sql（含 uuidv7()、v_inquiry、v_unit_suggestion）
  test/             排程引擎單元測試 + 端對端 API 測試

apps/web/           前端
  src/pages/        Login / List / Board(dnd-kit) / Gantt(dhtmlx) / InquiryBoard
  src/components/   InquiryTable（發文追蹤表格 + 單位 typeahead）/ TaskDrawer

docs/SPEC.md            規格書
docs/ARCHITECTURE.md    13 張 Mermaid 架構圖
docker-compose.dev.yml  本機：從原始碼建置
docker-compose.yml      NAS：拉 GHCR image
```

---

## 測試

```bash
cd apps/api
npx tsx test/schedule.test.ts   # 排程引擎：12 項（四種依賴 / lag / MANUAL 錨點 / 關鍵路徑 / 環）
bash test/e2e.sh               # 端對端：30 項（需要 API 跑在 8080）
```

兩支都可以對同一個資料庫重複執行。

---

## 部署到 NAS

```bash
curl -O https://raw.githubusercontent.com/<你的帳號>/pmflow/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/<你的帳號>/pmflow/main/.env.example

cp .env.example .env
openssl rand -base64 48        # 產生 JWT_SECRET，貼進 .env
# 同時改 POSTGRES_PASSWORD、IMAGE_OWNER、PUID/PGID（用 id <你的帳號> 查）

docker compose pull && docker compose up -d
```

**NAS 最容易踩的三個坑**（完整清單見 `docker-compose.yml` 檔尾）：

1. Synology DSM 佔用 80/443/5000/5001 → 已預設對外映 8480
2. `PUID`/`PGID` 不設會 permission denied（Synology 常是 `1026:100`）
3. **PostgreSQL 資料絕不能放 SMB/CIFS 掛載點**，fsync 語意不對，資料庫遲早損毀

---

## 全自動發版

你要準備的東西：**一個 GitHub repo**。就這樣。

- **不用 Docker Hub 帳號** —— GHCR 內建在 GitHub 裡
- **不用設任何 secret** —— `GITHUB_TOKEN` 本身就有 GHCR 寫入權
- 公開 repo 的 Actions 分鐘數與 GHCR 流量都免費（私人 repo 每月 2000 分鐘也夠用）

流程：push 到 main → release-please 依 commit 訊息自動決定版本號、產 changelog、開一個 Release PR → 你 merge 它 → 自動打 tag、build amd64 + arm64 映像、推 GHCR、附上 SBOM 與 provenance。

版本號規則（Conventional Commits）：

```
fix: 修好某個 bug      → 0.1.0 → 0.1.1
feat: 加了某個功能      → 0.1.0 → 0.2.0
feat!: 破壞相容的改動    → 0.1.0 → 1.0.0
chore: / docs:         不發版
```

Release PR 那一步刻意留給人按，避免每個 commit 都推一個新 image 出去。

---

## 已知限制

- 行事曆視圖還沒做（規格書 §4.3 已設計，用 react-big-calendar）
- 關聯網路圖的後端 API 已經好了（`/projects/:id/graph`），前端 React Flow 還沒接
- 儀表板圖表（燃盡圖、負載熱圖）還沒做
- 即時多人同步還沒接 WebSocket，目前靠 TanStack Query 的重新抓取
- 附件上傳的資料表與 volume 都在，端點還沒實作

---

授權 MIT，見 `LICENSE`。

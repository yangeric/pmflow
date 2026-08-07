# 程式地圖 — 要改東西該去哪個檔

> **這份是「實作」的地圖，照著現在的程式碼寫的。**
> `ARCHITECTURE.md` 是最早的設計稿（Spring Boot / Java / Flyway / STOMP），**跟實作不一致，不要照著它找檔案**。
> 動手前先看 `CHANGELOG.md` 最上面的索引，再回來這裡找檔案。

## 技術棧（實際跑的）

| 層 | 東西 | 位置 |
|---|---|---|
| 前端 | React 19 + Vite + TypeScript + Tailwind + TanStack Query | `apps/web` |
| 後端 | Fastify + TypeScript + zod + `postgres`（porsager，不是 ORM） | `apps/api` |
| 資料庫 | PostgreSQL，**自寫的 append-only migration**（不是 Flyway） | `apps/api/src/migrations` |
| 開發環境 | `docker compose -f docker-compose.dev.yml`，網站在 **:8480** | 根目錄 |

沒有 Redis／Valkey、沒有 WebSocket、沒有寄信、沒有背景排程器 —— 設計稿寫的那些都還沒做。

## 頁面與功能對應清單（接手任務先查這裡）

| 畫面 / 功能 | 檔案位置 (File Path) | 具體功能內容 |
|---|---|---|
| **登入 / 註冊** | `apps/web/src/pages/Login.tsx` | 帳號登入、註冊與第三方帳號綁定 (Google/Apple OAuth 入口) |
| **專案選擇** | `apps/web/src/pages/ProjectPicker.tsx` | 個人專案列表、建立新專案、搜尋與申請加入公開專案 |
| **清單視角** | `apps/web/src/pages/List.tsx` | 樹狀任務層級清單、依狀態/類型篩選與收折、大項目展開 |
| **看板視角** | `apps/web/src/pages/Board.tsx` | 依任務狀態分欄，可直接拖拉卡片切換狀態 |
| **週檢視** | `apps/web/src/pages/Week.tsx` | 檢視當週執行任務、單日視角切換過濾、依類型/狀態分組收合 |
| **行事曆** | `apps/web/src/pages/Calendar.tsx` | 月曆格與跨日長條、拖拉任務改期、登記與管理請假與代理人 |
| **甘特圖** | `apps/web/src/pages/Gantt.tsx` | 時間軸甘特圖、排程依賴箭頭、顯示關鍵路徑與時間連動 |
| **關聯圖** | `apps/web/src/pages/Graph.tsx` | 拓撲關聯圖、卡住源頭追蹤、直線平行向右連線與併欄 |
| **對外詢問看板** | `apps/web/src/pages/InquiryBoard.tsx` | 追蹤專案內對外詢問單（待回覆、逾期統計與回覆紀錄） |
| **儀表板** | `apps/web/src/pages/Dashboard.tsx` | 數據中心：手刻 SVG 燃盡圖 (Burndown) 與負載熱圖 (Workload) |
| **專案側欄** | `apps/web/src/components/EpicSidebar.tsx` | 左側樹狀結構（大項目→任務→錯誤），可點擊 `＋` 建立合法子任務 |
| **任務詳情抽屜** | `apps/web/src/components/TaskDrawer.tsx` | 右側任務詳情面板（修改內容、登錄對外詢問、卡住原因、刪除） |
| **成員頁面板** | `apps/web/src/components/MembersPanel.tsx` | 專案成員列表、邀請成員、審核申請、檢視成員經手任務紀錄 |
| **路由與頁籤中樞** | `apps/web/src/App.tsx` | 前端路由主導、頂部頁籤順序（dnd-kit 拖曳排序與隱藏偏好） |

---

## 一句話決定改哪裡

| 想改的東西 | 去這個檔 |
|---|---|
| 任何 API 的網址、參數、回傳欄位 | `apps/api/src/routes/*.ts` → 對應的 `apps/web/src/lib/api.ts` |
| 資料表結構 | 新增 `apps/api/src/migrations/000N_*.sql`（**舊檔一個字都不能改**，見 `MIGRATIONS.md`） |
| 誰可以做什麼（權限） | `apps/api/src/lib/auth.ts` 的 `require*` 系列 |
| 登入／換 token／登出 | 後端 `routes/auth.ts`，前端 `lib/auth.tsx` |
| 頁籤、切換畫面、選了哪個專案 | `apps/web/src/App.tsx`（**唯一的路由中樞，沒有 react-router**） |
| 甘特／行事曆的日期算法 | 後端 `lib/schedule.ts`（真正的排程），前端 `lib/date.ts`（只做顯示） |
| 父子任務的進度捲動 | 前端 `lib/rollup.ts` |
| 關聯線的種類、方向、合法性 | 後端 `lib/graph.ts` |
| 發文追蹤的狀態（逾期／已回） | 後端 `lib/inquiry.ts` |
| 燃盡圖怎麼回推歷史狀態 | 後端 `lib/burndown.ts`（正向重播 `activity`） |
| 卡片排序 | 後端 `lib/rank.ts` |
| 錯誤訊息長相 | 後端 `lib/errors.ts`（RFC 7807 problem+json） |
| 示範資料 | `apps/api/src/seed.ts` |

---

## 後端 `apps/api/src`

```
index.ts            77   Fastify 起手式；所有路由掛在 /api/v1 底下
lib/
  env.ts            40   環境變數
  db.ts            129   sql 連線 + migrate()（開機時自己跑，有 checksum）
  errors.ts         77   HttpProblem 與 badRequest/forbidden/… 捷徑
  auth.ts          150   密碼雜湊、JWT、authenticate()、requireProjectRole/Creator/
                         WorkspaceMember/TaskAccess ← 權限一律走這裡，不要在路由裡自己查
  graph.ts         106   關聯種類常數、closure table 重建、防環、防把子孫設成父
  schedule.ts      180   排程引擎：拓撲排序、最早開始、關鍵路徑、衝突
  inquiry.ts        75   發文追蹤狀態重算、逾期掃描、工作日加法
  burndown.ts      330   燃盡圖：拿 activity 正向重播每張任務的狀態歷史
                         ← 查不到轉換紀錄時退回 updated_at 估，回報估了幾張
  rank.ts           23   卡片之間插隊用的數字排序
routes/
  auth.ts          177   註冊／登入／refresh／登出／me
  projects.ts      122   專案 CRUD、狀態欄、/graph、/schedule
  members.ts       291   成員、加入申請、核准制、/workspace-users
  tasks.ts         327   任務 CRUD、move、reschedule
  links.ts         101   任務關聯
  inquiries.ts     264   發文追蹤與跨專案看板、單位統計
  dashboard.ts     190   /burndown 與 /workload 兩支計算端點
migrations/              0001_init.sql、0002_project_membership.sql
seed.ts           150   示範帳號與兩個示範專案
```

**資料表**：`workspace` / `app_user` / `workspace_member` / `refresh_token` / `project` /
`project_member` / `project_join_request` / `task_status` / `task` / `task_closure` /
`task_link` / `task_inquiry` / `activity` / `label` / `task_label`。

**改 API 的固定動作**：路由加欄位 → `lib/api.ts` 的型別與函式跟著改 → 用到的頁面改。
前端**只**透過 `lib/api.ts` 打 API，沒有第二條路。

---

## 前端 `apps/web/src`

```
main.tsx           31   掛 QueryClientProvider 與 AuthProvider
App.tsx           355   登入判斷、選專案、頁籤（清單/看板/行事曆/甘特/關聯圖/發文/成員）、
                        側欄、任務抽屜的開關 ← 加一個新畫面就是動這裡的 View 與 VIEWS
lib/
  api.ts          256   所有型別 + 所有端點；401 會自動 refresh 一次
  auth.tsx         82   登入狀態；換帳號時 qc.clear() 清整份快取
  date.ts          62   日期顯示與工作日
  rollup.ts       109   父任務的進度／日期由子任務推算
components/
  ui.tsx           86   Button / Input / Empty / Spinner / cx，共用樣式都在這
  EpicSidebar.tsx 297   左側大項目樹
  TaskDrawer.tsx  325   右側任務詳情
  InquiryTable.tsx325   發文追蹤表格
  MembersPanel.tsx250   成員與加入申請（按鈕都掛在後端回的 canManage 底下）
pages/
  Login.tsx        74
  ProjectPicker.tsx248  選專案 + 「其他專案／申請加入」
  List.tsx        123
  Board.tsx       203   看板拖拉
  Calendar.tsx    532   月曆，會拖拉改期
  Gantt.tsx       228
  Graph.tsx       964   關聯圖：自己算版面（union-find 併欄）、卡住／並行標記
  InquiryBoard.tsx194   跨專案發文追蹤
  Week.tsx        340   這一週有哪些任務在跑：依狀態或依類型分組，組可以收合
  Dashboard.tsx   155   儀表板：控制項 + 下面兩張圖
components/（圖表，都是手刻 SVG，沒有圖表套件）
  BurndownChart.tsx   567   燃盡圖：三條線、十字準星、表格版
  WorkloadHeatmap.tsx 470   負載熱圖：色階、超載小三角、請假斜線、表格版
```

### 幾個踩過的坑，改之前先知道

- **`Graph.tsx` 的節點一定要把 `measured` 疊回去**。React Flow 每次收到新 nodes 陣列都照
  `node.measured` 重建尺寸，衍生物件身上沒有它，畫面就會整片 `visibility: hidden`。
- **佈局是自己寫的，不能引 elkjs** —— EPL-2.0 過不了 CI 的授權掃描。
- **快取鍵裡沒有使用者**（`['projects']`、`['tasks', id]`），所以換帳號一定要 `qc.clear()`。
- **migration 檔加了就不能改**，`db.ts` 會比對 checksum，改了會開不起來。
- **git tag 沒有 `v` 前綴**。

---

## 讓別的系統呼叫 API（API 權杖）

登入換來的 access token 只有 15 分鐘，換新的要靠瀏覽器的 refresh cookie，
腳本與外部系統走不了那條路。要整合就發一把**API 權杖**：

1. 網站右上角進「帳號設定」→「API 權杖」→ 填用途名稱（到期日可留空）→ 建立。
2. 明文**只會顯示這一次**，馬上複製走。伺服器只留 sha256 雜湊，事後誰都看不回來。
3. 弄丟就撤銷舊的、重發一把；不用了也請撤銷，撤銷立刻生效。

權杖以 `pmflow_` 開頭（誤貼進程式碼時掃得出來），用法就是原本的
`Authorization: Bearer`，**其餘端點與參數一個字都沒變**。
權限完全等於發權杖的那個人 —— 他在某專案是 EDITOR，這把權杖就是 EDITOR。

建任務（`POST /api/v1/projects/{專案 id}/tasks`，需要該專案 EDITOR 以上）：

```bash
TOKEN=pmflow_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BASE=http://localhost:8480/api/v1

# 先找出專案 id（回傳的 projects[].id）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/projects"

# 建一張任務
curl -s -X POST "$BASE/projects/<專案 id>/tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "title": "外部系統送進來的請修單",
        "description": "三樓走廊燈不亮",
        "type": "TASK",
        "priority": "HIGH",
        "dueDate": "2026-08-31"
      }'
```

回傳就是一般的任務物件（含 `id` 與 `ref`，例如 `OPS-42`）。
可帶的欄位跟前端建任務時一樣，見 `routes/tasks.ts` 的 `createBody`。

失敗時回的是 problem+json：`401` 代表權杖無效／已撤銷／已過期，
`403` 代表這把權杖背後的人在那個專案裡權限不夠（或帳號被停用了）。

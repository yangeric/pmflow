# PMFlow — 開源專案管理系統 規格書

> 版本 v0.1 (draft) ｜ 撰寫日期 2026-07-31
> 授權定位：專案本體採 **MIT**，所有相依套件必須為 MIT / Apache-2.0 / BSD / PostgreSQL License
> 部署定位：**小團隊自架（5–50 人、單一組織）**，Docker Compose 一鍵起，可跑在 NAS

---

## 0. 一句話定義

PMFlow 是一套自架式專案管理系統，核心特色是**「任務可以上下左右關聯」**——上下是階層（父子任務），左右是時序依賴（FS/SS/FF/SF + lag），旁邊是語意關聯（relates / duplicates / blocks）——並且內建**跨單位發文追蹤**：每張任務可以記錄「這問題提給了哪個單位、對方回了沒、實際是哪個單位回的」，讓「這件事發出去多久了？誰還沒回？」變成可篩選、可統計、可在看板上一眼看見的資料。

---

## 1. 需求對照表

| 你的需求 | 本規格如何滿足 | 章節 |
|---|---|---|
| 行事曆 | 月/週/日視圖，事件可拖曳改期、拖邊緣改長度、拖曳建立 | §4.3 |
| 進度表 | 甘特圖（含依賴連線、基準線、關鍵路徑）＋ 看板 ＋ 清單/表格 | §4.2 §4.4 |
| 圖形化越多越好 | 甘特、看板、行事曆、關聯網路圖、燃盡圖、負載熱圖、進度儀表板、里程碑時間軸 | §4 |
| 都要能拖移 | 統一拖曳層（dnd-kit）＋各視圖原生拖曳，全部走同一組樂觀更新協定 | §4.7 |
| 任務上下左右關聯 | 階層（closure table）＋ 依賴（4 種 link type + lag）＋ 語意關聯 | §5.3 §6 |
| 註冊帳號 | Email 註冊 + 驗證信 + JWT；可選 OIDC | §7 |
| 切換不同專案 | Workspace → Project → Task 三層，全域切換器 + 跨專案視圖 | §5.2 |
| 任務是否已回覆 / 回覆方是哪個單位（對方沒帳號） | `task_inquiry` 詢問單：提問側（提給哪個單位 / 承辦人 / 聯絡方式 / 提問日 / 期望回覆日）＋ 回覆側（回了沒 / 實際回覆單位 / 回覆人 / 回覆日），純資料欄位不需對方登入 | §6 |
| 架在 Docker、打包成 image 上傳 registry | 多階段 Dockerfile、GHCR 自動發佈、multi-arch (amd64/arm64) | §12 |
| NAS 用的 yaml 先想好 | `deploy/docker-compose.yml` 已附，含 Synology/QNAP 注意事項 | §12.4 |

---

## 2. 為什麼不直接用現成的

先做過市場調查（10 套主流開源 PM 系統），結論如下——這決定了 PMFlow 該做什麼、不該做什麼：

| 系統 | 授權 | 甘特 | 依賴類型 | 跨單位發文追蹤 | 2026 狀態 |
|---|---|---|---|---|---|
| OpenProject | GPL-3.0 | ✅ 最強 | 7 對關聯 + lag | ❌ | 非常活躍 |
| Plane | AGPL-3.0 | ✅ | 6 種 | ❌ | 非常活躍 |
| Vikunja | AGPL-3.0 | ✅ | 6 對 | ❌ | 活躍 |
| Redmine | GPL-2.0 | ✅ | 5 對 + delay | ❌（要靠自訂欄位硬湊） | 活躍（7.0 / 2026-06） |
| Taiga | MPL-2.0 | ❌ 官方拒做 | ❌ | ❌ | 緩慢，前端仍 AngularJS |
| Leantime | AGPL-3.0 | ✅ | 弱 | ❌ | 活躍 |
| WeKan | **MIT** | ❌（甘特因 GPL 拆成另一份 build） | ❌ | ❌ | 活躍但 churn 高 |
| Huly | EPL-2.0 | ❌ | 子議題 | ❌ | 非常活躍 |
| Worklenz | AGPL-3.0 | ✅ | 弱 | ❌ | 中等（2026-02 修過 SQL Injection） |
| Focalboard | 混合 | ❌ | ❌ | ❌ | **standalone 已無人維護** |

三個關鍵結論：

1. **授權是真的問題。** 十套裡九套是 GPL/AGPL/MPL/EPL。唯一 MIT 的 WeKan 因為甘特函式庫是 GPL，只好把甘特功能拆成另一個 repo 分開 build。你想做 MIT 開源，就得從第一天開始管相依授權。
2. **沒有人真的把「FS/SS/FF/SF 四種依賴」做完。** 生態系的事實標準只有 Finish-to-Start 一種，叫 `precedes/follows` 或 `blocked_by`。PMFlow 把四種都做，是明確的差異點——而且成本很低，就是同一張邊表多幾個 enum 值。
3. **「跨單位發文追蹤」十套全部沒有。** 所有系統都預設「參與者 = 系統使用者」，所以要記錄「這件事發文給採購部、他們還沒回」時，只能拿自訂欄位硬湊——結果是欄位散在各處、沒有逾期判斷、沒辦法做「哪個單位最常拖」的統計。這是台灣機關與企業日常最痛的一塊，也是 PMFlow 的第二個差異點。作法刻意輕：純資料欄位，**對方完全不需要帳號、不需要收到任何系統信**，一切由我方人員登錄。

---

## 3. 技術選型（全部免費可商用，已逐一查證授權）

### 3.1 決策原則

- 一律 **MIT / Apache-2.0 / BSD / PostgreSQL License**。GPL / AGPL / SSPL / CC-NC 一律不進 bundle。
- 前端相依「會被打包進 bundle」→ 授權要求最嚴。後端「以獨立網路服務執行、不 fork 不 vendor」→ 可放寬（見 Valkey 一節）。
- 不用已停止維護的專案。

### 3.2 前端

| 用途 | 選用 | 授權 | 說明 |
|---|---|---|---|
| 框架 | React 19 + TypeScript + Vite | MIT | |
| 樣式 / 元件 | Tailwind CSS + shadcn/ui | MIT | shadcn 是複製原始碼進專案，無相依風險 |
| **通用拖曳** | `@dnd-kit/core` + `@dnd-kit/sortable` | MIT | 看板、清單排序、側欄重排 |
| **甘特圖** | `dhtmlx-gantt` **`^10.0.0`** | **MIT（v10.0.0 起）** | ⚠️ **必須鎖 `>=10`**，9.1.4 以前是 GPL-2.0 |
| 甘特圖（輕量備案） | `frappe-gantt` | MIT | 純 MIT 無 PRO 層，功能較少 |
| **行事曆** | `react-big-calendar` + `addons/dragAndDrop` | MIT | 拖曳改期／改長度／拖曳建立都在 MIT 主套件內 |
| **關聯網路圖** | `@xyflow/react` (React Flow) | MIT | 任務關聯圖、依賴拓撲、里程碑流程 |
| 圖表 | `recharts`（主）／`echarts`（重型） | MIT / Apache-2.0 | 燃盡圖、進度分布、負載熱圖 |
| 富文字（留言） | `@tiptap/core` + `starter-kit` | MIT | 2025 年已把 drag-handle / ToC / emoji 等 10 個前 Pro 擴充改為 MIT |
| 伺服器狀態 | TanStack Query | MIT | |
| 前端狀態 | Zustand | MIT | |
| 表單 / 驗證 | react-hook-form + zod | MIT | |
| 即時 | 原生 WebSocket + STOMP client | Apache-2.0 | |

### 3.3 授權地雷（務必寫進 CONTRIBUTING.md）

1. **`wx-react-gantt`（SVAR Gantt）是 GPLv3，不是 MIT。** 1.3.0 是 MIT，1.3.1 改成 GPLv3，但官網行銷頁至今仍寫「MIT licensed core」。**不要用。**
2. **FullCalendar 的 premium plugin 沒有寬鬆授權出路。** `timeline`、`resource-timeline`、`scrollgrid` 是「商業授權 或 CC-BY-NC-ND 或 GPLv3」三選一——而這正好是 PM 系統最想要的資源時間軸。所以本規格用 `react-big-calendar`。FullCalendar 的 `core/daygrid/timegrid/list` 是 MIT，只做基本行事曆的話可用。
3. **Schedule-X 免費版不含拖曳與 resize**，那兩個功能在 `@sx-premium` 私有 registry（€479/年），公開 CI 根本裝不起來。
4. **`dhtmlx-gantt` ≤ 9.1.4 是 GPL-2.0**，只有 10.0.0+ (2026-06) 是 MIT。CI 要加 lockfile 授權檢查。
5. **MinIO 已於 2026-04 封存**（"NO LONGER MAINTAINED"），社群版還被拿掉管理 UI、不提供預編譯 binary，且是 AGPL。**不要用。** 需要物件儲存就用 SeaweedFS (Apache-2.0) 或直接掛檔案系統。
6. **Redis 7.4–7.8 完全不是開源**（RSALv2/SSPLv1），8.0 起才多一個 AGPLv3 選項。→ **改用 Valkey（BSD-3-Clause，Linux Foundation 治理，drop-in 相容）**。
7. `react-dnd`（2022 最後更新）與 `gantt-task-react`（2022）授權乾淨但已停更，不要用。

### 3.4 後端與基礎設施

| 用途 | 選用 | 授權 | 理由 |
|---|---|---|---|
| **後端框架** | Spring Boot 3.5 / Java 21 | Apache-2.0 | 與你既有技術棧一致；JPA + Flyway + Security + WebSocket 全部內建 |
| 後端（替代方案） | NestJS 11 / TypeScript | MIT | 若想前後端同語言、擴大貢獻者池 |
| **資料庫** | PostgreSQL 17 | PostgreSQL License | Recursive CTE 做階層、JSONB 做自訂欄位、全文檢索、`btree_gist` 做時間區間排除 |
| **快取 / Session / Pub-Sub** | **Valkey 9** | BSD-3-Clause | 取代 Redis，避開授權問題 |
| 即時推播 | Spring WebSocket + STOMP（內建 simple broker） | Apache-2.0 | 小團隊規模不需要外部 broker；未來要水平擴展再換 Valkey Pub/Sub relay |
| 檔案儲存 | 本機 volume（預設）／S3 相容（可選） | — | 預設寫 Docker volume，NAS 直接掛磁碟最省事 |
| 寄信 | Spring Mail (SMTP) | Apache-2.0 | 註冊驗證信、指派通知、逾期未回提醒（**只寄給系統內部成員**，不寄給外部單位） |
| 身分（可選） | Keycloak 26 | Apache-2.0 | 預設用內建 JWT 即可，需要 SSO 再開 |
| 反向代理 | Caddy 2 | Apache-2.0 | 自動 HTTPS，設定檔比 Nginx 短十倍 |
| CI / Registry | GitHub Actions + GHCR | — | 公開 repo 免費，multi-arch build |

---

## 4. 功能規格

### 4.1 全域導覽

**專案切換發生在登入後的選擇頁，不常駐在側欄。** 側欄的空間留給專案內部的結構。

```
登入
  └─ 專案選擇頁    ← 卡片列出所有專案；發文追蹤（跨專案）也放這裡
       └─ 專案主畫面
            ├─ 側欄：大項目 → 小項目（就是 parent_id 階層）
            └─ 主區：清單 / 看板 / 甘特圖
```

理由：一般人一天只在一個專案裡工作，側欄常駐專案清單是把「一天用一次」的東西佔掉最貴的版面。改成登入時選一次，側欄就能拿來顯示真正每分鐘都在看的東西——這個專案拆成哪幾塊大項目、每塊底下有哪些小項目。

- **專案選擇頁**：專案卡片（代碼、名稱、任務數、逾期未回數）＋建立新專案＋發文追蹤入口
**版面是主從式（master-detail）：左邊選什麼，右邊就顯示什麼。**

- **側欄**：專案名 + 「⇄ 切換專案」→「全部任務」→ 大項目樹（可展開看小項目）→「＋ 新增大項目」→ 發文追蹤 → 使用者/登出
  - 大項目 = `parent_id IS NULL` 的任務，通常 `type = 'EPIC'`；小項目 = 它的子任務
  - 大項目那一列直接顯示彙總進度條、完成數（`3/5`）、底下逾期未回的張數
  - **點大項目** → 右邊回到總覽（清單/看板/甘特），且**只顯示該子樹**
  - **點小項目** → 右邊直接顯示那張任務的詳情，選中的節點在左邊 highlight
  - 任務詳情是**內嵌在右邊**，不是浮動抽屜。理由：抽屜會蓋住左邊的樹，關掉之後使用者常常不知道剛剛看的是哪一張；內嵌則永遠看得到自己在結構樹的哪個位置
  - 詳情模式的頂端是一條麵包屑（← 回總覽 ｜ 專案 / 大項目 / 任務），每一段都可點
  - 從清單、看板、甘特、發文追蹤點任何一張任務，也一律走同一條路徑顯示在右邊——只有一種開任務的方式
  - 篩在某個大項目底下時，頂端新增的任務**自動掛進該大項目**，不用再手動搬

> **為什麼側欄不再放專案清單、也不重畫一次階層表格**：早期版本左邊是專案清單、右邊清單又用縮排把同一棵樹畫一遍，兩邊看起來像同一份東西擺兩處；而且左邊點大項目是「篩選」、點小項目卻是「開抽屜」，同一個清單兩種語意沒人猜得到。現在職責固定為：**左邊＝結構（我在哪）**，**右邊＝內容（這裡有什麼）**。
- **發文追蹤**是跨專案的，所以在選擇頁與側欄都有入口；看板上的卡片可點，會跳到該任務所屬專案並開啟詳情
- 浮動抽屜模式（`variant='overlay'`）保留在元件裡備用，該模式可按 `Esc` 關閉（游標在輸入框裡時只失焦，避免打到一半誤觸）

### 4.2 甘特圖（進度表）

- 時間軸縮放：日 / 週 / 月 / 季
- **拖曳操作**：整條拖曳改期、拖左右邊界改工期、從任務端點拉線建立依賴、拖曳調整 WBS 順序、拖曳縮排/凸排改變父子關係
- **依賴線**：四種類型以不同端點樣式呈現（FS 實線、SS 雙起點、FF 雙終點、SF 虛線），lag 以線上標籤顯示
- **基準線 (Baseline)**：可對專案存快照，甘特上以灰色影子條顯示原定日期 vs 實際
- **關鍵路徑**：後端計算（前向/後向遍歷求 total float = 0 的鏈），前端上色。⚠️ dhtmlx 的自動排程/關鍵路徑是 PRO 功能，所以**我們自己在後端算**，前端只負責畫
- **衝突提示**：違反依賴的日期以紅色連線標示，並在側欄列出「N 個排程衝突」
- 里程碑以菱形節點呈現
- 進度條：父任務的完成率 = 子任務加權平均（權重 = 估時，無估時則等權）

### 4.3 行事曆

- 月 / 週 / 日 / 議程 四視圖
- 顯示：任務起訖區間、里程碑、截止日、個人指派、**各單位的期望回覆日**（獨立圖層，可關閉）
- **拖曳**：拖事件改期、拖邊緣改長度、在空白處拖曳直接建任務
- 篩選：依專案、依負責人、依標籤、依發文狀態、依單位
- 訂閱：輸出唯讀 iCalendar (.ics) feed，可掛進 Google Calendar / Outlook（含不可預測 token）

### 4.4 看板

- 欄 = 任務狀態（可自訂），泳道可選（依負責人 / 依優先級 / 依父任務）
- **拖曳**：卡片跨欄拖曳（改狀態）、欄內拖曳（改排序）、拖曳整欄（改欄順序）
- WIP 上限：超過時欄位標紅（軟性提示，不硬擋）
- 卡片上直接顯示發文追蹤徽章（例如紅色的 `⚠️ 資訊部 逾期 6 天`）

### 4.5 清單 / 表格視圖

- 樹狀展開子任務、可拖曳改階層與排序
- 欄位可拖曳調整寬度與順序、可儲存為個人視圖
- 批次編輯、行內編輯
- 匯出 CSV / XLSX

### 4.6 圖形化儀表板

| 圖表 | 內容 | 函式庫 |
|---|---|---|
| 燃盡 / 燃起圖 | 剩餘工時 vs 理想線 | Recharts |
| 進度分布環圖 | 各狀態任務數 | Recharts |
| 人員負載熱圖 | 每人每日已指派工時，超載紅色 | ECharts heatmap |
| **任務關聯網路圖** | 節點=任務，邊=依賴/階層，可拖曳節點、點擊聚焦子圖、自動佈局 | React Flow |
| 里程碑時間軸 | 水平時間軸 + 達成狀態 | 自繪 SVG |
| **發文追蹤看板** | 「待回覆 / 逾期未回 / 已回覆」三欄，可依單位分組 | 自繪 |
| **單位回覆統計** | 各單位平均回覆天數、逾期率排行——「哪個單位最常拖」 | Recharts |
| 累積流量圖 (CFD) | 各狀態任務數隨時間堆疊 | Recharts |

### 4.7 統一拖曳與樂觀更新協定

所有拖曳互動走同一條路徑，避免每個視圖各寫一套：

1. 前端 `onDragEnd` 立刻更新本地快取（樂觀），畫面不等網路
2. 送 `PATCH` 到對應端點，body 只帶「變更意圖」而非整個物件
   - 排序用 **fractional ranking**（`rank` 為 `numeric`，插入兩者之間取中間值），避免拖一張卡就要 UPDATE 整欄
3. 後端驗證（權限、循環依賴、日期約束），成功回傳權威版本
4. 失敗 → 前端 rollback 並跳 toast 說明原因（例如「會造成循環依賴」）
5. 成功 → 透過 WebSocket 廣播給同專案其他線上使用者，其他人畫面即時同步

---

## 5. 資料模型

### 5.1 命名與通則

- 主鍵一律 `UUID v7`（時間有序，索引友善，且不洩漏數量）
- 每張業務表都攜帶 `workspace_id`（**刻意反正規化**，讓權限過濾與跨專案查詢不用 join——Plane 的作法）
- 軟刪除 `deleted_at`，稽核欄位 `created_at / updated_at / created_by / updated_by`
- 所有 enum 存 `text` + CHECK 約束（比 PG enum 好改）

### 5.2 組織與專案

```
workspace (組織)
  └── project (專案)
        └── task (任務)
```

```sql
CREATE TABLE workspace (
  id            uuid PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  settings      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id                uuid PRIMARY KEY,
  email             citext NOT NULL UNIQUE,
  password_hash     text,                    -- NULL 代表僅用 OIDC 登入
  display_name      text NOT NULL,
  avatar_url        text,
  locale            text NOT NULL DEFAULT 'zh-TW',
  timezone          text NOT NULL DEFAULT 'Asia/Taipei',
  status            text NOT NULL DEFAULT 'PENDING',  -- PENDING/ACTIVE/SUSPENDED
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_member (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role          text NOT NULL,               -- OWNER/ADMIN/MEMBER/GUEST
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE project (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  key           text NOT NULL,               -- 短碼，如 PMF，任務編號 PMF-123
  name          text NOT NULL,
  description   text,
  color         text,
  status        text NOT NULL DEFAULT 'ACTIVE',
  start_date    date,
  end_date      date,
  archived_at   timestamptz,
  UNIQUE (workspace_id, key)
);

CREATE TABLE project_member (
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role        text NOT NULL,                 -- MANAGER/EDITOR/COMMENTER/VIEWER
  PRIMARY KEY (project_id, user_id)
);
```

### 5.3 任務與「上下左右」關聯

這是整個系統的核心。三種關聯**刻意分開存**，因為語意完全不同：

| 方向 | 意義 | 儲存方式 | 影響排程？ |
|---|---|---|---|
| **上下** | 父子階層 / WBS 分解 | `task.parent_id` + `task_closure` 閉包表 | 是（彙總） |
| **左右** | 時序依賴（FS/SS/FF/SF + lag） | `task_link` 邊表 | **是** |
| **旁邊** | 語意關聯（相關/重複/阻擋/參考） | `task_link` 邊表（不同 type） | 否 |

```sql
CREATE TABLE task (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  number          integer NOT NULL,           -- 專案內流水號 → PMF-123
  parent_id       uuid REFERENCES task(id) ON DELETE SET NULL,
  title           text NOT NULL,
  description     text,                       -- Tiptap JSON 或 Markdown
  type            text NOT NULL DEFAULT 'TASK',   -- TASK/MILESTONE/BUG/EPIC
  status          text NOT NULL DEFAULT 'TODO',
  priority        text NOT NULL DEFAULT 'NORMAL',
  assignee_id     uuid REFERENCES app_user(id),
  start_date      date,
  due_date        date,
  estimate_hours  numeric(8,2),
  spent_hours     numeric(8,2) NOT NULL DEFAULT 0,
  progress        smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  schedule_mode   text NOT NULL DEFAULT 'AUTO',  -- AUTO=依依賴自動推算 / MANUAL=鎖死人工日期
  rank            numeric NOT NULL,              -- fractional ranking，拖曳排序用
  custom_fields   jsonb NOT NULL DEFAULT '{}',
  -- 跨單位發文追蹤的彙總欄位（衍生自 task_inquiry，見 §6）
  inquiry_state     text NOT NULL DEFAULT 'NONE',  -- NONE/AWAITING/OVERDUE/PARTIAL/REPLIED
  earliest_due_date date,                          -- 所有未回覆詢問單中最早的期望回覆日
  deleted_at      timestamptz,
  UNIQUE (project_id, number)
);
CREATE INDEX ON task (workspace_id, project_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ON task (assignee_id) WHERE deleted_at IS NULL;
CREATE INDEX ON task (project_id, rank);
CREATE INDEX ON task (workspace_id, inquiry_state) WHERE inquiry_state IN ('AWAITING','OVERDUE','PARTIAL');
```

#### 上下：閉包表

`parent_id` 只有相鄰資訊，查整棵子樹要 recursive CTE。加一張閉包表換取 O(1) 子樹讀取——這是甘特彙總（父任務日期 = 子任務 min(start)/max(due)、完成率加權平均、工時累加）每秒都要跑的查詢。

```sql
CREATE TABLE task_closure (
  ancestor_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  descendant_id  uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depth          integer NOT NULL,            -- 0 = 自己
  PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX ON task_closure (descendant_id, depth);
```

- 新增/搬移任務時在同一交易內重建該子樹的閉包列
- **允許跨專案父子**（Redmine、Plane 都允許），所以階層查詢不可假設同一個 `project_id`
- 深度上限預設 10 層，可設定

#### 左右：單一邊表

```sql
CREATE TABLE task_link (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  source_id     uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  target_id     uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  link_type     text NOT NULL,
  lag_days      integer NOT NULL DEFAULT 0,   -- 可為負（重疊）
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (source_id <> target_id),
  UNIQUE (source_id, target_id, link_type)
);
CREATE INDEX ON task_link (target_id, link_type);
CREATE INDEX ON task_link (source_id, link_type);
```

`link_type` 值域，分成兩類：

**排程類（會推動日期）**

| 存的值 | **介面顯示** | 短標籤 | 約束式 |
|---|---|---|---|
| `FS` | **等待任務完成，才能開始**（預設） | 完成後開始 | `target.start >= source.finish + lag` |
| `SS` | **等待任務開始，才能開始** | 同時開始 | `target.start >= source.start + lag` |
| `FF` | **等待任務完成，才能完成** | 同時完成 | `target.finish >= source.finish + lag` |
| `SF` | **等待任務開始，才能完成**（罕見） | 開始後完成 | `target.finish >= source.start + lag` |

**語意類（不推動日期，只做關聯與呈現）**

| 存的值 | 介面顯示 | 反向標籤 |
|---|---|---|
| `RELATES` | 相關（對稱） | 相關 |
| `BLOCKS` | 阻擋 | 被阻擋 |
| `DUPLICATES` | 重複於 | 被重複 |
| `REQUIRES` | 需要 | 被需要 |

**介面一律不出現 FS / SS / FF / SF 這四個縮寫。** 資料庫與 API 契約仍用這些代碼（短、穩定、與甘特函式庫的 0/1/2/3 好對應），但使用者不該需要學它們。命名規則是「前半講來源那一端，後半講自己這一端」，所以中文說法照著念就成立。

清單上還會**依方向**把整條關聯講成一句話，因為同一條 `FS` 站在上游和下游看到的意思相反——這是最容易看錯的地方：

| 方向 | 顯示 |
|---|---|
| outgoing（我 → 對方） | 「PMF-7 要等我完成，才能開始」 |
| incoming（對方 → 我） | 「要等 PMF-2 完成，我才能開始」 |

`lag` 在介面上叫**「間隔（天）」**，正數＝中間空幾天，負數＝提前重疊。

**方向規則：只存正向一列，反向由查詢推導。** （Redmine / OpenProject / Plane 的作法。Vikunja 兩個方向都寫，導致 2026 年爆出關聯 IDOR 與一致性問題——不要學。）對稱型 `RELATES` 額外規範存入時 `source_id < target_id`（字典序），從資料層杜絕重複列。

**必要的守門（寫入時強制檢查）：**
- 自我關聯：`source_id <> target_id`（DB 層 CHECK）→ **400**，因為與現有狀態無關，永遠不合法
- 循環依賴：新增排程類連結前跑一次 DFS/拓撲檢查，含 `parent_id` 階層邊一起看（父子 + 依賴混合成環也要擋）→ **409**
- 父子與依賴衝突：不允許在祖先與後代之間建立排程類依賴 → **409**（RFC 9110：與目標資源的當前狀態衝突）
- 跨 workspace 關聯一律拒絕 → **403**

#### 排程引擎

- `schedule_mode = AUTO` 的任務，日期由依賴 + 工期推算；`MANUAL` 的任務日期鎖死，成為排程的固定錨點（OpenProject 的作法，讓使用者能局部逃脫約束求解器）
- 任一日期變動 → 對受影響的下游子圖做拓撲排序後前向推算 → 一併算出關鍵路徑（total float = 0）
- 工作日曆：週末與國定假日可設定，`lag_days` 與工期預設以工作日計
- 計算在後端做（Java），結果快取進 Valkey，key 為 `sched:{projectId}:{version}`

### 5.4 其他實體

```sql
-- 標籤
CREATE TABLE label (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
  project_id uuid REFERENCES project(id) ON DELETE CASCADE,  -- NULL = workspace 層通用
  name text NOT NULL, color text NOT NULL
);
CREATE TABLE task_label (
  task_id uuid REFERENCES task(id) ON DELETE CASCADE,
  label_id uuid REFERENCES label(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

-- 附件
CREATE TABLE attachment (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
  task_id uuid REFERENCES task(id) ON DELETE CASCADE,
  filename text NOT NULL, content_type text, size_bytes bigint NOT NULL,
  storage_key text NOT NULL, checksum_sha256 text,
  uploaded_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 5.5 活動日誌（統一時間軸）

留言與欄位異動放同一張表（OpenProject `journals` / Redmine journal 的作法），一次查詢就能畫出「這張任務發生過什麼」的完整時間軸。

```sql
CREATE TABLE activity (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  task_id       uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind          text NOT NULL,          -- COMMENT / FIELD_CHANGE / LINK_CHANGE / STATUS_CHANGE / INQUIRY_CHANGE
  body          jsonb,                  -- COMMENT: Tiptap doc；FIELD_CHANGE: {field, from, to}[]
  actor_id      uuid REFERENCES app_user(id),   -- NULL = 系統自動產生
  actor_name    text,                   -- 快照，避免帳號停用後名字消失
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON activity (task_id, created_at DESC);
```

> 注意：外部單位的回覆**不會**寫進 `activity`，因為外部單位不是系統作者。他們回了什麼，由我方人員登錄成 `task_inquiry` 的回覆欄位，或另外寫一則一般留言。`activity` 的作者永遠是系統內的人。

---

## 6. 跨單位發文追蹤：「提給誰、回了沒、誰回的」

這是你點名的核心需求。設計原則只有一句話：**這是資料欄位，不是身分系統。** 外部單位不需要帳號、不需要收到系統信、不需要點任何連結——所有內容都由我方人員在系統裡登錄。

### 6.1 為什麼不是 `task.replied` 一個布林值

實務上一張任務常常同時卡在多個單位，而且提問與回覆是兩件事：

- 同一件事可能**同時發文給採購部與資訊部**，兩邊各自有各自的回覆狀態。所以要一對多。
- **回覆的單位不一定等於提問的單位。** 發文給資訊部，結果是他們的委外廠商回；或案子被轉給其他單位承辦。這在機關與大企業裡是常態，所以提問側與回覆側必須是**兩組獨立欄位**，不能共用一個。
- 要能算「發出去幾天了」「逾期沒」，就必須有提問日與期望回覆日。
- 要能回答「哪個單位最常拖」，單位就必須是可統計的欄位，不能埋在留言文字裡。

### 6.2 資料表

```sql
CREATE TABLE task_inquiry (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL,
  task_id           uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  seq               smallint NOT NULL,          -- 同一任務內的顯示順序

  -- ── 提問側：這問題提給了哪個單位 ──
  asked_to_unit     text NOT NULL,              -- 單位名稱（自由文字）
  asked_to_person   text,                       -- 承辦人姓名
  asked_to_contact  text,                       -- 電話或 email，純記錄，系統不會寄信
  asked_at          date NOT NULL DEFAULT CURRENT_DATE,   -- 提問日
  due_date          date,                       -- 期望回覆日
  question          text,                       -- 這次問了什麼
  asked_by          uuid REFERENCES app_user(id),         -- 我方發問人

  -- ── 回覆側：實際是哪個單位回的 ──
  is_replied        boolean NOT NULL DEFAULT false,
  replied_by_unit   text,                       -- ⚠️ 可能不等於 asked_to_unit
  replied_by_person text,
  replied_at        date,
  reply_note        text,                       -- 選填：回覆重點摘要
  recorded_by       uuid REFERENCES app_user(id),         -- 誰把這筆回覆登錄進系統

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CHECK (NOT is_replied OR replied_at IS NOT NULL),
  CHECK (replied_at IS NULL OR replied_at >= asked_at),
  CHECK (due_date  IS NULL OR due_date  >= asked_at)
);

CREATE INDEX ON task_inquiry (task_id, seq);
CREATE INDEX ON task_inquiry (workspace_id, asked_to_unit);
CREATE INDEX ON task_inquiry (workspace_id, replied_by_unit) WHERE replied_by_unit IS NOT NULL;
-- 「誰還沒回、誰逾期了」是最常跑的查詢
CREATE INDEX ON task_inquiry (workspace_id, due_date) WHERE NOT is_replied;
```

單筆詢問單的狀態不存成欄位，因為「逾期」會隨日期自己改變，存下來就要天天更新。改成查詢時算：

```sql
CREATE VIEW v_inquiry AS
SELECT i.*,
       CASE WHEN i.is_replied                            THEN 'REPLIED'
            WHEN i.due_date IS NULL                      THEN 'AWAITING'
            WHEN i.due_date < CURRENT_DATE               THEN 'OVERDUE'
            ELSE 'AWAITING' END                          AS status,
       CURRENT_DATE - i.asked_at                         AS days_elapsed,
       CASE WHEN i.is_replied THEN i.replied_at - i.asked_at END AS days_to_reply,
       CASE WHEN NOT i.is_replied AND i.due_date < CURRENT_DATE
            THEN CURRENT_DATE - i.due_date END           AS days_overdue
FROM task_inquiry i;
```

### 6.3 單位欄位：自由文字 + 歷史值提示

`asked_to_unit` 與 `replied_by_unit` 都是**純文字**，沒有主檔、沒有管理頁、不用先去設定裡新增——想打什麼打什麼。

但輸入框會把你在這個 workspace 裡用過的單位名稱列出來當提示（HTML `datalist` 型的 typeahead）。這不改變欄位本質，只是少打幾個字，順便讓「資訊部 / 資訊處 / IT」比較不容易變成三個不同的值：

```sql
CREATE VIEW v_unit_suggestion AS
SELECT workspace_id, unit,
       count(*) AS usage_count,
       max(used_on) AS last_used_on
FROM (
  SELECT workspace_id, asked_to_unit   AS unit, asked_at   AS used_on
    FROM task_inquiry WHERE asked_to_unit <> ''
  UNION ALL
  SELECT workspace_id, replied_by_unit,          replied_at
    FROM task_inquiry WHERE coalesce(replied_by_unit, '') <> ''
) t
GROUP BY workspace_id, unit;
```

排序規則：先出現最近用過的，再出現最常用的。

> 日後若真的覺得名稱太亂，只要加一張 `unit_alias(workspace_id, alias, canonical_name)` 對照表，統計時做正規化即可——不必回頭改資料表結構，也不必逼使用者改習慣。這是刻意留的後路。

### 6.4 任務層彙總

`task.inquiry_state` 是**衍生欄位**，由該任務底下所有詢問單彙總而來。存下來是為了讓看板、清單、篩選不用每次都 join 聚合：

| `inquiry_state` | 條件 |
|---|---|
| `NONE` | 這張任務沒有任何詢問單 |
| `AWAITING` | 全部未回覆，且沒有任何一張逾期 |
| `OVERDUE` | 至少一張未回覆且已過期望回覆日 |
| `PARTIAL` | 有些回了、有些還沒（且沒有逾期的） |
| `REPLIED` | 全部都已回覆 |

更新時機：
- 詢問單新增 / 修改 / 刪除時，在**同一個交易內**重算該任務的 `inquiry_state` 與 `earliest_due_date`
- 另有每日 00:05 的排程工作掃過期：`UPDATE ... WHERE NOT is_replied AND due_date < CURRENT_DATE`，把跨過午夜才逾期的任務改成 `OVERDUE` 並發通知給我方負責人

### 6.5 介面

**任務詳情頁 — 「發文追蹤」區塊**

一張表格，一列一個單位。預設只顯示一列（因為多數情況只提給一個單位），右下角有「＋ 新增單位」：

| 提給單位 | 承辦人 | 聯絡方式 | 提問日 | 期望回覆 | 回了沒 | 回覆單位 | 回覆人 | 回覆日 |
|---|---|---|---|---|---|---|---|---|
| 採購部 | 王小明 | 分機 2145 | 07/20 | 07/25 | ✅ | 採購部 | 王小明 | 07/24 |
| 資訊部 | 李大同 | lee@… | 07/20 | 07/25 | ⏳ 逾期 6 天 | — | — | — |

互動細節：
- 勾選「回了沒」時，**回覆單位自動帶入提問單位、回覆日自動帶入今天**——因為多數情況兩者相同，但兩個欄位都可以改（這正是分開存的意義）
- 「逾期 6 天」是即時算出來的，紅字
- 整列可以直接複製成新的一列（同一單位重複追問時很常用）

**卡片 / 清單上的徽章**

| 狀態 | 呈現 |
|---|---|
| `AWAITING` | 藍色 `⏳ 採購部` |
| `OVERDUE` | 紅色 `⚠️ 資訊部 逾期 6 天` |
| `PARTIAL` | 黃色 `1/2 已回` |
| `REPLIED` | 綠色 `✅ 已回` |

**發文追蹤看板**（工作區層級，跨專案）

三欄：待回覆 / 逾期未回 / 已回覆。可切換「依單位分組」——一眼看出「資訊部身上壓著 8 件、其中 3 件逾期」。

**單位回覆統計**

- 各單位平均回覆天數（`avg(days_to_reply)`）
- 各單位逾期率排行
- 每月發文量趨勢

這些查詢之所以做得出來，就是因為單位是獨立欄位而不是埋在留言裡。

**行事曆與甘特**

期望回覆日會以獨立圖層疊在行事曆上（可關閉），甘特圖上以小旗標記在對應任務的長條上。

### 6.6 篩選與搜尋

所有列表視圖都支援這幾個篩選條件，且可存成個人視圖：

```
inquiry.state    = AWAITING | OVERDUE | PARTIAL | REPLIED | NONE
inquiry.unit     = 採購部              （提問或回覆任一側符合）
inquiry.askedTo  = 資訊部              （只看提問側）
inquiry.overdueDays >= 7
inquiry.askedAt  between 2026-07-01 and 2026-07-31
```

常用組合直接做成側欄捷徑：**「我發出去還沒回的」**、**「逾期超過一週的」**、**「這個月發文給資訊部的」**。

### 6.7 明確不做的事（以及日後想做時怎麼加）

| 不做 | 原因 | 日後要加的話 |
|---|---|---|
| 讓外部單位登入系統 | 對方沒帳號也不該有帳號 | — |
| 自動寄詢問信給外部單位 | 你要的是記錄，不是自動化發文 | 加 SMTP 樣板即可，資料表不用改 |
| 收信自動回填回覆狀態 | 工程量與資安成本遠高於價值 | 需要時再做，`task_inquiry` 直接接得上 |
| 分享連結給外部單位填寫 | 同上 | 加一張 token 表指向 `task_inquiry.id` 就好 |
| 單位主檔管理頁 | 你選擇自由文字，不想被綁 | 加 `unit_alias` 對照表做統計正規化 |

逾期提醒信**只寄給我方的任務負責人**，提醒他去追人——不會寄給外部單位。

## 7. 帳號與權限

### 7.1 註冊流程

1. Email + 密碼註冊（Argon2id 雜湊）→ 寄驗證信 → 點連結啟用
2. `ALLOW_SELF_REGISTRATION` 環境變數控制開關；另有 `ALLOWED_EMAIL_DOMAINS` 白名單（自架常見需求）
3. 首位註冊者自動成為 workspace OWNER 並完成初始化精靈
4. 邀請制：OWNER/ADMIN 發邀請信，附一次性 token
5. 可選 OIDC（Keycloak / Google / GitHub）——`app_user.password_hash` 為 NULL 即代表僅 SSO

### 7.2 Token 策略

- Access Token：JWT，15 分鐘，放記憶體（不放 localStorage）
- Refresh Token：不可預測隨機值，存 **HttpOnly + Secure + SameSite=Strict** cookie，7 天，rotation + reuse detection（偵測到重放就撤銷整個 token family）
- iCalendar 訂閱 token：per-user 不可預測值，唯讀，可隨時重新產生
- Valkey 存 refresh token family 與撤銷清單

系統只有一種驗證主體：登入的使用者。沒有訪客、沒有匿名寫入、沒有 token 交換流程——外部單位的資料是我方人員代為登錄的，不是對方送進來的。這讓權限模型維持在最簡單、也最不容易出漏洞的狀態。

### 7.3 權限矩陣

Workspace 角色：`OWNER` / `ADMIN` / `MEMBER` / `GUEST`
Project 角色：`MANAGER` / `EDITOR` / `COMMENTER` / `VIEWER`

| 操作 | MANAGER | EDITOR | COMMENTER | VIEWER |
|---|:--:|:--:|:--:|:--:|
| 檢視任務 | ✅ | ✅ | ✅ | ✅ |
| 建立/編輯任務 | ✅ | ✅ | ❌ | ❌ |
| 拖曳改期/改狀態 | ✅ | ✅ | ❌ | ❌ |
| 建立/刪除關聯 | ✅ | ✅ | ❌ | ❌ |
| 留言 | ✅ | ✅ | ✅ | ❌ |
| 新增/編輯詢問單（發文給哪個單位） | ✅ | ✅ | ❌ | ❌ |
| 登錄回覆（標記已回、填回覆單位） | ✅ | ✅ | ✅ | ❌ |
| 上傳附件 | ✅ | ✅ | ✅ | ❌ |
| 管理成員 | ✅ | ❌ | ❌ | ❌ |
| 封存專案 | ✅ | ❌ | ❌ | ❌ |

「登錄回覆」刻意開放給 `COMMENTER`——實務上接到電話說「我們回了」的人，常常不是有編輯權的專案經理。

權限在 **service 層**用 `@PreAuthorize` + 自訂 evaluator 統一實作，**不在 controller 也不在前端**判斷。前端只用來決定按鈕要不要 disable。

---

## 8. API 設計

REST + JSON，`/api/v1`。集合端點一律 cursor 分頁（`?cursor=&limit=`），寫入端點吃 `Idempotency-Key` header。

```
# 認證
POST   /api/v1/auth/register
POST   /api/v1/auth/verify-email
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout

# 工作區 / 專案
GET    /api/v1/workspaces
GET    /api/v1/workspaces/{ws}/projects
POST   /api/v1/workspaces/{ws}/projects
PATCH  /api/v1/projects/{id}
GET    /api/v1/projects/{id}/members

# 任務
GET    /api/v1/projects/{id}/tasks?view=gantt|board|calendar|list&...
POST   /api/v1/projects/{id}/tasks
GET    /api/v1/tasks/{id}
PATCH  /api/v1/tasks/{id}
DELETE /api/v1/tasks/{id}
POST   /api/v1/tasks/{id}/move        # 拖曳：改父層 / 改排序 / 改狀態，body: {parentId?, beforeId?, afterId?, status?}
POST   /api/v1/tasks/{id}/reschedule  # 拖曳：改日期，body: {startDate, dueDate, cascade: bool}
GET    /api/v1/tasks/{id}/activities

# 關聯（左右）
GET    /api/v1/tasks/{id}/links
POST   /api/v1/tasks/{id}/links       # body: {targetId, linkType, lagDays}
DELETE /api/v1/links/{linkId}
GET    /api/v1/projects/{id}/graph    # 關聯網路圖用：{nodes[], edges[]}

# 排程
GET    /api/v1/projects/{id}/schedule          # 推算後日期 + 關鍵路徑 + 衝突清單
POST   /api/v1/projects/{id}/schedule/preview  # 「如果這樣拖會怎樣」的乾跑
POST   /api/v1/projects/{id}/baselines

# 跨單位發文追蹤
GET    /api/v1/tasks/{id}/inquiries
POST   /api/v1/tasks/{id}/inquiries            # body: {askedToUnit, askedToPerson?, askedToContact?,
                                               #        askedAt?, dueDate?, question?}
PATCH  /api/v1/inquiries/{id}                  # 改期限 / 改承辦人 / 改單位
POST   /api/v1/inquiries/{id}/mark-replied     # body: {repliedByUnit?, repliedByPerson?,
                                               #        repliedAt?, replyNote?}
                                               # 三個 by* 欄位省略時，預設帶入提問側的值與今天
POST   /api/v1/inquiries/{id}/reopen           # 誤標已回覆時退回待回覆
DELETE /api/v1/inquiries/{id}

# 發文追蹤看板與統計（工作區層級，跨專案）
GET    /api/v1/workspaces/{ws}/inquiry-board?state=AWAITING,OVERDUE&groupBy=unit
GET    /api/v1/workspaces/{ws}/inquiry-stats?from=2026-01-01&to=2026-12-31
       # → 各單位平均回覆天數、逾期率、發文量
GET    /api/v1/workspaces/{ws}/unit-suggestions?q=資
       # → 單位名稱 typeahead，依「最近用過 + 最常用」排序

# 檔案 / 匯出
POST   /api/v1/tasks/{id}/attachments
GET    /api/v1/projects/{id}/export.csv|xlsx
GET    /api/v1/calendar/{icsToken}.ics

# 即時（STOMP over WebSocket）
WS     /ws
SUB    /topic/project.{projectId}      # task.updated / link.changed / inquiry.changed ...
SUB    /user/queue/notifications
```

錯誤格式統一用 RFC 9457 Problem Details：

```json
{
  "type": "https://pmflow.dev/errors/cyclic-dependency",
  "title": "會造成循環依賴",
  "status": 409,
  "detail": "PMF-12 → PMF-45 → PMF-12",
  "cycle": ["PMF-12", "PMF-45", "PMF-12"]
}
```

---

## 8.5 資料與架構脫離（架構原則）

**資料庫是長期資產，程式是可替換的。** 換 image、回滾版本、日後把後端從
TypeScript 改寫成 Spring Boot，資料都不該受影響。這條原則落在幾個具體約束上：

| 面向 | 約束 |
|---|---|
| Schema 演進 | 只加不改。改名／刪欄位一律走 expand–contract 拆成多次發佈，讓「上一版程式」在升級期間仍能運作 |
| 升級流程 | 「跑 migration」與「換 image」是兩個獨立、可分別回滾的動作（`npm run migrate` 可單獨執行） |
| 回滾 | 不提供 down migration——它給人可以安全倒退的錯覺，實際上刪掉的資料回不來。回滾靠 image tag 退版，資料靠備份還原 |
| 儲存體 | 資料在具名 volume，不在容器層。刪容器不掉資料 |
| 設定 | 全走環境變數，不編進 image。同一個 image 跑筆電也跑 NAS |
| API 契約 | `/api/v1`。破壞性變更開 `/api/v2` 並讓 v1 續活，前端可以慢慢遷 |
| 識別碼 | UUID v7，搬移合併不撞號 |
| 業務語意 | 狀態值存 `text` + CHECK，不用 PG enum——加值是加 CHECK，不是 `ALTER TYPE` |
| 可擴充 | `custom_fields jsonb`，使用者加欄位不需要 migration |
| 後端可替換 | 資料表與 API 契約本身就是規格（§5、§8）。換後端語言時 schema 與 API 不動，前端一行不改 |

完整紀律與失敗案例見 **`docs/MIGRATIONS.md`**。

---

## 9. 非功能需求

| 項目 | 目標 |
|---|---|
| 規模 | 單一組織、≤50 活躍使用者、≤200 專案、≤100k 任務 |
| 效能 | 甘特首屏（1000 任務）< 1.5s；拖曳操作 API p95 < 200ms；排程重算（1000 任務）< 500ms |
| 資源 | NAS 上整組 < 2 GB RAM（backend 768MB heap、PG 512MB、Valkey 128MB） |
| 可用性 | 單機部署，接受重啟時的短暫中斷；資料每日自動備份 |
| 備份 | `pg_dump` 每日 + 保留 30 份 + 附件目錄 tar；還原程序寫進 runbook |
| i18n | zh-TW / en，訊息檔外部化，日期時區依使用者設定（預設 Asia/Taipei） |
| 無障礙 | 所有拖曳互動必須有鍵盤替代路徑（dnd-kit 內建 keyboard sensor，務必啟用） |
| 稽核 | 所有寫入都留 `activity`；登入 / 權限變更 / 資料匯出另存 `audit_log`。詢問單的「誰標記已回覆」也要記（`recorded_by`），因為這是責任歸屬 |
| 資安 | Argon2id、token rotation、RFC 9457、CSP、依賴掃描（Dependabot + Trivy）、上傳檔案掃描與 content-type 白名單 |

**要特別防的已知失敗模式**（都是別人踩過的，有據可查）：

- **關聯 API 的 IDOR** — Vikunja 2026 年的 GO-2026-4847。所有 `/links` 端點都必須驗證 **source 與 target 兩端**的專案權限，不能只驗一端。同理，`/inquiries/{id}` 這類「不帶 task id 的子資源端點」必須從 id 反查所屬任務再驗權限，不能因為拿得到 id 就放行。
- **SQL Injection** — Worklenz 2026-02 的 v2.1.7 是為此發的緊急版。→ 一律 JPA / prepared statement，動態排序欄位走白名單映射，禁止字串拼接。發文追蹤的「依單位分組統計」是動態 group by，特別容易寫成拼字串，要小心。
- **個資** — `asked_to_person` / `asked_to_contact` 存的是外部人員的姓名與聯絡方式。這是個資，所以：匯出功能要有權限控管、備份要加密、專案封存時要有清除選項，並在 README 裡提醒部署者自行評估法遵。

---

## 10. 前端架構

```
src/
├─ app/                  路由、providers、全域 layout
├─ features/
│  ├─ auth/              登入、註冊、忘記密碼
│  ├─ workspace/         切換器、成員、設定
│  ├─ project/           專案 CRUD、成員
│  ├─ task/              詳情抽屜、編輯、活動時間軸
│  ├─ views/
│  │  ├─ gantt/          dhtmlx-gantt 封裝 + 依賴繪製 + 關鍵路徑上色
│  │  ├─ board/          dnd-kit 看板
│  │  ├─ calendar/       react-big-calendar + DnD addon
│  │  ├─ list/           樹狀表格 + 拖曳縮排
│  │  └─ graph/          React Flow 關聯網路圖
│  ├─ inquiry/          發文追蹤表格、單位 typeahead、追蹤看板、單位統計
│  └─ dashboard/         Recharts / ECharts 圖表
├─ shared/
│  ├─ api/               生成自 OpenAPI 的 client + TanStack Query hooks
│  ├─ dnd/               統一拖曳協定（樂觀更新 / rollback / rank 計算）
│  ├─ realtime/          STOMP client + 快取失效策略
│  └─ ui/                shadcn/ui 元件
└─ locales/              zh-TW / en
```

**兩個容易做錯的地方**：

1. **甘特與看板不要各寫一套樂觀更新。** 抽成 `useOptimisticMutation`，統一處理 rollback 與 WebSocket 回音去重（自己送出的變更廣播回來時不要再套用一次，用 client-generated `mutationId` 比對）。
2. **dhtmlx-gantt 是命令式 API，不要試圖用 React state 驅動它。** 用 ref 包一層，React 只負責掛載/卸載與傳入資料快照，內部互動事件轉成我們自己的 action 往外送。

---

## 11. 後端架構

```
com.pmflow
├─ config/            Security、WebSocket、Jackson、OpenAPI、Async
├─ auth/              註冊、登入、JWT、ShareLinkAuthenticationFilter
├─ workspace/
├─ project/
├─ task/
│  ├─ domain/         Task, TaskLink, TaskClosure
│  ├─ hierarchy/      閉包表維護、子樹彙總
│  ├─ link/           關聯 CRUD + 循環偵測（DFS on links ∪ parent edges）
│  ├─ schedule/       排程引擎：拓撲排序、前/後向推算、關鍵路徑、工作日曆
│  └─ rank/           fractional ranking 計算與 rebalance
├─ inquiry/           TaskInquiry CRUD、任務層彙總、逾期掃描、單位建議與統計
├─ mail/              SMTP 寄送（通知、逾期提醒，只寄給內部成員）
├─ activity/          統一活動日誌
├─ realtime/          STOMP 廣播
├─ storage/           本機 / S3 相容抽象層
└─ common/            錯誤處理 (RFC 9457)、稽核、分頁、冪等性
```

- **Migration 只加不改**，並在 runner 層強制：checksum 防竄改、advisory lock 防併發、單一交易保證全有或全無。詳細紀律見 `docs/MIGRATIONS.md`
- **Testcontainers** 跑整合測試（真的起一個 PostgreSQL），排程引擎另有大量單元測試
- 排程重算與寄信走 `@Async` + 有界執行緒池，不擋 HTTP 請求
- Actuator 開 `/health` `/metrics`（Prometheus 格式），但要用 Security 擋住

---

## 12. Docker 與部署

### 12.1 映像檔

| 映像 | 內容 | 基底 | 預估大小 |
|---|---|---|---|
| `ghcr.io/<you>/pmflow-backend` | Spring Boot layered jar | `eclipse-temurin:21-jre-alpine` | ~230 MB |
| `ghcr.io/<you>/pmflow-frontend` | Vite build 靜態檔 + Caddy | `caddy:2-alpine` | ~55 MB |

要點：

- **多階段建置**：builder 階段跑 Maven/npm，最終階段只複製產物
- **Spring Boot layered jar**（`java -Djarmode=tools -jar app.jar extract --layers`）讓相依層可被 Docker 快取，只改程式碼時 push 只有幾 MB
- **非 root 執行**（`USER 10001`），rootless 對 NAS 特別重要
- **multi-arch**：`linux/amd64` + `linux/arm64`（很多 NAS 是 ARM）
- 健康檢查用 Spring Actuator `/actuator/health/readiness`
- 版本標籤：`latest`、`v1.2.3`、`v1.2`、`sha-abc1234`

### 12.2 發佈到 registry

GitHub Actions（公開 repo 免費），推 tag `v*` 即自動 build 並推 GHCR：

- `docker/setup-buildx-action` + `docker/build-push-action`
- `GITHUB_TOKEN` 直接有 GHCR 寫入權限，不用另外開 PAT
- 加 GitHub Actions cache（`cache-from/to: type=gha`）加速
- 同時產生 SBOM 與 provenance attestation（供應鏈可信度，開源專案的加分項）
- 若要同步推 Docker Hub，多加一組 `DOCKERHUB_TOKEN` secret 與第二個 tag 清單

完整 workflow 見 `.github/workflows/release.yml`。

### 12.3 Compose 服務組成

```
caddy       :80/:443   反向代理 + 自動 HTTPS + 靜態檔
frontend               Caddy 提供 SPA（也可直接併進上面那層）
backend     :8080      Spring Boot
postgres    :5432      PostgreSQL 17（僅內網）
valkey      :6379      Valkey 9（僅內網）
backup                 每日 pg_dump cron（可選）
```

完整檔案見 `deploy/docker-compose.yml` 與 `deploy/.env.example`。

### 12.4 NAS 上的實務注意事項（Synology / QNAP）

這些是自架最容易卡住的地方，先寫進文件省得日後查半天：

1. **Port 衝突**：Synology DSM 佔用 80/443/5000/5001。→ compose 把 Caddy 對外映到 `8480:80` / `8443:443`，或走 DSM 內建反向代理（控制台 → 登入入口 → 進階 → 反向代理伺服器）。
2. **不要覆寫 `user:`**：一般自架教學會叫你查 `id` 再填 `PUID`/`PGID`，那是給有 bind mount 的情況用的。這套全部用具名 volume，API 映像本身以 uid `10001` 執行、`/data/attachments` 也是那個 uid 擁有，硬加 `user: "${PUID}:${PGID}"` 反而會讓附件寫不進去。
3. **PostgreSQL 資料不要放 CIFS/SMB 掛載點**，一定要用本機 Btrfs/ext4 volume，否則 fsync 語意不對會壞資料。
4. **時區**：`TZ=Asia/Taipei` 要同時給 backend 與 postgres，不然排程與逾期判斷會差 8 小時。
5. **記憶體**：低階 NAS 只有 2–4 GB。compose 裡對 backend 設 `JAVA_OPTS=-XX:MaxRAMPercentage=60`，並給每個服務 `mem_limit`。
6. **ARM NAS**：確認拉到的是 `linux/arm64` 映像；`docker manifest inspect` 可驗證。
7. **自動更新**：可掛 Watchtower，但生產環境建議關掉自動更新，改成手動 `docker compose pull && up -d`，避免半夜自動升級把資料庫 migration 跑壞。
8. **備份**：`pg_dump` 產物與 `attachments` volume 都要納入 NAS 的快照/備份任務。

---

## 13. 開發階段規劃

| 階段 | 內容 | 產出 |
|---|---|---|
| **M0 骨架**（1–2 週） | Monorepo、Docker Compose 起得來、Flyway 初始 schema、CI 綠燈、GHCR 推得上去 | 空殼但可部署 |
| **M1 核心**（3–4 週） | 註冊登入、workspace/project/task CRUD、清單視圖、看板 + dnd-kit 拖曳、活動日誌 | 可用的最小看板工具 |
| **M2 關聯與排程**（3–4 週） | 閉包表、`task_link` 四種依賴、循環偵測、排程引擎、關鍵路徑、甘特圖拖曳 | **核心差異化功能** |
| **M3 發文追蹤**（3–5 天） | `task_inquiry` 表、詳情頁表格、單位 typeahead、任務層彙總、逾期掃描、徽章、追蹤看板、單位統計 | **第二個差異化功能** |
| **M4 視覺化**（2 週） | 行事曆 + 拖曳、React Flow 關聯圖、儀表板全套圖表、ICS 訂閱 | 「圖形化越多越好」 |
| **M5 開源就緒**（1–2 週） | README、CONTRIBUTING、LICENSE (MIT)、授權掃描 CI、demo 資料、i18n、文件站、v1.0.0 release | 可對外公開 |

建議 M2 之前先把 M0 的授權掃描 CI 做起來（`license-checker` 對前端、`license-maven-plugin` 對後端，白名單只允許 MIT/Apache-2.0/BSD/ISC/PostgreSQL），否則之後某天有人 PR 進一個 GPL 套件，會很難拆。

---

## 14. 待你決定的事

1. **後端語言**：Spring Boot（配合你的專長，架構穩）vs NestJS（前後端同語言，開源貢獻者門檻低）。本規格預設 Spring Boot，NestJS 版本資料模型完全共用。
2. **專案授權**：MIT（最寬鬆、最多人願意用）vs Apache-2.0（多了專利授權條款，企業採用時法務比較安心）。
3. **甘特函式庫**：`dhtmlx-gantt@^10`（功能完整，但自動排程/關鍵路徑是 PRO，我們自己在後端算）vs `frappe-gantt`（純淨輕量，功能要自己補很多）。本規格預設前者。
4. **期望回覆日要不要有預設值**。例如建立詢問單時自動帶「提問日 + 7 個工作天」，可調整。有預設值的好處是逾期統計不會因為大家懶得填而失真。
5. **工作日曆的預設值**：要不要內建台灣國定假日表（人事行政總處每年公布，可年度更新 JSON）。這同時影響甘特排程與「逾期幾天」的計算——逾期天數要算日曆天還是工作天？

---

## 附錄 A：核心情境走查

**情境：同一件事發文給兩個單位，其中一個逾期，另一個由別的單位代回**

1. PM 在任務 `PMF-42`（機房搬遷需求確認）的「發文追蹤」區塊按「＋ 新增單位」
2. 第一列：單位打「採」，typeahead 跳出以前用過的「採購部」，選起來；承辦人「王小明」、聯絡方式「分機 2145」、提問日今天（自動帶）、期望回覆日 07/25
3. 再按一次「＋ 新增單位」加第二列：資訊部 / 李大同 / lee@… / 期望回覆日 07/25
4. 存檔 → 兩筆 `task_inquiry`，`task.inquiry_state` 變成 `AWAITING`，`earliest_due_date = 07/25`，卡片出現藍色徽章，行事曆 07/25 多兩個「期望回覆」事件
5. 07/24 採購部回了 → 同事在系統勾「回了沒」→ 回覆單位自動帶入「採購部」、回覆日自動帶今天 → 直接存檔
6. `task.inquiry_state` 重算成 `PARTIAL`，卡片徽章變黃色 `1/2 已回`
7. 07/26 凌晨的排程掃描發現資訊部那筆 `due_date < CURRENT_DATE` 且未回 → `inquiry_state` 轉 `OVERDUE`、卡片變紅、寄信提醒**我方的任務負責人**（不是寄給資訊部）
8. 07/28 資訊部把案子轉給委外廠商，是廠商打電話來回的 → 同事勾「回了沒」，但把回覆單位改成「宏碁資服」、回覆人改成「陳工程師」→ **提問側仍是資訊部，回覆側是宏碁資服**，兩邊各自留存
9. `inquiry_state` 變 `REPLIED`，徽章轉綠
10. 月底看單位統計：採購部平均 4 天回、資訊部平均 8 天回且逾期率 40%——這個數字拿得出來，正是因為單位是獨立欄位而不是寫在留言裡

**情境：拖曳甘特上一條長條，下游全部要跟著動**

1. 使用者拖 `PMF-10` 往後 3 天
2. 前端樂觀更新，並用 `/schedule/preview` 拿到受影響任務的預覽（灰色虛影顯示下游會被推到哪）
3. 放開 → `POST /tasks/PMF-10/reschedule {startDate, dueDate, cascade:true}`
4. 後端：驗權限 → 更新日期 → 拓撲排序下游子圖 → 對 `schedule_mode=AUTO` 的任務前向推算（`MANUAL` 的跳過，成為錨點）→ 重算關鍵路徑 → 同交易寫 `activity`
5. 若推算後有 `MANUAL` 任務被違反 → 不 rollback，而是回傳衝突清單，前端在側欄列出「3 個排程衝突」讓人決定
6. WebSocket 廣播 `/topic/project.{id}`，同事畫面上的長條自己動起來

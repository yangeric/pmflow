# 異動紀錄

> **接手工作請先讀下面的索引**，找到相關條目再往下翻細節。
> 每批改動都要在索引加一列、在「詳細條目」最上面加一段。日期為實際動工日。
> 不知道某個功能住在哪個檔 → 看 [`CODEMAP.md`](./CODEMAP.md)。

## 索引

| 日期 | 主題 | 主要檔案 | 狀態 |
|---|---|---|---|
| 2026-08-03 | [帳號設定與工作區管理者（後端）](#2026-08-03--帳號設定與工作區管理者後端) | `apps/api/src/routes/account.ts`（新）、`lib/auth.ts`、`web/src/lib/api.ts` | 待驗證 |
| 2026-08-03 | [關聯圖：並行拆成同時開始／同時完成／重疊](#2026-08-03--關聯圖並行拆成同時開始同時完成重疊) | `apps/web/src/pages/Graph.tsx` | 待驗證 |
| 2026-08-03 | [關聯圖：匯合點改成小圓點、圖示說明固定在最下排](#2026-08-03--關聯圖匯合點改成小圓點圖示說明固定在最下排) | `apps/web/src/pages/Graph.tsx` | 待驗證 |
| 2026-08-03 | [關聯圖：虛線規則、文字描邊、說明收角落、點一下不再位移](#2026-08-03--關聯圖虛線規則文字描邊說明收角落點一下不再位移) | `apps/web/src/pages/Graph.tsx` | 待驗證 |
| 2026-08-03 | [補上程式地圖 CODEMAP.md](#2026-08-03--補上程式地圖-codemapmd) | `docs/CODEMAP.md`（新）、`docs/ARCHITECTURE.md` | 完成 |
| 2026-08-03 | [換帳號沒清快取，畫面留著前一個人的資料](#2026-08-03--換帳號沒清快取畫面留著前一個人的資料) | `apps/web/src/lib/auth.tsx`、`App.tsx` | 已驗證 |
| 2026-08-03 | [成員權限：前端 UI](#2026-08-03--成員權限前端-ui) | `components/MembersPanel.tsx`（新）、`ProjectPicker.tsx`、`App.tsx`、`routes/members.ts` | 已驗證 |
| 2026-08-03 | [關聯圖：卡住與並行標記](#2026-08-03--關聯圖卡住與並行標記) | `apps/web/src/pages/Graph.tsx` | 已驗證 |
| 2026-08-03 | [關聯圖：階層線補上「包含」標籤](#2026-08-03--關聯圖階層線補上包含標籤) | `apps/web/src/pages/Graph.tsx` | 已驗證 |
| 2026-08-03 | [成員權限：創立者核准制（後端）](#2026-08-03--成員權限創立者核准制後端) | `apps/api/src/routes/members.ts`、`migrations/0002_*` | 已驗證 |
| 2026-08-03 | [關聯圖：同時開始／完成改成分岔與合流](#2026-08-03--關聯圖同時開始完成改成分岔與合流) | `apps/web/src/pages/Graph.tsx` | 已驗證 |
| 2026-08-03 | [關聯圖：節點不顯示／fitView 不觸發](#2026-08-03--關聯圖節點不顯示fitview-不觸發) | `apps/web/src/pages/Graph.tsx` | 已驗證 |

---

## 詳細條目

### 2026-08-03 — 帳號設定與工作區管理者（後端）

**為什麼**：使用者說「我怎麼沒有更改帳號資訊的地方」「還需要 admin 權限的帳號」。
註冊之後就再也改不了自己的名字與密碼，也沒有人能停用離職同事的帳號 —— 自架站沒有這個就只能進資料庫改。

**改了什麼**：
- `apps/api/src/lib/auth.ts` — 新增 `WorkspaceRole` 與 `requireWorkspaceAdmin()`。
  工作區管理者管的是「誰能登入這個站」，**不會**因此看得到每個專案的內容 ——
  專案要進得去仍然要專案建立者放行（`requireProjectCreator`），兩套權限刻意分開。
- `apps/api/src/routes/account.ts`（新）— 六個端點：
  `GET/PATCH /me/profile`、`POST /me/password`、`GET/POST /admin/users`、`PATCH /admin/users/:userId`。
- `apps/api/src/index.ts` — 註冊路由。
- `apps/web/src/lib/api.ts` — 型別（`MyProfile`、`AdminUser`、`WorkspaceRole`）與端點函式。

**護欄**（都在 `account.ts`）：
- 只有 OWNER 給得出／改得動另一個 OWNER。
- 不能改自己的角色、不能停用自己 —— 手滑就登不回來。
- 最後一個還活著的 OWNER 不能被降級或停用，站台一定要留得下一個管得動的人。
- 改密碼、被停用、被管理者重設密碼，三種情況都會把該帳號的 refresh token 全部作廢，
  停用要立刻生效，不能等他手上那張 access token 自己過期。

**前端**（同一天補上）：
- `components/AccountPanel.tsx`（新）— 改顯示名稱／email／密碼，以及自己在哪些工作區。
  改密碼成功後**直接登出** —— 後端會把所有 refresh token 撤掉（含這一台），
  與其讓他下次開頁莫名被登出，不如當場重登，至少知道發生了什麼事。
- `components/AdminPanel.tsx`（新）— 帳號一覽（狀態、參與幾個專案、開了幾個）、
  改工作區角色、停用／復用、新增帳號、代設密碼。ADMIN 動不了 OWNER 的按鈕直接不畫。
- `App.tsx` — 新增 `AccountView` 一層，蓋在最上面，沒選專案也進得去；
  「系統管理」只有 OWNER/ADMIN 看得到頁籤。
- 入口：側欄底部與選專案頁右上角都加「帳號設定」。
- `lib/auth.tsx` — 新增 `refreshUser()`，改完名字側欄立刻換掉，不用重新登入。

**還沒做**：沒有寄信機制，管理者開的帳號密碼是當面給的（畫面上有寫）。
`app_user.status` 的 PENDING 目前沒有流程會產生，只有顯示。

---

### 2026-08-03 — 關聯圖：並行拆成同時開始／同時完成／重疊

**為什麼**：使用者說「勾選顯示圖示『並行』，但那個是指並行開始、並非並行完成，你缺了並行完成」。
原本一個 `⇉ 並行 n` 徽章把所有「日期重疊又沒有先後」的任務混在一起講，
但這三件事在派工上是不同的問題：同一天開始＝人力要同一天到位；
同一天完成＝驗收會撞在一起；只是重疊＝各走各的，沒什麼要協調。

**改了什麼**（`Graph.tsx`）：
- `parallelWith` 由 `Map<string, string[]>` 改成 `Map<string, ParallelPeers>`，
  `ParallelPeers = { sameStart, sameFinish, overlap }`，三類互斥。
- 判定順序：先看有沒有明確連「同時開始／同時完成」（吃 `simul` 的分群，
  **不管有沒有填日期都算數** —— 那是使用者親手講的，比日期可靠），
  再看是不是同一天開始／同一天結束，都不是才落到單純重疊。
- 徽章拆成三顆，顏色跟圖上的匯合點對齊：橘＝同時開始、紫＝同時完成、青＝並行。
- 聚焦面板同步拆成三列。

---

### 2026-08-03 — 關聯圖：匯合點改成小圓點、圖示說明固定在最下排

**為什麼**：使用者問「不知道同時動作納編為啥要多一條垂直線」，
以及「關聯圖的小圖示沒有一個固定說明的位置」。
那根跟群組一樣高的直條看起來像另一種依賴，反而更難讀；
節點上的小圖示則是「看到才要查」的東西，需要一個永遠在同一個位置的地方。

**改了什麼**（`Graph.tsx`）：
- `JUNCTION_W`（6px 長條）→ `JUNCTION_SIZE`（10px 圓點），放在群組的垂直中點，
  加白色外圈讓它在穿過的線上仍看得出來。扇形自己會張開，不需要直條去「連住」它們。
- 新增 `IconLegendBar` —— 固定在畫布下方的一排圖示說明（卡住／同時開始／同時完成／
  並行／匯合點／大項目／里程碑／詢問四態）。線條說明仍留在左下角可收合的「？線條說明」裡，
  因為它會擋到圖；圖示列不會。

---

### 2026-08-03 — 關聯圖：虛線規則、文字描邊、說明收角落、點一下不再位移

**為什麼**：使用者連續回報四件事 ——「我看不懂虛線的用法」「你有文字筐會影響線條」
「那個線條說明你也要做個可以隱藏在角落的機制」「分支合併的那個線條有出現錯位的感覺」。

**改了什麼**（`Graph.tsx`）：
- **虛線規則講清楚**：實線＝會推動日期（排程依賴），虛線＝不會。
  語意關聯改成較深的 `#64748b` + `7 4`，階層改成稀疏點 `1 5`，兩者一眼分得開。
- **線上的字改用描邊**：拿掉 `labelShowBg` 的白底方框，改成 `paintOrder: 'stroke'`
  加畫布底色的粗描邊（`labelText()`），字看得清楚又不會把線切斷。
- **說明收到角落**：工具列的「圖例」按鈕與常駐提示都拿掉，改成畫布左下角的
  「？線條說明」小藥丸，展開才佔位。`LegendRow` 改用 `<svg><line>`，
  才能跟畫面上的線用同一組 `strokeDasharray`。
- **錯位修正**：`nodeDragThreshold={4}`。React Flow 預設是 1，
  點一下若手指抖了 1–2px 就會被當成拖曳寫進 `dragged`，
  那一張節點就會離開欄位（實測 678.458px vs 680px），看起來像分岔線畫歪了。

---

### 2026-08-03 — 補上程式地圖 CODEMAP.md

**為什麼**：使用者說「你應該有做架構圖、知道程式架構，應該就知道該改哪裡」。
`ARCHITECTURE.md` 確實存在，但它是最早的設計稿 —— 上面寫 Spring Boot 3.5 / Java 21 / JPA /
Flyway / Valkey / STOMP，**實作是 Fastify + TypeScript + postgres.js**，照著它找檔案只會找錯地方。

**改了什麼**：
- `docs/CODEMAP.md`（新）— 「想改 X → 去哪個檔」對照表、前後端每個檔案的行數與職責、
  資料表清單，以及踩過的坑（Graph 的 `measured`、不能引 elkjs、快取鍵沒有使用者、
  migration 有 checksum 不能改、tag 沒有 v）。
- `docs/ARCHITECTURE.md` — 開頭加警告，指向 CODEMAP。
- `docs/CHANGELOG.md` — 開頭指向 CODEMAP。

---

### 2026-08-03 — 換帳號沒清快取，畫面留著前一個人的資料

**為什麼**：驗成員功能時登出 demo、改登 tester，畫面上還是 demo 的專案、側欄與成員面板。
伺服器那邊是好的（tester 的 token 去要 MRG 就是 403），但**在重新抓到之前，上一個人的資料已經在螢幕上了**。
共用電腦上這不能接受。根因：TanStack Query 的快取鍵 `['projects']`、`['tasks', id]` 裡沒有使用者，
換人不會讓它失效；`projectId` 又住在 `App` 的 state 裡，登出也沒清。

**改了什麼**：
- `apps/web/src/lib/auth.tsx` — 拿 `useQueryClient()`，登入成功與登出時都 `qc.clear()`。
  登入那次要在 `setUser` **之前**清，否則新畫面會先讀到舊快取再被清掉，畫面會閃。
- `apps/web/src/App.tsx` — render 期間比對 `user.id`，換人就把 `projectId` / `view` / `openTask` 歸零
  （React 官方認可的 adjusting-state-during-render 寫法，比 useEffect 少一次錯誤的 render）。

**驗證**：demo → 登出 → tester 登入，直接落在選專案頁，只看得到「其他專案」。

---

### 2026-08-03 — 成員權限：前端 UI

**為什麼**：後端的核准制做完了但沒有入口，等於沒有這個功能。

**改了什麼**：
- `apps/web/src/components/MembersPanel.tsx`（新）— 加入申請（核准時一併選角色／婉拒）、
  成員清單（改角色／移除）、直接加入成員。**待審清單與所有按鈕都掛在後端回的 `canManage` 底下**，
  不是前端自己猜。建立者自己不能改角色、不能被移除，否則專案會沒人管成員。
- `apps/web/src/pages/ProjectPicker.tsx` — 多一區「其他專案」：同工作區、自己還不是成員的專案，
  只露門面（代碼、名稱、誰開的、幾人），按「申請加入」可填理由，送出後變「審核中／撤回申請」。
  自己的專案卡片上多一顆 🙋 待審人數（這個數字後端只給建立者）。
- `apps/web/src/App.tsx` — 多一個「成員」頁籤，待審 > 0 時掛紅點。
- `apps/api/src/routes/members.ts` — 補 `GET /workspace-users`：原本沒有「同工作區有哪些帳號」的端點，
  「直接加入成員」的下拉選單就沒東西可列。

**驗證**：tester 申請加入 MRG → demo 端看到卡片 🙋 1、頁籤紅點 1 → 核准 → 成員 2 人、紅點消失、
下拉變成「同工作區的帳號都已經在這個專案裡了」。

---

### 2026-08-03 — 關聯圖：卡住與並行標記

**為什麼**：使用者要看出「任務被上一個任務卡住無法處理」與「任務可以同時並行」。

**改了什麼**：`apps/web/src/pages/Graph.tsx`，節點上多兩個徽章、工具列多兩個開關。
- **卡住**（🚧，紅框＋紅徽章，預設開）：上游還沒 DONE 就算卡住。FS/BLOCKS/REQUIRES 看上游是不是 DONE，
  SS 只有上游還在 TODO 才算（上游已經動起來了就不算卡）。自己已經 DONE 就不標。
- **並行**（⇉，預設關）：**日期有重疊 + 彼此在流程上沒有先後 + 不是父子祖孫**。
  「沒有先後」是拿 FS/SF 邊做可達性 DFS 算的（SS/FF 不算先後，那正是同時做）。
  預設關掉是因為並行對數會隨任務數量長很快，全開會太吵。
- 圖例多一段「節點上的標記」，焦點面板也解釋這兩個顏色。

**驗證**：MRG 上 MRG-5/6/7 有 🚧；勾選並行後 MRG-6、MRG-7 出現「⇉ 並行 1」。

---

### 2026-08-03 — 關聯圖：階層線補上「包含」標籤

**為什麼**：使用者說「我看不懂虛線關聯是啥」。父子階層線原本沒有文字，畫面上就是一條灰虛線，
跟語意關聯（relates/blocks）的虛線只差在深淺與虛線間距，根本分不出來。
這個模組的規矩是**每條線上都有中文短句，圖例只是輔助**。

**改了什麼**：`apps/web/src/pages/Graph.tsx` — 階層邊加上 `label: '包含'`，
連同 `labelShowBg` / `labelBgPadding` / `labelStyle`，並讓標籤跟著既有的 `dim()` 一起淡出。

**驗證**：重建 web 容器 → 開 MRG 機房搬遷 → 關聯圖 → 7 條父子線上都要看得到「包含」。

---

### 2026-08-03 — 成員權限：創立者核准制（後端）

**為什麼**：使用者要求「專案創立者才有權限讓別的帳號加入，其他帳號是申請加入、要創立者同意」。
過程中發現更大的缺口：**原本完全沒有加成員的 API**，建專案的人是唯一 MANAGER，
其他人註冊後雖然自動進工作區，但 `GET /projects` 只列自己是成員的專案，登入後一個都看不到。

**改了什麼**：
- `apps/api/src/migrations/0002_project_membership.sql`（新）— `project.created_by`（回填最早的 MANAGER，
  uuidv7 有時序所以可以這樣挑）、`project_member.joined_at/added_by`、`project_join_request` 表。
  狀態 PENDING/APPROVED/REJECTED/CANCELLED，**部分唯一索引只鎖 PENDING**，所以被婉拒後可以再申請。
- `apps/api/src/lib/auth.ts` — `requireProjectCreator`、`requireWorkspaceMember`。
- `apps/api/src/routes/members.ts`（新）— 可申請的專案清單、成員 CRUD、申請／核准／婉拒／撤回。
  核准用 `FOR UPDATE` + `ON CONFLICT DO NOTHING`，連點兩下不會重複加人。
- `apps/api/src/routes/projects.ts` — 建立時寫 `created_by`；清單多回 `isCreator` 與 `pendingJoinRequestCount`。
- `apps/api/src/index.ts` — 註冊 `memberRoutes`。
- `apps/web/src/lib/api.ts` — 型別與 11 個端點函式。

**刻意的設計決定**：創立者是獨立欄位、不沿用 MANAGER 角色 —— 角色是「能做什麼」可以有很多個，
創立者是「這專案誰開的」只有一個。不能移除創立者、不能改創立者自己的角色。
沒做通知信（系統還沒有寄信的東西），待審靠畫面上的數字提醒。

**驗證**：型別過了，**尚未在畫面上驗證**（前端 UI 還沒做）。

---

### 2026-08-03 — 關聯圖：同時開始／完成改成分岔與合流

**為什麼**：使用者指出「同時開始跟同時完成不應該在同一線上」。原本 SS/FF 跟 FS 一樣往右推一欄，
畫出來像接力賽，語意是錯的 —— 示範資料裡 MRG-6 與 MRG-7 明明都是 08/22 開始，卻被排在不同欄。
接著他定下畫法：**一路箭頭分成多路（同時開始）、多路箭頭合成一路（同時完成）**。

**改了什麼**：`apps/web/src/pages/Graph.tsx`
- `layout()` 多收 `linkType`，用 union-find 把 SS/FF 兩端併成同一欄；只有 FS/SF 才推層級。
- `TaskNodeView` 除了原本的 `in`（左）/`out`（右），多兩個隱形錨點：
  `fork`（左緣的 source）、`join`（右緣的 target），`isConnectable={false}` 不讓使用者從這裡拉線。
- 邊的路由：`sourceHandle: type === 'SS' ? 'fork' : 'out'`、`targetHandle: type === 'FF' ? 'join' : 'in'`。
  沒有這兩個錨點時，同欄的 SS 線會從右邊繞一個 U 型迴到左邊。

**驗證**：畫面上 MRG-6／MRG-7 同欄，線呈分岔／合流。

---

### 2026-08-03 — 關聯圖：節點不顯示／fitView 不觸發

**為什麼**：8 個節點全部卡在 `visibility: hidden`，`nodesInitialized` 永遠是 false。

**根因**（對照 `@xyflow/system` 原始碼確認，不是猜的）：`adoptUserNodes` 每次收到新的 nodes 陣列時，
是**照著 `node.measured` 重建內部尺寸**。而這裡的節點是每次 render 從資料重算的衍生物件、身上沒有 `measured`，
等於每次 render 都把 React Flow 剛量到的尺寸抹成 undefined。

**改了什麼**：`apps/web/src/pages/Graph.tsx`
- 新增 `measured` state，`onNodesChange` 收下 dimensions 變更（尺寸沒真的變就不換物件，
  否則平移縮放時 ResizeObserver 重送同值會讓整張圖白白重畫）。
- `styledNodes` 把 `measured[n.id]` 疊回節點上。
- 順手修掉「重新排列」按鈕不重新框視野：fitView 的 effect 少了 `relayout` 依賴，
  按鈕設好的 `fitPending` 要等下次換資料才會被消化。

**驗證**：DOM 量測 `count:8`、`hidden:0`、`edges:12`、viewport scale `0.870787`（不是 1）。

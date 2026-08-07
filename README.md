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
docker-compose.dev.yml       本機：從原始碼建置
docker-compose.yml           NAS：拉 GHCR image，設定值放 .env
docker-compose.synology.yml  Synology Container Manager 專用：設定值直接寫死
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

用 SSH 進 NAS 的話：

```bash
curl -O https://raw.githubusercontent.com/<你的帳號>/pmflow/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/<你的帳號>/pmflow/main/.env.example

cp .env.example .env
openssl rand -base64 48        # 產生 JWT_SECRET，貼進 .env
# 同時改 POSTGRES_PASSWORD 與 IMAGE_OWNER

docker compose pull && docker compose up -d
```

用 **Synology Container Manager** 的圖形介面則改用另一份：Container Manager →
專案 → 新增 → 來源選「建立 docker-compose.yml」→ 貼上
`docker-compose.synology.yml` 的內容（照檔案裡「改我」的標示改四個地方）。
那份不需要 `.env`，因為那個介面建不出點開頭的隱藏檔。

**NAS 最容易踩的三個坑**（完整清單見 `docker-compose.yml` 檔尾）：

1. Synology DSM 佔用 80/443/5000/5001 → 已預設對外映 8480
2. **Synology Container Manager 的「專案」介面讀不到 `.env`**（建不出點開頭的隱藏檔），
   要改用 `docker-compose.synology.yml`，那份把所有值直接寫在檔案裡
3. **PostgreSQL 資料絕不能放 SMB/CIFS 掛載點**，fsync 語意不對，資料庫遲早損毀

---

## 用 Google／Apple 的帳號登入

**這是綁定，不是取代。** email + 密碼那條路一直都在，一個帳號可以同時綁 Google 與 Apple、也可以一個都不綁。

**整段不設定就是不啟用** —— 登入頁不會畫那兩顆按鈕，其他功能完全不受影響。畫一顆按下去一定壞的按鈕，比沒有那個功能還糟。

### 先看兩個改不了的外部條件

| | Google | Apple |
|---|---|---|
| 要不要付費 | 不用 | **要**，Apple Developer Program，一年 US$99 |
| callback 收不收 `localhost` | 收（測試用途） | **不收**，一定要對外可達的 https 網址 |

所以**在本機 `http://localhost:8480` 上只驗得到「按鈕有沒有正確導去對方的授權頁」**，走不完整個登入流程 —— 對方要連得回你的 callback，而 localhost 從外面連不到。

### 要填哪些變數

全部寫在 `.env`（正式部署）或外層 shell 的環境變數（`docker-compose.dev.yml`）。

```
PUBLIC_URL=https://pm.example.com     # 這個站從外面看的網址，結尾不要斜線

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

APPLE_CLIENT_ID=com.example.pmflow.web    # Services ID，不是 App ID
APPLE_TEAM_ID=ABCDE12345
APPLE_KEY_ID=XYZ9876543
APPLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----
```

`PUBLIC_URL` 是必填的：callback 網址是拿它拼出來的，後端看不到使用者是從哪個網址進來的（前面還有反向代理），猜一個出來只會換到 `redirect_uri_mismatch`。填了 Google 那兩個就只開 Google，填了 Apple 那四個就只開 Apple，兩邊互不影響。

### callback 網址長什麼樣

申請時要登記的網址**必須一字不差**：

```
<PUBLIC_URL>/api/v1/auth/oauth/google/callback
<PUBLIC_URL>/api/v1/auth/oauth/apple/callback
```

### 怎麼申請

**Google**（免費）
1. [Google Cloud Console](https://console.cloud.google.com/) → 建一個專案
2. 「API 和服務」→「OAuth 同意畫面」→ 填應用程式名稱與支援信箱
3. 「憑證」→「建立憑證」→「OAuth 用戶端 ID」→ 類型選**網路應用程式**
4. 「已授權的重新導向 URI」填上面那個 `.../google/callback`
5. 拿到的用戶端 ID 與密鑰填進 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

**Apple**（要付費帳號）
1. [Apple Developer](https://developer.apple.com/account) → Certificates, Identifiers & Profiles
2. Identifiers → 新增一個 **App ID**，勾選 Sign in with Apple
3. Identifiers → 再新增一個 **Services ID**（這個才是 `APPLE_CLIENT_ID`），
   設定它的 Sign in with Apple：Domain 填你的網域、Return URL 填上面那個 `.../apple/callback`
4. Keys → 新增一把 key，勾 Sign in with Apple，**下載 `.p8`（只能下載一次）**
5. `APPLE_TEAM_ID` 在右上角、`APPLE_KEY_ID` 是那把 key 的編號、
   `APPLE_PRIVATE_KEY` 是 `.p8` 的內容（換行寫成 `\n`，或整份 base64 之後貼上）

> **金鑰只走環境變數，不要 commit 進 repo。** Apple 的 client secret 是後端拿 `.p8`
> **當場簽出來的 JWT**（規格允許最長 6 個月，這裡只給 5 分鐘），沒有任何長期密鑰要存。

### 登入之後會發生什麼

- **這個外部帳號綁過了** → 直接登入那個帳號（認的是對方給的使用者 id，不是 email —— email 會被改，Apple 還會給轉寄用的假地址）
- **email 還沒有帳號** → 直接開一個（登入頁本來就開放註冊，這條路不該更嚴；`ALLOW_SELF_REGISTRATION=false` 時一樣擋）
- **email 已經有帳號** → **只有對方明講「這個 email 已驗證」才自動綁上去**；沒驗證就請他先用密碼登入，再到「帳號設定 → 登入方式」自己綁。少了這道關卡，任何人只要在別處註冊一個同名信箱就能接管別人的帳號
- **已經綁好的想解除** → 帳號設定裡解；但**不能解除最後一個登入方式** —— 沒有密碼又解掉唯一的綁定，那個人就再也進不來了（這個站沒有寄信能力，沒有「忘記密碼」可以救）

---

## 發版

你要準備的東西：**一個 GitHub repo**。就這樣。

- **不用 Docker Hub 帳號** —— GHCR 內建在 GitHub 裡
- **不用設任何 secret** —— `GITHUB_TOKEN` 本身就有 GHCR 寫入權
- 公開 repo 的 Actions 分鐘數與 GHCR 流量都免費（私人 repo 每月 2000 分鐘也夠用）

repo 裡有兩個 workflow，觸發條件不同，這是最容易搞混的地方：

| workflow | 什麼時候跑 | 做什麼 |
|---|---|---|
| `ci.yml` | push 到 main、開 PR | 型別檢查、單元測試、端對端測試、授權白名單掃描。**不產生映像** |
| `release.yml` | 推 `v*` 開頭的 tag | build amd64 + arm64、推 GHCR（有設 secret 就一併推 Docker Hub）、附 SBOM 與 provenance、開 GitHub Release |

所以「推上 main」只會跑測試。要產生新映像必須打 tag：

```bash
git push                          # 先讓 CI 跑過，確認沒壞
git tag v0.1.2
git push origin v0.1.2            # 這一步才會 build 映像
```

⚠️ **映像標籤沒有開頭的 `v`。** `git tag v0.1.2` 產出的映像是
`ghcr.io/<你的帳號>/pmflow-api:0.1.2` —— `docker/metadata-action` 的 semver
樣板會把 `v` 去掉，因為 semver 規範裡版本號本身不含 `v`，那只是 git tag 的慣例前綴。
寫成 `:v0.1.2` 會拿到 `manifest unknown`，而那個訊息看起來像映像不存在，
很容易往錯的方向查。每次 tag 也會一併更新 `latest`、`0.1`、`0` 這幾個標籤。

**首次發版後必做一次**：GHCR 的 package 預設是私有的，**就算 repo 是公開的也一樣**。
不改的話 NAS 拉不到，而 GHCR 對看不到的 package 一律回 `manifest unknown`
（不回「沒有權限」，避免洩漏 package 是否存在），所以症狀跟上面那個坑一模一樣。
到 `github.com/<你的帳號>?tab=packages` → `pmflow-api` → Package settings →
Danger Zone → Change visibility → Public，`pmflow-web` 再做一次。只需做這一次。

---

## 已知限制

- 儀表板圖表（燃盡圖、負載熱圖）還沒做
- 即時多人同步還沒接 WebSocket，目前靠 TanStack Query 的重新抓取
- **系統不會寄信**：新帳號的密碼、重設密碼都要管理者當面給；逾期提醒也只出現在
  站內的通知鈴鐺，不會寄出去
- 附件上傳的資料表與 volume 都在，端點還沒實作
- `docs/ARCHITECTURE.md` 是最早的設計稿（Spring Boot / Flyway），**跟實作對不上**，
  要找檔案請看 `docs/CODEMAP.md`

---

授權 MIT，見 `LICENSE`。

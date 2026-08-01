# 資料庫演進紀律

> 一句話：**資料庫是長期資產，程式是可替換的。**
> 換 image、回滾版本、甚至整個後端改寫成另一種語言，資料都不該受影響。

這份文件講的是怎麼讓「改架構」不會弄壞「正在跑的系統」。它不是理論——
下面每一條規則都對應一個真的會發生、而且發生時很難救的失敗。

---

## 1. 為什麼要脫離

自架系統升級時的實際情形是這樣的：

```
舊容器還在服務  ──┐
                  ├── 同一個 PostgreSQL
新容器剛啟動    ──┘
```

`docker compose up -d` 換 image 的那幾秒到幾分鐘，**新舊兩版程式會同時對著同一個資料庫**。
如果新版的 migration 直接把欄位改名或刪掉，舊容器在那個瞬間就開始噴錯；
更糟的是你想回滾時，資料已經沒了。

所以規則不是「migration 要寫得好」，而是：

> **任何一次 schema 變更，都必須讓「上一版程式」還能正常運作。**

做到這件事，升級可以隨時中止、版本可以隨時回滾、資料庫可以獨立備份還原，
架構調整就真的跟運作中的系統脫離了。

---

## 2. Runner 幫你守住的三件事

`apps/api/src/lib/db.ts` 的 migration runner 刻意不用現成框架（少一層魔法，出事看得懂），
但守住三個關鍵不變量：

| 規則 | 怎麼守 | 不守會怎樣 |
|---|---|---|
| **只加不改** | 每個已套用的檔案存 SHA-256（前 32 碼）。內容被改過 → 開機直接失敗 | 同一個檔名在兩台機器上長成不同 schema，而且沒人會發現 |
| **一次只有一個人改 schema** | 整段流程包在 `pg_advisory_xact_lock` 裡 | NAS 重開或多容器同時啟動時兩邊搶著跑 DDL，撞成半套 |
| **全有或全無** | 所有待跑的 migration 在同一個交易裡完成 | 中途失敗留下半套 schema，系統處於沒人知道的狀態 |

另外會擋掉**插隊的 migration**：從舊分支帶回一個編號較小的檔案時，
不同機器的套用順序會不一致。真的要放行才設 `PMFLOW_ALLOW_OUT_OF_ORDER_MIGRATION=true`。

已驗證行為（可自行重現）：

```
第一次（已有資料庫，補登 checksum）: 無新 migration ✅
checksum 已寫入: ✅ dc994a3f3fdc…
竄改偵測: ✅ migration 0001_init.sql 的內容在套用之後被修改了（checksum 不符）
併發啟動兩次: ✅ 都正常（advisory lock 序列化）
```

---

## 3. Expand–Contract：唯一安全的改法

需要「改」既有結構時，不要一步到位。拆成**兩次發佈**，中間隔一段安全期。

### 例：把 `task.assignee_id` 從單人改成多人

**❌ 危險做法（一次到位）**

```sql
-- 舊容器立刻爆炸，而且回滾不了
ALTER TABLE task DROP COLUMN assignee_id;
CREATE TABLE task_assignee (...);
```

**✅ Expand–Contract**

```
第 1 次發佈（Expand，只加不刪）
  migration: CREATE TABLE task_assignee (...)         -- 加新結構
  程式：     寫入時「新舊都寫」，讀取時仍讀舊欄位
  → 舊容器完全不受影響，可隨時回滾

第 2 次發佈（Migrate + Switch）
  migration: 把 assignee_id 回填進 task_assignee      -- 只搬資料
  程式：     讀取改吃新表，仍然雙寫
  → 出事就把程式退回上一版，資料兩邊都在

  ⟵⟵ 這裡至少放一個穩定週期，確認沒有東西還在讀舊欄位

第 3 次發佈（Contract，很久以後）
  程式：     停止寫舊欄位
  migration: ALTER TABLE task DROP COLUMN assignee_id
  → 確定沒人用了才刪
```

同樣的模式適用於改名（加新欄位 → 雙寫 → 回填 → 換讀 → 刪舊）、
改型別、拆表、合表。**改名永遠不是 `RENAME`，是「加一個、搬過去、刪一個」。**

### 一律安全的動作

- `CREATE TABLE`
- `ADD COLUMN`（可為 NULL，或有 DEFAULT）
- `CREATE INDEX`（大表用 `CREATE INDEX CONCURRENTLY`，但它不能在交易裡跑，要獨立成一個 migration 並在檔頭註明）
- 放寬約束（`DROP NOT NULL`、放寬 CHECK）

### 一律危險的動作

- `DROP COLUMN` / `DROP TABLE` / `RENAME`
- 收緊約束（加 `NOT NULL`、縮小型別、加更嚴的 CHECK）——舊資料可能不符合
- 直接 `ALTER TYPE`

危險動作不是不能做，是**必須排在 Contract 階段**，而且前提是確認沒有任何還在跑的版本會用到。

---

## 4. 寫 migration 的規矩

1. **檔名遞增、永不重號**：`0002_add_task_assignee.sql`。動詞開頭，看名字就知道做什麼。
2. **一個 migration 一件事**。混在一起的話，失敗時很難判斷做到哪。
3. **可以重跑不出錯**（盡量）：用 `IF NOT EXISTS` / `IF EXISTS`。雖然 runner 不會重跑，但手動修復時你會感謝自己。
4. **不要在 migration 裡寫業務邏輯**。資料回填就純回填，複雜轉換寫成獨立腳本。
5. **已經 merge 進 main 的 migration 不准改**。要修正就加新的一個。CI 會擋。
6. **加欄位不要有預設值以外的計算**。大表上 `ADD COLUMN ... DEFAULT <volatile>` 會鎖表重寫。
7. **註解寫「為什麼」**，不是寫「做了什麼」——做了什麼 SQL 本身就看得到。

---

## 5. 升級與回滾流程

「改架構」和「換程式」是兩個獨立、可分別回滾的動作，不要綁在同一次容器重啟裡：

```bash
# 0. 先備份（backup 服務每天做，但升級前手動再做一次）
docker compose exec -T db pg_dump -U pmflow --no-owner pmflow | gzip > pre-upgrade.sql.gz

# 1. 只跑 migration，不換程式
docker compose run --rm api npm run migrate

# 2. 確認沒問題後才換 image
docker compose pull && docker compose up -d
```

**回滾**：因為 migration 都是 additive 的，直接把 image tag 退回上一版即可，
schema 停在新版沒關係——舊程式看不到新欄位，但也不會壞。

```bash
PMFLOW_VERSION=v1.2.3 docker compose up -d
```

這正是 expand-contract 的報酬：**回滾不需要 down migration**。
所以這個專案刻意不提供 down migration——它給人一種可以安全倒退的錯覺，
實際上刪掉的資料是回不來的。要倒退，靠的是備份還原，不是反向 SQL。

---

## 6. 資料與架構脫離的其他面向

Schema 只是其中一環。整個系統的「資料不隨架構走」還包含：

| 面向 | 作法 |
|---|---|
| **儲存體** | 資料放在具名 volume（`pmflow-pgdata`、`pmflow-attachments`），不放在容器層。刪容器、換 image、甚至改用不同的後端語言，資料都在 |
| **設定** | 全部走環境變數，不編進 image。同一個 image 可以跑在你的筆電和 NAS 上 |
| **API 契約** | 路徑帶 `/api/v1`。要做破壞性變更就開 `/api/v2` 並讓 v1 續活一段時間，前端可以慢慢遷 |
| **識別碼** | 主鍵用 UUID v7 而非序號。搬移、合併、跨庫同步時不會撞號，也不洩漏數量 |
| **業務語意** | 狀態值存 `text` + CHECK，不用 PostgreSQL enum。加一個狀態是加 CHECK，不是 `ALTER TYPE`（後者在舊版 PG 上不能在交易裡跑） |
| **可擴充欄位** | `task.custom_fields jsonb`。使用者要多一個欄位不需要 migration |
| **備份** | `pg_dump` 每日 + 附件目錄。**還原程序要真的演練過**——沒驗證過的備份等於沒有備份 |
| **後端可替換** | 資料表與 API 契約是規格的一部分（`SPEC.md` §5、§8）。之後要把後端換成 Spring Boot，schema 與 API 不動，前端一行都不用改 |

---

## 7. CI 怎麼擋

`.github/workflows/ci.yml` 的 `migration-guard` 會在 PR 上檢查：
**已經在 main 上的 migration 檔有沒有被修改或刪除**。有就直接讓 PR 失敗，
並提示「請新增一個 migration，不要改舊的」。

這道關卡比 runner 的 checksum 更早生效——checksum 是在別人的資料庫上爆炸，
CI 是在合併之前就擋下來。

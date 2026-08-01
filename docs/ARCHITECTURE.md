# PMFlow 架構圖

> 搭配 `SPEC.md` 閱讀。所有圖以 Mermaid 撰寫，GitHub / GitLab / VS Code 皆可直接渲染。

---

## 1. 系統全景圖

```mermaid
graph TB
    subgraph Client["使用者端 — 全部是登入的系統成員"]
        BROWSER["瀏覽器 SPA<br/>React 19 + TypeScript + Vite"]
        CALAPP["Google Calendar / Outlook<br/>（ICS 唯讀訂閱）"]
        INBOX["成員信箱<br/>通知 · 逾期提醒"]
    end

    subgraph Edge["邊緣層"]
        CADDY["Caddy 2<br/>反向代理 · 自動 HTTPS · 靜態檔"]
    end

    subgraph App["應用層 — Spring Boot 3.5 / Java 21"]
        REST["REST API<br/>/api/v1"]
        WS["WebSocket / STOMP<br/>/ws"]
        SEC["Security<br/>JWT（單一驗證主體）"]
        SCHED["排程引擎<br/>拓撲排序 · 關鍵路徑"]
        INQ["發文追蹤<br/>TaskInquiry · 單位統計"]
        MAILOUT["SMTP Sender<br/>只寄給內部成員"]
        JOBS["排程工作<br/>逾期掃描 · 備份 · 重算"]
    end

    subgraph Data["資料層"]
        PG[("PostgreSQL 17<br/>業務資料 · 閉包表 · 全文檢索")]
        VK[("Valkey 9<br/>快取 · Session · 排程結果")]
        FS["附件儲存<br/>Docker volume / S3 相容"]
    end

    EXT["外部單位<br/>採購部 / 資訊部 / 廠商…"]

    EXT -. "電話 · 公文 · Email · 會議<br/>（系統外，由我方人員登錄）" .-> BROWSER

    BROWSER -->|HTTPS| CADDY
    CALAPP -->|ICS feed| CADDY
    CADDY --> REST
    CADDY -.->|WSS 升級| WS

    REST --> SEC
    WS --> SEC
    SEC --> SCHED
    SEC --> INQ
    REST --> PG
    SCHED --> PG
    SCHED --> VK
    INQ --> PG
    JOBS --> INQ
    JOBS --> PG
    JOBS --> MAILOUT
    MAILOUT -->|SMTP| INBOX

    REST --> VK
    REST --> FS
    WS -->|廣播| BROWSER

    style Client fill:#e8f4fd,stroke:#3178c6
    style Edge fill:#fff4e6,stroke:#e07b39
    style App fill:#e9f7ef,stroke:#2e8b57
    style Data fill:#fdeef0,stroke:#c0392b
    style EXT fill:#f4f4f4,stroke:#999,stroke-dasharray:5 5
```

> **外部單位在系統邊界之外。** 他們不登入、不收系統信、不填任何表單。溝通發生在系統外（電話、公文、Email、會議），由我方人員把「提給誰、回了沒、誰回的」登錄進來。這讓整個系統只有一種驗證主體，權限模型維持最簡單的形狀。

---

## 2. 後端分層與模組

```mermaid
graph LR
    subgraph L1["介面層"]
        C1["Controller<br/>REST"]
        C2["StompController<br/>即時"]
        C3["ScheduledJobs<br/>逾期掃描 · 備份"]
    end

    subgraph L2["應用服務層 — 權限在此把關"]
        S1["TaskService"]
        S2["LinkService"]
        S3["ScheduleService"]
        S4["InquiryService"]
        S5["StatsService<br/>單位統計"]
        S6["ActivityService"]
    end

    subgraph L3["領域層"]
        D1["Task<br/>Aggregate"]
        D2["TaskLink<br/>4 種 type + lag"]
        D3["TaskClosure<br/>階層閉包"]
        D4["TaskInquiry<br/>提問側 / 回覆側"]
        D5["CycleDetector<br/>DFS on links ∪ parents"]
        D6["CriticalPath<br/>前向/後向遍歷"]
        D7["RankCalculator<br/>fractional ranking"]
        D8["InquiryRollup<br/>算 task.inquiry_state"]
    end

    subgraph L4["基礎設施層"]
        R1["JPA Repository"]
        R2["Flyway Migration"]
        R3["ValkeyCache"]
        R4["StorageAdapter"]
        R5["MailAdapter<br/>SMTP only"]
    end

    C1 --> S1 & S2 & S3 & S4 & S5
    C2 --> S1
    C3 --> S4

    S1 --> D1 & D3 & D7 & S6
    S2 --> D2 & D5 & S6
    S3 --> D6 & D2
    S4 --> D4 & D8 & S6
    S5 --> D4

    D1 & D2 & D3 & D4 --> R1
    S3 --> R3
    S4 --> R5
    S1 --> R4
    R1 --> R2

    style L2 fill:#e9f7ef,stroke:#2e8b57
    style L3 fill:#fff4e6,stroke:#e07b39
```

---

## 3. 資料模型 ER 圖

```mermaid
erDiagram
    WORKSPACE ||--o{ PROJECT : "包含"
    WORKSPACE ||--o{ WORKSPACE_MEMBER : ""
    APP_USER ||--o{ WORKSPACE_MEMBER : ""
    APP_USER ||--o{ PROJECT_MEMBER : ""
    PROJECT ||--o{ PROJECT_MEMBER : ""
    PROJECT ||--o{ TASK : "包含"

    TASK ||--o{ TASK : "parent_id 上下階層"
    TASK ||--o{ TASK_CLOSURE : "ancestor"
    TASK ||--o{ TASK_CLOSURE : "descendant"
    TASK ||--o{ TASK_LINK : "source 左右關聯"
    TASK ||--o{ TASK_LINK : "target"
    TASK ||--o{ ACTIVITY : "時間軸"
    TASK ||--o{ TASK_INQUIRY : "跨單位發文追蹤"
    TASK ||--o{ ATTACHMENT : ""
    TASK }o--o{ LABEL : "task_label"

    APP_USER ||--o{ TASK_INQUIRY : "asked_by 我方發問人"
    APP_USER ||--o{ TASK_INQUIRY : "recorded_by 誰登錄回覆"
    APP_USER ||--o{ ACTIVITY : "actor"

    WORKSPACE {
        uuid id PK
        text slug UK
        text name
    }
    PROJECT {
        uuid id PK
        uuid workspace_id FK
        text key "PMF"
        text name
        date start_date
        date end_date
    }
    TASK {
        uuid id PK
        uuid workspace_id "反正規化"
        uuid project_id FK
        int number "PMF-123"
        uuid parent_id FK "上下"
        text title
        text status
        text schedule_mode "AUTO / MANUAL"
        date start_date
        date due_date
        numeric rank "拖曳排序"
        text inquiry_state "衍生彙總"
        date earliest_due_date "最早的期望回覆日"
    }
    TASK_LINK {
        uuid id PK
        uuid source_id FK
        uuid target_id FK
        text link_type "FS SS FF SF RELATES BLOCKS DUPLICATES REQUIRES"
        int lag_days "可為負"
    }
    TASK_CLOSURE {
        uuid ancestor_id PK
        uuid descendant_id PK
        int depth "0 = 自己"
    }
    TASK_INQUIRY {
        uuid id PK
        uuid task_id FK
        smallint seq "同任務內順序"
        text asked_to_unit "★ 提給哪個單位（自由文字）"
        text asked_to_person "承辦人"
        text asked_to_contact "電話或 email"
        date asked_at "提問日"
        date due_date "期望回覆日"
        text question
        bool is_replied "★ 回了沒"
        text replied_by_unit "★ 實際回覆單位（可能不同）"
        text replied_by_person
        date replied_at
        text reply_note "選填摘要"
    }
    ACTIVITY {
        uuid id PK
        uuid task_id FK
        text kind "COMMENT FIELD_CHANGE INQUIRY_CHANGE ..."
        jsonb body
        uuid actor_id FK "NULL = 系統"
        text actor_name "快照"
    }
    ATTACHMENT {
        uuid id PK
        uuid task_id FK
        text filename
        text storage_key
        uuid uploaded_by FK
    }
    LABEL {
        uuid id PK
        uuid project_id FK "NULL = workspace 通用"
        text name
        text color
    }
```

**兩個要注意的設計**：

1. `asked_to_unit` 與 `replied_by_unit` 是**兩個獨立欄位**，不是同一個外鍵。因為實務上「發文給資訊部、由委外廠商回」「案子轉單位」都很常見，共用一欄就記不下這件事。
2. 兩者都是 **`text` 自由文字**，沒有單位主檔。輸入時靠 `v_unit_suggestion` 這個 view 提供歷史值 typeahead——不綁死使用者，又能讓統計不至於太亂。日後想正規化，加一張 `unit_alias` 對照表即可，不用改結構。

---

## 4. 任務「上下左右」關聯示意

```mermaid
graph TB
    subgraph EPIC["上下：階層 — parent_id + 閉包表"]
        E["EPIC PMF-1<br/>會員系統"]
        E --> A["PMF-10 設計 API"]
        E --> B["PMF-20 前端實作"]
        E --> C["PMF-30 測試"]
        A --> A1["PMF-11 資料表設計"]
        A --> A2["PMF-12 API 文件"]
    end

    A1 -.->|"FS lag=0"| A2
    A2 ==>|"FS lag=+2 天"| B
    B -.->|"SS lag=0<br/>同時起跑"| C
    B -.->|"FF lag=0<br/>同時收尾"| C
    A -.->|"RELATES 語意關聯<br/>不影響排程"| C
```

圖例：
- **粗實線（==>）**＝ 排程類依賴，會推動下游日期
- **虛線（-.->）**＝ 語意類關聯，只做關聯與呈現
- **上下箭頭**＝ 父子階層，父任務的日期與完成率由子任務彙總

四種排程依賴的時間軸語意：

```mermaid
gantt
    title 四種依賴的時間關係
    dateFormat YYYY-MM-DD
    axisFormat %m/%d

    section FS 完成到開始
    來源 A           :a1, 2026-08-01, 4d
    目標 B（A完成後開始）:after a1, 3d

    section SS 開始到開始
    來源 C           :c1, 2026-08-01, 5d
    目標 D（與C同時起）  :2026-08-01, 3d

    section FF 完成到完成
    來源 E           :e1, 2026-08-01, 5d
    目標 F（與E同時收）  :2026-08-03, 3d

    section SF 開始到完成
    來源 G           :g1, 2026-08-03, 4d
    目標 H（G開始前收尾）:2026-08-01, 2d
```

---

## 5. 跨單位發文追蹤流程

```mermaid
sequenceDiagram
    autonumber
    actor PM as 專案經理
    participant UI as SPA
    participant API as Backend
    participant DB as PostgreSQL
    participant JOB as 每日排程
    participant MAIL as SMTP
    actor EXT as 外部單位<br/>（系統外，無帳號）

    Note over PM,EXT: 【提問側】同一件事發文給兩個單位

    PM->>UI: 任務 PMF-42 →「發文追蹤」→ ＋ 新增單位
    UI->>API: GET /unit-suggestions?q=採
    API->>DB: 查 v_unit_suggestion
    API-->>UI: ["採購部", "採購科"]（最近用過優先）
    PM->>UI: 選「採購部」/ 王小明 / 分機2145 / 期望回覆 07-25
    PM->>UI: 再新增一列：資訊部 / 李大同 / 07-25
    UI->>API: POST /tasks/PMF-42/inquiries × 2
    API->>DB: 寫 2 筆 task_inquiry (is_replied=false)
    API->>DB: 重算 task.inquiry_state = AWAITING<br/>earliest_due_date = 07-25
    API-->>UI: 201 + 廣播 /topic/project.{id}
    Note over UI: 卡片出現藍色徽章「⏳ 2 個單位待回覆」<br/>行事曆 07-25 多兩個期望回覆事件

    PM-->>EXT: 發文 / 打電話 / 開會（系統之外）

    Note over PM,EXT: 【回覆側】情況一：原單位如期回覆

    EXT-->>PM: 07-24 採購部王小明回覆
    PM->>UI: 勾選「回了沒」
    Note over UI: 回覆單位自動帶「採購部」<br/>回覆日自動帶今天 —— 兩個欄位都可改
    UI->>API: POST /inquiries/{id}/mark-replied
    API->>DB: is_replied=true, replied_by_unit='採購部',<br/>replied_at=07-24, recorded_by=PM
    API->>DB: 重算 → task.inquiry_state = PARTIAL
    API-->>UI: 徽章轉黃「1/2 已回」

    Note over PM,EXT: 情況二：逾期

    JOB->>DB: 07-26 00:05 掃 NOT is_replied AND due_date < today
    DB-->>JOB: 資訊部那筆逾期
    JOB->>DB: task.inquiry_state = OVERDUE
    JOB->>MAIL: 寄提醒信
    Note over MAIL: ⚠️ 只寄給我方任務負責人<br/>不會寄給外部單位
    MAIL-->>PM: 「PMF-42：資訊部逾期 1 天未回」
    Note over UI: 卡片徽章轉紅「⚠️ 資訊部 逾期 1 天」

    Note over PM,EXT: 情況三：案子被轉單位，由別人回

    EXT-->>PM: 07-28 資訊部委外的宏碁資服陳工程師來電回覆
    PM->>UI: 勾「回了沒」，但把回覆單位改成「宏碁資服」
    UI->>API: POST /inquiries/{id}/mark-replied<br/>{repliedByUnit:"宏碁資服", repliedByPerson:"陳工程師"}
    API->>DB: asked_to_unit 仍是「資訊部」<br/>replied_by_unit 是「宏碁資服」—— 兩側各自留存
    API->>DB: 重算 → task.inquiry_state = REPLIED
    API-->>UI: 徽章轉綠「✅ 已回」

    Note over PM,DB: 月底：因為單位是獨立欄位，<br/>「各單位平均回覆天數 / 逾期率」查得出來
```

**為什麼提問側與回覆側要分開存**

```mermaid
graph LR
    subgraph ASK["提問側（不會變）"]
        A1["asked_to_unit<br/>資訊部"]
        A2["asked_to_person<br/>李大同"]
        A3["asked_at 07-20"]
        A4["due_date 07-25"]
    end

    subgraph REP["回覆側（實際發生的）"]
        R1["replied_by_unit<br/>宏碁資服 ← 不同！"]
        R2["replied_by_person<br/>陳工程師"]
        R3["replied_at 07-28"]
    end

    ASK -->|"多數情況相同<br/>勾選時自動帶入<br/>但可以改"| REP

    ASK --> Q1["統計：<br/>我們最常發文給誰"]
    REP --> Q2["統計：<br/>誰真的在做事"]
    ASK --> Q3["統計：<br/>誰最常拖<br/>replied_at - asked_at"]

    style ASK fill:#e8f4fd,stroke:#3178c6
    style REP fill:#e9f7ef,stroke:#2e8b57
```

若兩側共用一個欄位，「發文給資訊部但實際是廠商回」這件事就記不下來，而這在機關與大企業裡幾乎是常態。

## 6. 拖曳與樂觀更新協定

```mermaid
sequenceDiagram
    autonumber
    actor U as 使用者
    participant V as 視圖<br/>（甘特/看板/行事曆/清單）
    participant Q as TanStack Query 快取
    participant API as Backend
    participant S as 排程引擎
    participant WS as WebSocket

    U->>V: 拖曳長條 / 卡片
    V->>API: POST /schedule/preview（僅甘特，乾跑）
    API-->>V: 下游影響預覽（灰色虛影）
    U->>V: 放開
    V->>Q: 樂觀寫入本地快取（畫面立即更新）
    Note over V,Q: 帶 client 產生的 mutationId
    V->>API: PATCH /tasks/{id}/move 或 /reschedule<br/>body 只帶「變更意圖」

    API->>API: 權限檢查（service 層）
    API->>API: 循環依賴檢查（links ∪ parents）
    alt 驗證失敗
        API-->>V: 409 RFC 9457<br/>{type: cyclic-dependency, cycle:[...]}
        V->>Q: rollback
        V-->>U: toast「會造成循環依賴：PMF-12 → PMF-45 → PMF-12」
    else 驗證通過
        API->>S: 若日期變動 → 拓撲排序下游 → 前向推算<br/>（MANUAL 任務跳過，成為錨點）
        S-->>API: 新日期 + 關鍵路徑 + 衝突清單
        API->>API: 同交易寫 activity
        API-->>V: 200 權威版本
        V->>Q: 以權威版本覆寫
        API->>WS: 廣播 /topic/project.{id}
        WS-->>V: 其他人畫面同步
        Note over V: 收到自己送出的回音時<br/>以 mutationId 比對後略過
    end
```

**排序用 fractional ranking**：`rank` 存 `numeric`，插入 A、B 之間時取 `(A.rank + B.rank) / 2`，只 UPDATE 一列。精度降到閾值以下時背景重新平衡整欄。避免「拖一張卡就 UPDATE 整欄」。

---

## 7. 認證與權限管線

```mermaid
flowchart TD
    REQ["HTTP / WS 請求"] --> F1{"帶 JWT？"}

    F1 -->|"否"| DENY401["401"]
    F1 -->|"是<br/>sub = user:{id}"| AUTH["UserPrincipal<br/>（系統唯一的驗證主體）"]

    AUTH --> SVC["Service 層<br/>@PreAuthorize + PermissionEvaluator"]

    SVC --> CK1{"workspace 成員？"}
    CK1 -->|否| DENY["403"]
    CK1 -->|是| CK2{"project 角色足夠？"}
    CK2 -->|否| DENY
    CK2 -->|是| CK3["物件層檢查"]

    CK3 --> X1["關聯 API：source 與 target<br/>兩端都要驗（防 IDOR）"]
    CK3 --> X2["子資源 API：/inquiries/{id} 沒帶 task id，<br/>必須反查所屬任務再驗權限"]
    CK3 --> X3["跨 workspace 關聯：一律拒絕"]
    CK3 --> X4["個資：asked_to_person / contact<br/>匯出需額外權限，寫 audit_log"]

    X1 & X2 & X3 & X4 --> OK["執行"]

    style DENY fill:#fdeef0,stroke:#c0392b
    style DENY401 fill:#fdeef0,stroke:#c0392b
    style OK fill:#e9f7ef,stroke:#2e8b57
    style X1 fill:#fff4e6,stroke:#e07b39
    style X2 fill:#fff4e6,stroke:#e07b39
```

> 因為外部單位不進系統，這條管線只有**一種**驗證主體——沒有訪客、沒有 token 交換、沒有匿名寫入。橘色框是別人踩過的真實漏洞類型（Vikunja 2026 的關聯 IDOR，GO-2026-4847），從第一天設計進去比事後補便宜太多。

## 8. 前端模組圖

```mermaid
graph TB
    subgraph SHELL["App Shell"]
        RT["路由<br/>/w/:ws/p/:key/:view"]
        SW["Workspace / Project 切換器"]
    end

    subgraph VIEWS["視圖層 — 全部可拖曳"]
        G["甘特<br/>dhtmlx-gantt ^10 (MIT)"]
        B["看板<br/>dnd-kit"]
        CAL["行事曆<br/>react-big-calendar + DnD"]
        L["清單/樹狀表格<br/>dnd-kit"]
        GR["關聯網路圖<br/>React Flow"]
        DASH["儀表板<br/>Recharts / ECharts"]
        RB["發文追蹤看板<br/>+ 單位統計"]
    end

    subgraph SHARED["共用層"]
        DND["統一拖曳協定<br/>樂觀更新 · rollback · rank"]
        APIC["API Client<br/>由 OpenAPI 生成"]
        RQ["TanStack Query 快取"]
        RTM["STOMP Realtime<br/>快取失效 + 回音去重"]
        UI["shadcn/ui + Tailwind"]
    end

    RT --> G & B & CAL & L & GR & DASH & RB
    SW --> RT
    G & B & CAL & L & GR --> DND
    DND --> RQ
    RQ --> APIC
    RTM --> RQ
    G & B & CAL & L & GR & DASH & RB --> UI

    style VIEWS fill:#e8f4fd,stroke:#3178c6
    style SHARED fill:#e9f7ef,stroke:#2e8b57
```

---

## 9. Docker 部署圖（NAS）

```mermaid
graph TB
    NET["網際網路 / 區域網路"]

    subgraph NAS["NAS 主機 — Docker Compose"]
        subgraph PUB["對外網路 pmflow-public"]
            CADDY["caddy:2-alpine<br/>8480→80 / 8443→443<br/>自動 HTTPS + SPA 靜態檔"]
        end

        subgraph PRIV["內部網路 pmflow-internal（不對外開 port）"]
            BE["pmflow-backend<br/>ghcr.io/&lt;you&gt;/pmflow-backend<br/>非 root · MaxRAMPercentage=60"]
            PG[("postgres:17-alpine<br/>本機 volume<br/>❗ 不可放 CIFS/SMB")]
            VK[("valkey/valkey:9-alpine")]
            BK["backup<br/>每日 pg_dump · 保留 30 份"]
        end

        VOL1[["volume: pgdata"]]
        VOL2[["volume: attachments"]]
        VOL3[["volume: backups"]]
        VOL4[["volume: caddy_data<br/>憑證"]]
    end

    SMTP["外部 SMTP<br/>（只寄信，不收信）"]

    NET -->|":8480 / :8443"| CADDY
    CADDY --> BE
    BE --> PG
    BE --> VK
    BE --> VOL2
    BE -->|"通知 / 逾期提醒"| SMTP
    PG --> VOL1
    BK --> PG
    BK --> VOL3
    CADDY --> VOL4

    style PUB fill:#fff4e6,stroke:#e07b39
    style PRIV fill:#e9f7ef,stroke:#2e8b57
```

**NAS 五大坑**（詳見 SPEC §12.4）：
1. Synology DSM 佔用 80/443/5000/5001 → 對外改映 8480/8443
2. 不需要設 PUID/PGID —— 全用具名 volume，映像自帶非 root 使用者
3. PostgreSQL 資料**絕不能**放 SMB/CIFS 掛載點
4. `TZ=Asia/Taipei` 要同時給 backend 與 postgres，否則逾期判斷差 8 小時
5. ARM NAS 要確認拉到 `linux/arm64` 映像

---

## 10. CI/CD 流程

```mermaid
flowchart LR
    DEV["git push"] --> CI

    subgraph CI["GitHub Actions — PR 檢查"]
        LINT["Lint + 型別檢查"]
        TEST["單元測試<br/>+ Testcontainers 整合測試"]
        LIC["🔑 授權掃描<br/>白名單: MIT/Apache-2.0/BSD/ISC/PostgreSQL"]
        SEC["Trivy 弱點掃描"]
    end

    LINT & TEST & LIC & SEC --> PR{"全綠？"}
    PR -->|否| BLOCK["擋住 merge"]
    PR -->|是| MERGE["merge to main"]

    MERGE --> TAG["打 tag v1.2.3"]

    subgraph REL["Release Workflow"]
        BUILDX["docker buildx<br/>linux/amd64 + linux/arm64"]
        LAYER["Spring Boot layered jar<br/>相依層可快取"]
        SBOM["產生 SBOM<br/>+ provenance attestation"]
        PUSH["推 GHCR<br/>latest / v1.2.3 / v1.2 / sha-xxx"]
    end

    TAG --> BUILDX --> LAYER --> SBOM --> PUSH

    PUSH --> NAS["NAS 手動<br/>docker compose pull && up -d"]

    style LIC fill:#fff4e6,stroke:#e07b39,stroke-width:2px
    style BLOCK fill:#fdeef0,stroke:#c0392b
```

> 授權掃描要在 **M0 階段就建起來**。等專案長大後才發現某個相依是 GPL，拆解成本非常高——WeKan 就是因為甘特函式庫是 GPL，最後只能把甘特功能拆成完全獨立的 repo 分開 build。

---

## 11. 開發里程碑

```mermaid
gantt
    title PMFlow 開發路線
    dateFormat YYYY-MM-DD
    axisFormat %m月

    section M0 骨架
    Monorepo + Docker Compose      :m0a, 2026-08-04, 7d
    Flyway schema + CI + GHCR      :m0b, after m0a, 7d
    授權掃描 CI（關鍵）              :crit, m0c, after m0a, 4d

    section M1 核心
    註冊登入 + JWT                  :m1a, after m0b, 10d
    Workspace/Project/Task CRUD    :m1b, after m1a, 10d
    看板 + dnd-kit 拖曳              :m1c, after m1b, 8d

    section M2 關聯與排程
    閉包表 + 階層彙總                :crit, m2a, after m1c, 7d
    task_link 四種依賴 + 循環偵測     :crit, m2b, after m2a, 10d
    排程引擎 + 關鍵路徑              :crit, m2c, after m2b, 10d
    甘特圖拖曳                       :m2d, after m2c, 8d

    section M3 發文追蹤
    task_inquiry 表 + 詳情頁表格      :crit, m3a, after m2d, 2d
    單位 typeahead + 彙總 + 逾期掃描   :crit, m3b, after m3a, 2d
    追蹤看板 + 單位統計               :m3c, after m3b, 1d

    section M4 視覺化
    行事曆 + 拖曳                    :m4a, after m3c, 6d
    關聯網路圖 + 儀表板               :m4b, after m4a, 8d

    section M5 開源就緒
    文件 + LICENSE + demo 資料      :m5a, after m4b, 8d
    v1.0.0 release                 :milestone, after m5a, 0d
```

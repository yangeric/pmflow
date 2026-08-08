import { sql } from './lib/db.js'
import { hashPassword } from './lib/auth.js'
import { rebuildClosure } from './lib/graph.js'
import { recalcInquiryState, addWorkingDays, toISODate } from './lib/inquiry.js'
import { fillDefaults } from './routes/parameters.js'

const STATUSES = [
  { key: 'todo',      name: '待辦',     category: 'TODO',   color: '#94a3b8', rank: 1000 },
  { key: 'doing',     name: '進行中',   category: 'ACTIVE', color: '#3178c6', rank: 2000 },
  { key: 'review',    name: '待驗收',   category: 'ACTIVE', color: '#e07b39', rank: 3000 },
  { key: 'verifying', name: '驗證中',   category: 'ACTIVE', color: '#8b5cf6', rank: 3200 },
  { key: 'verified',  name: '驗證完成', category: 'DONE',   color: '#0d9488', rank: 3500 },
  { key: 'done',      name: '已完成',   category: 'DONE',   color: '#2e8b57', rank: 4000 },
]

const day = (offset: number) => {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + offset)
  return toISODate(d)
}

/**
 * 回填用的時間戳。示範資料要有「過去幾週」的樣子，不能全部都是 now()。
 *
 * 不帶時區後綴是刻意的：資料庫的時區是 Asia/Taipei，這樣寫進去的
 * 「那天 09:00」就是台北的 09:00，`created_at::date` 分桶時才會落在對的日子。
 * 補上 Z 的話全部會往前位移八小時，跨日的那幾筆就跑到前一天去了。
 */
const at = (offset: number, time: string) => `${day(offset)}T${time}:00`

/**
 * 第一次啟動時建立示範資料，讓人打開就有東西看，不用面對空白畫面。
 * 已經有使用者就完全不動。設 PMFLOW_SEED_DEMO=false 可關閉。
 */
export async function seedDemo(): Promise<boolean> {
  const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM app_user`
  if (Number(count) > 0) return false

  const pw = await hashPassword('demo1234')

  await sql.begin(async tx => {
    const [ws] = await tx<{ id: string }[]>`
      INSERT INTO workspace (slug, name) VALUES ('demo', '示範工作區') RETURNING id`
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app_user (email, password_hash, display_name, status, email_verified_at)
      VALUES ('demo@pmflow.local', ${pw}, '示範帳號', 'ACTIVE', now()) RETURNING id`
    await tx`INSERT INTO workspace_member (workspace_id, user_id, role)
             VALUES (${ws.id}, ${user.id}, 'OWNER')`

    const projects = [
      { key: 'MRG', name: '機房搬遷', color: '#3178c6' },
      { key: 'WEB', name: '官網改版', color: '#2e8b57' },
    ]

    for (const [pi, meta] of projects.entries()) {
      // created_by 一定要填。0002 只回填了它之前就存在的專案，
      // 全新安裝的示範專案是在那之後才建的 —— 漏了這一欄，示範帳號就不是
      // 自己專案的建立者，成員管理與加入申請整條流程都會 403。
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO project (workspace_id, key, name, color, start_date, end_date, rank,
                             created_by)
        VALUES (${ws.id}, ${meta.key}, ${meta.name}, ${meta.color},
                ${day(-28)}, ${day(45)}, ${(pi + 1) * 1000}, ${user.id})
        RETURNING id`
      await tx`INSERT INTO project_member (project_id, user_id, role)
               VALUES (${p.id}, ${user.id}, 'MANAGER')`
      for (const s of STATUSES) {
        await tx`INSERT INTO task_status (project_id, key, name, category, color, rank)
                 VALUES (${p.id}, ${s.key}, ${s.name}, ${s.category}, ${s.color}, ${s.rank})`
      }
      // 優先度與任務類型現在也是每個專案一份（0011_project_parameters.sql）。
      // 示範資料是直接 INSERT 專案的，繞過了 POST /projects，所以要自己補
      await fillDefaults(tx, p.id, 'priority')
      await fillDefaults(tx, p.id, 'type')

      if (pi > 0) continue   // 第二個專案留空，方便試「切換專案」

      // ── 建一組有階層、有四種依賴的任務，讓甘特一打開就有東西看 ──
      // 刻意做成三個「大項目」（parent 為 null），側欄才看得出結構。
      //
      // 每張任務還要帶三樣「時間感」的東西，不然儀表板一打開是空的：
      //   c     這張任務是哪天開出來的。燃盡圖的總量從這天開始算，
      //         全部都用 now() 的話，過去每一天的總量都是 0，線是平的。
      //   hist  狀態變更的歷程（見下面的 activity 回填）。**重播的結果必須
      //         等於 st**，對不上的話燃盡圖會把它算成「完成時間是估的」。
      //   mine  指給示範帳號。留一部分不指派，熱圖才有「沒有指定負責人」那列。
      const defs: Array<{
        n: number; title: string; type: string; st: string
        s: number; d: number; parent: number | null; prog: number
        c: number; mine?: boolean; est?: number | null
        hist?: Array<[number, string, string]>
      }> = [
        // 大項目一：已經做掉一大半的前置作業，燃盡線的下坡就是這一段
        { n: 1, title: '前置準備',       type: 'EPIC',      st: 'doing', s: -28, d: 3,  parent: null, prog: 55, c: -28 },
        { n: 2, title: '需求確認與盤點', type: 'TASK',      st: 'doing', s: -7, d: 3,  parent: 1,    prog: 60, c: -28, mine: true,
          hist: [[-6, 'todo', 'doing']] },
        { n: 3, title: '設備清冊建立',   type: 'TASK',      st: 'done',  s: -7, d: -2, parent: 1,    prog: 100, c: -28, mine: true,
          hist: [[-7, 'todo', 'doing'], [-3, 'doing', 'review'], [-2, 'review', 'done']] },
        { n: 4, title: '網路架構確認',   type: 'TASK',      st: 'doing', s: -1, d: 3,  parent: 1,    prog: 40, c: -28,
          hist: [[-1, 'todo', 'doing']] },
        { n: 11, title: '現地勘查與拍照', type: 'TASK',     st: 'done',  s: -28, d: -24, parent: 1,  prog: 100, c: -28, mine: true,
          hist: [[-27, 'todo', 'doing'], [-24, 'doing', 'done']] },
        { n: 12, title: '既有網路盤點',   type: 'TASK',     st: 'done',  s: -27, d: -22, parent: 1,  prog: 100, c: -28, mine: true,
          hist: [[-26, 'todo', 'doing'], [-22, 'doing', 'done']] },
        { n: 13, title: '機房環境量測',   type: 'TASK',     st: 'done',  s: -25, d: -20, parent: 1,  prog: 100, c: -28,
          hist: [[-24, 'todo', 'doing'], [-19, 'doing', 'done']] },
        { n: 14, title: '廠商初步洽談',   type: 'TASK',     st: 'done',  s: -22, d: -16, parent: 1,  prog: 100, c: -28, mine: true,
          hist: [[-21, 'todo', 'doing'], [-18, 'doing', 'review'], [-16, 'review', 'done']] },
        { n: 15, title: '搬遷範圍界定',   type: 'TASK',     st: 'done',  s: -18, d: -12, parent: 1,  prog: 100, c: -28,
          hist: [[-17, 'todo', 'doing'], [-12, 'doing', 'done']] },
        { n: 16, title: '停機時段協調',   type: 'TASK',     st: 'verified', s: -14, d: -8, parent: 1, prog: 100, c: -28, mine: true,
          hist: [[-13, 'todo', 'doing'], [-9, 'doing', 'verifying'], [-6, 'verifying', 'verified']] },
        // 中途才追加的事。燃盡圖上的總量會在這天往上跳一格，那是要被看見的
        { n: 17, title: '備援方案評估',   type: 'TASK',     st: 'doing', s: -10, d: 2,  parent: 1,   prog: 30, c: -10, mine: true,
          est: null,
          hist: [[-9, 'todo', 'doing']] },
        // 大項目二
        { n: 5, title: '採購與施工',     type: 'EPIC',      st: 'todo',  s: 5,  d: 30, parent: null, prog: 0, c: -28 },
        { n: 6, title: '採購與到貨',     type: 'TASK',      st: 'todo',  s: 5,  d: 20, parent: 5,    prog: 0, c: -28, mine: true },
        { n: 7, title: '機櫃配置施工',   type: 'TASK',      st: 'todo',  s: 21, d: 30, parent: 5,    prog: 0, c: -28 },
        // 大項目三
        { n: 8, title: '遷移與切換',     type: 'EPIC',      st: 'todo',  s: 21, d: 38, parent: null, prog: 0, c: -28 },
        { n: 9, title: '系統遷移測試',   type: 'TASK',      st: 'todo',  s: 21, d: 34, parent: 8,    prog: 0, c: -28 },
        { n: 10, title: '正式切換',      type: 'MILESTONE', st: 'todo',  s: 38, d: 38, parent: 8,    prog: 0, c: -28 },
        /*
         * 「同時完成」那個匯合點的下游。
         *
         * 少了這一張，測試與切換這組同時完成的任務後面就沒有人接 ——
         * 關聯圖的規則是「匯合點的結束點沒有任務可接就不畫點」
         * （見 AGENTS.md），所以示範資料會示範不到紫色匯合點長什麼樣子。
         * 有了它，畫面上才會出現「兩張任務 → 匯合點 → 一張任務」的完整形狀。
         */
        { n: 18, title: '切換後驗收',   type: 'TASK',      st: 'todo',  s: 39, d: 42, parent: 8,    prog: 0, c: -28 },
        // 大項目四：資安與合規
        { n: 19, title: '資安與合規',   type: 'EPIC',      st: 'doing', s: 5,  d: 36, parent: null, prog: 40, c: -28 },
        { n: 20, title: '資安架構複審', type: 'TASK',      st: 'doing', s: 5,  d: 20, parent: 19,   prog: 50, c: -28, mine: true },
        { n: 21, title: '防火牆規則套用', type: 'TASK',    st: 'todo',  s: 15, d: 25, parent: 19,   prog: 0, c: -28 },
        { n: 22, title: '資安合規稽核', type: 'MILESTONE', st: 'todo',  s: 34, d: 34, parent: 19,   prog: 0, c: -28 },
      ]

      const ids = new Map<number, string>()
      for (const t of defs) {
        // 開出來的當下是什麼狀態 —— 有歷程就是第一次變更的「變更前」，
        // 沒有歷程就是它現在的狀態（那種任務從頭到尾沒被動過）
        const initial = t.hist?.[0][1] ?? t.st
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO task (workspace_id, project_id, number, parent_id, title, type,
                            status_key, start_date, due_date, progress, estimate_hours,
                            assignee_id, rank, created_by, created_at)
          VALUES (${ws.id}, ${p.id}, ${t.n}, ${t.parent ? ids.get(t.parent)! : null},
                  ${t.title}, ${t.type}, ${t.st}, ${day(t.s)}, ${day(t.d)}, ${t.prog},
                  ${t.est !== undefined ? t.est : (t.d - t.s + 1) * 8},
                  ${t.mine ? user.id : null}, ${t.n * 1000}, ${user.id},
                  ${at(t.c, '09:00')})
          RETURNING id`
        ids.set(t.n, row.id)
        await rebuildClosure(tx, row.id)

        /*
         * 回填活動紀錄。燃盡圖是把這些紀錄重播回去畫的（lib/burndown.ts），
         * 只有任務沒有紀錄的話，線會是一條平的 —— 示範資料等於沒有示範到。
         *
         * 每一筆都是真正合法的紀錄：CREATED 帶初始狀態，之後每次轉換都是
         * FIELD_CHANGE 帶 statusKey 與 statusKeyBefore，跟使用者自己在畫面上
         * 操作寫出來的一模一樣。時間刻意錯開（建立 09:00、變更 14:00），
         * 同一天建立又馬上改的任務才排得出先後。
         */
        await tx`
          INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body, created_at)
          VALUES (${ws.id}, ${row.id}, 'CREATED', ${user.id}, '示範帳號',
                  ${sql.json({ title: t.title, statusKey: initial })}, ${at(t.c, '09:00')})`
        for (const [off, before, after] of t.hist ?? []) {
          await tx`
            INSERT INTO activity (workspace_id, task_id, kind, actor_id, actor_name, body, created_at)
            VALUES (${ws.id}, ${row.id}, 'FIELD_CHANGE', ${user.id}, '示範帳號',
                    ${sql.json({ statusKey: after, statusKeyBefore: before })},
                    ${at(off, '14:00')})`
        }
        // 最後一次異動的時間跟著歷程走。留著 now() 的話，明明三週前就結案的
        // 任務會在清單上排到最前面
        const last = t.hist?.[t.hist.length - 1]
        if (last) {
          await tx`UPDATE task SET updated_at = ${at(last[0], '14:00')} WHERE id = ${row.id}`
        }
      }
      await tx`UPDATE project SET next_number = ${defs.length + 1} WHERE id = ${p.id}`

      // 請假一筆，熱圖上才看得到「人不在、事情還壓著」那種格子
      await tx`
        INSERT INTO leave_record (workspace_id, user_id, leave_type, start_date, end_date,
                                  note, created_by)
        VALUES (${ws.id}, ${user.id}, 'ANNUAL', ${day(4)}, ${day(5)}, '家庭旅遊', ${user.id})`

      // 預設拔掉所有初始連線，讓使用者開關聯圖時可從頭自由拉線
      const links: Array<[number, number, string, number]> = []
      for (const [s, t, type, lag] of links) {
        await tx`INSERT INTO task_link (workspace_id, source_id, target_id, link_type, lag_days, created_by)
                 VALUES (${ws.id}, ${ids.get(s)!}, ${ids.get(t)!}, ${type}, ${lag}, ${user.id})`
      }

      // ── 跨單位發文追蹤：三種狀態各示範一筆 ──
      const askedAt = day(-11)
      const inquiries = [
        {
          task: 4, unit: '採購部', person: '王小明', contact: '分機 2145',
          asked: askedAt, due: day(-6), replied: true,
          byUnit: '採購部', byPerson: '王小明', repliedAt: day(-7),
          note: '報價已核可，可依規格採購', q: '交換器採購規格是否核可？',
        },
        {
          task: 4, unit: '資訊部', person: '李大同', contact: 'lee@example.com',
          asked: askedAt, due: day(-3), replied: false,
          q: '骨幹網段規劃是否確認？',                 // ← 逾期未回
        },
        {
          task: 6, unit: '資訊部', person: '李大同', contact: 'lee@example.com',
          asked: day(-5), due: day(-2), replied: true,
          byUnit: '宏碁資服', byPerson: '陳工程師', repliedAt: day(-1),  // ← 換單位回的
          note: '案子轉給委外廠商，由對方直接回覆規格', q: '機櫃供電規格確認',
        },
        {
          task: 9, unit: '總務處', person: '張經理', contact: '分機 1102',
          asked: day(-1), due: day(4), replied: false, q: '搬遷當日大樓門禁與電梯借用',
        },
      ]

      for (const [i, q] of inquiries.entries()) {
        await tx`
          INSERT INTO task_inquiry
            (workspace_id, task_id, seq, asked_to_unit, asked_to_person, asked_to_contact,
             asked_at, due_date, question, asked_by,
             is_replied, replied_by_unit, replied_by_person, replied_at, reply_note, recorded_by)
          VALUES (${ws.id}, ${ids.get(q.task)!}, ${i + 1}, ${q.unit}, ${q.person}, ${q.contact},
                  ${q.asked}, ${q.due}, ${q.q}, ${user.id},
                  ${q.replied}, ${q.byUnit ?? null}, ${q.byPerson ?? null},
                  ${q.repliedAt ?? null}, ${q.note ?? null}, ${q.replied ? user.id : null})`
      }
      for (const id of new Set(inquiries.map(q => ids.get(q.task)!))) {
        await recalcInquiryState(tx, id)
      }
      void addWorkingDays
    }
  })

  return true
}

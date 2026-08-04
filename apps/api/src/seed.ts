import { sql } from './lib/db.js'
import { hashPassword } from './lib/auth.js'
import { rebuildClosure } from './lib/graph.js'
import { recalcInquiryState, addWorkingDays, toISODate } from './lib/inquiry.js'

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
                ${day(-7)}, ${day(45)}, ${(pi + 1) * 1000}, ${user.id})
        RETURNING id`
      await tx`INSERT INTO project_member (project_id, user_id, role)
               VALUES (${p.id}, ${user.id}, 'MANAGER')`
      for (const s of STATUSES) {
        await tx`INSERT INTO task_status (project_id, key, name, category, color, rank)
                 VALUES (${p.id}, ${s.key}, ${s.name}, ${s.category}, ${s.color}, ${s.rank})`
      }

      if (pi > 0) continue   // 第二個專案留空，方便試「切換專案」

      // ── 建一組有階層、有四種依賴的任務，讓甘特一打開就有東西看 ──
      // 刻意做成三個「大項目」（parent 為 null），側欄才看得出結構。
      const defs = [
        // 大項目一
        { n: 1, title: '前置準備',       type: 'EPIC',      st: 'doing', s: -7, d: 3,  parent: null, prog: 55 },
        { n: 2, title: '需求確認與盤點', type: 'TASK',      st: 'doing', s: -7, d: 3,  parent: 1,    prog: 60 },
        { n: 3, title: '設備清冊建立',   type: 'TASK',      st: 'done',  s: -7, d: -2, parent: 1,    prog: 100 },
        { n: 4, title: '網路架構確認',   type: 'TASK',      st: 'doing', s: -1, d: 3,  parent: 1,    prog: 40 },
        // 大項目二
        { n: 5, title: '採購與施工',     type: 'EPIC',      st: 'todo',  s: 5,  d: 30, parent: null, prog: 0 },
        { n: 6, title: '採購與到貨',     type: 'TASK',      st: 'todo',  s: 5,  d: 20, parent: 5,    prog: 0 },
        { n: 7, title: '機櫃配置施工',   type: 'TASK',      st: 'todo',  s: 21, d: 30, parent: 5,    prog: 0 },
        // 大項目三
        { n: 8, title: '遷移與切換',     type: 'EPIC',      st: 'todo',  s: 21, d: 38, parent: null, prog: 0 },
        { n: 9, title: '系統遷移測試',   type: 'TASK',      st: 'todo',  s: 21, d: 34, parent: 8,    prog: 0 },
        { n: 10, title: '正式切換',      type: 'MILESTONE', st: 'todo',  s: 38, d: 38, parent: 8,    prog: 0 },
      ]

      const ids = new Map<number, string>()
      for (const t of defs) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO task (workspace_id, project_id, number, parent_id, title, type,
                            status_key, start_date, due_date, progress, estimate_hours,
                            rank, created_by)
          VALUES (${ws.id}, ${p.id}, ${t.n}, ${t.parent ? ids.get(t.parent)! : null},
                  ${t.title}, ${t.type}, ${t.st}, ${day(t.s)}, ${day(t.d)}, ${t.prog},
                  ${(t.d - t.s + 1) * 8}, ${t.n * 1000}, ${user.id})
          RETURNING id`
        ids.set(t.n, row.id)
        await rebuildClosure(tx, row.id)
      }
      await tx`UPDATE project SET next_number = ${defs.length + 1} WHERE id = ${p.id}`

      // 四種依賴各示範一條
      const links: Array<[number, number, string, number]> = [
        [2, 6, 'FS', 2],        // 需求確認完成 2 天後才採購（等待任務完成，才能開始）
        [6, 7, 'FS', 0],        // 到貨後施工
        [7, 9, 'SS', 0],        // 施工與測試同時起跑（等待任務開始，才能開始）
        [9, 10, 'FF', 0],       // 測試與切換同時收尾（等待任務完成，才能完成）
        [3, 4, 'RELATES', 0],   // 語意關聯，不影響排程
      ]
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

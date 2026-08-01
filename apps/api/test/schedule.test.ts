import { schedule } from '../src/lib/schedule.js'
let pass = 0, fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     期望 ${w}\n     實得 ${g}`) }
}
const T = (id: string, s: string | null, d: string | null, mode: 'AUTO'|'MANUAL' = 'AUTO') =>
  ({ id, label: id, startDate: s, dueDate: d, scheduleMode: mode })

console.log('── FS：A 完成後 B 才開始，lag=2 ──')
let r = schedule(
  [T('A','2026-08-01','2026-08-05'), T('B','2026-08-01','2026-08-03')],
  [{ sourceId:'A', targetId:'B', linkType:'FS', lagDays:2 }])
eq('B 被推到 A 完成隔天 +2 天 lag', r.tasks.B.start, '2026-08-08')
eq('B 工期保持不變', r.tasks.B.finish, '2026-08-10')

console.log('── SS：同時起跑 ──')
r = schedule([T('A','2026-08-05','2026-08-10'), T('B','2026-08-01','2026-08-04')],
  [{ sourceId:'A', targetId:'B', linkType:'SS', lagDays:0 }])
eq('B 起始對齊 A 起始', r.tasks.B.start, '2026-08-05')

console.log('── FF：同時收尾 ──')
r = schedule([T('A','2026-08-01','2026-08-10'), T('B','2026-08-01','2026-08-04')],
  [{ sourceId:'A', targetId:'B', linkType:'FF', lagDays:0 }])
eq('B 結束對齊 A 結束', r.tasks.B.finish, '2026-08-10')
eq('B 起始往後平移，工期不變', r.tasks.B.start, '2026-08-07')

console.log('── SF：A 開始後 B 才能收尾 ──')
r = schedule([T('A','2026-08-10','2026-08-15'), T('B','2026-08-01','2026-08-03')],
  [{ sourceId:'A', targetId:'B', linkType:'SF', lagDays:0 }])
eq('B 結束不早於 A 開始', r.tasks.B.finish, '2026-08-10')

console.log('── 負 lag（重疊）──')
r = schedule([T('A','2026-08-01','2026-08-10'), T('B','2026-08-01','2026-08-05')],
  [{ sourceId:'A', targetId:'B', linkType:'FS', lagDays:-3 }])
eq('B 提前 3 天開始（與 A 重疊）', r.tasks.B.start, '2026-08-08')

console.log('── MANUAL 是錨點，不被推動，只回報衝突 ──')
r = schedule([T('A','2026-08-01','2026-08-20'), T('B','2026-08-01','2026-08-05','MANUAL')],
  [{ sourceId:'A', targetId:'B', linkType:'FS', lagDays:0 }])
eq('MANUAL 任務日期不變', r.tasks.B.start, '2026-08-01')
eq('回報 1 個衝突', r.conflicts.length, 1)

console.log('── 關鍵路徑：長鏈全在，旁支有浮時 ──')
r = schedule(
  [T('A','2026-08-01','2026-08-05'), T('B','2026-08-06','2026-08-15'),
   T('C','2026-08-16','2026-08-20'), T('D','2026-08-06','2026-08-07')],
  [{ sourceId:'A', targetId:'B', linkType:'FS', lagDays:0 },
   { sourceId:'B', targetId:'C', linkType:'FS', lagDays:0 },
   { sourceId:'A', targetId:'D', linkType:'FS', lagDays:0 }])
eq('關鍵路徑 = A,B,C', r.criticalPath.sort(), ['A','B','C'])
eq('D 有浮時（非 0）', r.tasks.D.totalFloat !== 0, true)

console.log('── 有環時直接回報，不做推算 ──')
r = schedule([T('A','2026-08-01','2026-08-05'), T('B','2026-08-06','2026-08-10')],
  [{ sourceId:'A', targetId:'B', linkType:'FS', lagDays:0 },
   { sourceId:'B', targetId:'A', linkType:'FS', lagDays:0 }])
eq('cyclic = true', r.cyclic, true)

console.log(`\n════════ 排程引擎：通過 ${pass}，失敗 ${fail} ════════`)
process.exit(fail ? 1 : 0)

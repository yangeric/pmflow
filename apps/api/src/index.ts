import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { env } from './lib/env.js'
import { sql, migrate } from './lib/db.js'
import { registerErrorHandler } from './lib/errors.js'
import { sweepOverdue } from './lib/inquiry.js'
import authRoutes from './routes/auth.js'
import projectRoutes from './routes/projects.js'
import taskRoutes from './routes/tasks.js'
import linkRoutes from './routes/links.js'
import inquiryRoutes from './routes/inquiries.js'
import { seedDemo } from './seed.js'

const app = Fastify({
  logger: env.isProd
    ? { level: 'info' }
    : { level: 'info', transport: undefined },
  bodyLimit: 5 * 1024 * 1024,
})

await app.register(cors, {
  origin: env.corsOrigin.split(',').map(s => s.trim()),
  credentials: true,
})
await app.register(cookie)
registerErrorHandler(app)

app.get('/health', async () => {
  await sql`SELECT 1`
  return { status: 'UP', time: new Date().toISOString() }
})

await app.register(async api => {
  await api.register(authRoutes)
  await api.register(projectRoutes)
  await api.register(taskRoutes)
  await api.register(linkRoutes)
  await api.register(inquiryRoutes)
}, { prefix: '/api/v1' })

// ── 啟動：先跑 migration，再視情況塞示範資料 ──
const applied = await migrate()
if (applied.length) app.log.info({ applied }, 'migration 已套用')

if (env.seedDemo) {
  const created = await seedDemo()
  if (created) app.log.info('已建立示範資料：demo@pmflow.local / demo1234')
}

// 每日逾期掃描。用簡單的 setInterval 就好 ——
// 單機自架不需要為了一天跑一次的工作引入排程框架。
const HOUR = 3_600_000
setInterval(async () => {
  try {
    const n = await sweepOverdue(sql)
    if (n > 0) app.log.info({ tasks: n }, '逾期掃描：已更新任務狀態')
  } catch (err) {
    app.log.error({ err }, '逾期掃描失敗')
  }
}, HOUR).unref()

await sweepOverdue(sql).catch(() => {})

await app.listen({ port: env.port, host: env.host })
app.log.info(`PMFlow API 啟動於 http://${env.host}:${env.port}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info('收到 ' + sig + '，正在關閉…')
    await app.close()
    await sql.end({ timeout: 5 })
    process.exit(0)
  })
}

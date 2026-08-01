import type { FastifyReply, FastifyInstance, FastifyError } from 'fastify'
import { ZodError } from 'zod'

/** RFC 9457 Problem Details */
export class HttpProblem extends Error {
  constructor(
    public status: number,
    public type: string,
    public title: string,
    public detail?: string,
    public extra: Record<string, unknown> = {}
  ) {
    super(title)
  }
  send(reply: FastifyReply) {
    reply.code(this.status).type('application/problem+json').send({
      type: `https://pmflow.dev/errors/${this.type}`,
      title: this.title,
      status: this.status,
      detail: this.detail,
      ...this.extra,
    })
  }
}

export const badRequest = (t: string, d?: string, e?: Record<string, unknown>) =>
  new HttpProblem(400, 'bad-request', t, d, e)
export const unauthorized = (t = '請先登入') =>
  new HttpProblem(401, 'unauthorized', t)
export const forbidden = (t = '沒有權限執行這個操作') =>
  new HttpProblem(403, 'forbidden', t)
export const notFound = (t = '找不到資源') =>
  new HttpProblem(404, 'not-found', t)
export const conflict = (t: string, d?: string, e?: Record<string, unknown>) =>
  new HttpProblem(409, 'conflict', t, d, e)

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | HttpProblem, _req, reply) => {
    if (err instanceof HttpProblem) return err.send(reply)

    if (err instanceof ZodError) {
      return reply.code(400).type('application/problem+json').send({
        type: 'https://pmflow.dev/errors/validation',
        title: '輸入內容不符合格式',
        status: 400,
        errors: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    // PostgreSQL 錯誤轉成看得懂的訊息
    const pg = err as unknown as { code?: string; constraint_name?: string; detail?: string }
    if (pg.code === '23505') {
      return reply.code(409).type('application/problem+json').send({
        type: 'https://pmflow.dev/errors/duplicate',
        title: '資料重複',
        status: 409,
        detail: pg.detail,
        constraint: pg.constraint_name,
      })
    }
    if (pg.code === '23514') {
      return reply.code(400).type('application/problem+json').send({
        type: 'https://pmflow.dev/errors/constraint',
        title: '資料不符合限制條件',
        status: 400,
        constraint: pg.constraint_name,
      })
    }

    _req.log.error({ err }, 'unhandled error')
    return reply.code(500).type('application/problem+json').send({
      type: 'https://pmflow.dev/errors/internal',
      title: '伺服器內部錯誤',
      status: 500,
    })
  })
}

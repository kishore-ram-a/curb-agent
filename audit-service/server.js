import { createServer } from 'node:http'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const port = Number(process.env.AUDIT_PORT || 8100)
const host = process.env.AUDIT_HOST || '127.0.0.1'

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) reject(new Error('Payload too large'))
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    request.on('error', reject)
  })
}

function respond(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`)
    if (request.method === 'GET' && url.pathname === '/health') {
      return respond(response, 200, { ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/audit') {
      const event = await readBody(request)
      if (
        typeof event.eventType !== 'string' ||
        !event.eventType ||
        typeof event.payload !== 'object' ||
        event.payload === null
      ) {
        return respond(response, 422, {
          error: 'eventType and object payload are required',
        })
      }
      const saved = await prisma.auditEvent.create({
        data: {
          eventType: event.eventType,
          actor: String(event.user || 'system'),
          payload: event.payload,
        },
      })
      return respond(response, 201, { id: saved.id })
    }
    if (request.method === 'GET' && url.pathname === '/reports/daily') {
      const day =
        url.searchParams.get('date') || new Date().toISOString().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
        return respond(response, 422, { error: 'date must use YYYY-MM-DD' })
      const from = new Date(`${day}T00:00:00.000Z`)
      const until = new Date(from.getTime() + 24 * 60 * 60 * 1000)
      const events = await prisma.auditEvent.findMany({
        where: { createdAt: { gte: from, lt: until } },
        orderBy: { createdAt: 'asc' },
      })
      const byType = Object.groupBy
        ? Object.groupBy(events, (event) => event.eventType)
        : events.reduce((groups, event) => {
            ;(groups[event.eventType] ||= []).push(event)
            return groups
          }, {})
      return respond(response, 200, {
        date: day,
        totals: Object.fromEntries(
          Object.entries(byType).map(([type, rows]) => [type, rows.length]),
        ),
        decisions: (byType.agent_decision || []).map((event) => event.payload),
        rulebookEnforcements: byType.rulebook_enforcement || [],
        smsDrafts: byType.sms_draft || [],
        events,
      })
    }
    return respond(response, 404, { error: 'Not found' })
  } catch (error) {
    return respond(response, 500, { error: error.message })
  }
})

server.listen(port, host, () =>
  console.log(`Audit service listening on http://${host}:${port}`),
)
process.on('SIGINT', async () => {
  await prisma.$disconnect()
  server.close()
})
process.on('SIGTERM', async () => {
  await prisma.$disconnect()
  server.close()
})

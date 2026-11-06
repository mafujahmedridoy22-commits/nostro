/**
 * The HTTP API: a thin layer over a `Store`. It holds no reconciliation
 * logic of its own and imports only nostro's public entry point, so the
 * library and the service cannot drift apart (CONTRIBUTING.md).
 *
 * Lists page in the store's own order: pass a response's `next` back as
 * `after` for the page after it. `next` is `null` on the last page.
 */
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify'
import type { AssetId, Disposition, ExceptionCode, ExceptionDecision, ExceptionStatus, ExpectationStatus, Memo, NewExpectation, Store } from '@nostro-labs/nostro'
import {
  ConstraintError,
  InvalidAssetError,
  Money,
  NATIVE,
  NotFoundError,
  PrecisionError,
  ValidationError,
  allocationJson,
  decideException,
  exceptionJson,
  expectationJson,
  journalCsvRows,
  journalEntryJson,
  movementJson,
  outboxEventJson,
  parseAsset,
  resolutionJson,
} from '@nostro-labs/nostro'
import type { Authenticate } from './auth.js'
import { buildOpenApi } from './openapi.js'
import { HttpProblem } from './problem.js'
import { UINT64, expectationBody, idParams, query, resolveBody } from './schemas.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set from the API key before any `/v1` handler runs. */
    tenantId: string
  }
}

export interface ServerOptions {
  readonly store: Store
  readonly authenticate: Authenticate
  /** Passed to Fastify; `false` (the default) for no request log. */
  readonly logger?: FastifyServerOptions['logger']
}

const UINT64_MAX = (1n << 64n) - 1n

interface Paging {
  after?: number
  limit: number
}

/** A page of rows, and where the next one starts if this one was full. */
function page<T extends { seq: number }, J>(rows: readonly T[], limit: number, json: (row: T) => J) {
  return { data: rows.map(json), next: rows.length === limit ? rows[rows.length - 1]!.seq : null }
}

const after = (q: Paging) => (q.after === undefined ? {} : { afterSeq: q.after })

interface ExpectationBody {
  reference: string
  account: string
  amount: string
  asset?: string
  direction?: 'credit' | 'debit'
  muxedId?: string
  memo?: { type: 'text' | 'id'; value: string }
  payers?: string[]
  dueAt?: string
  expiresAt?: string
  metadata?: Record<string, string>
}

/**
 * The validator coerces types, which querystrings need, but in a body it
 * would turn `"amount": 1e21` into a string after JSON.parse had already
 * rounded it. No body field is a number or a boolean, so any is refused.
 */
function onlyStrings(value: unknown, path: string): void {
  if (typeof value === 'number' || typeof value === 'boolean') {
    throw new HttpProblem(400, 'invalid_request', `body${path} must be a string: amounts and ids are sent as strings.`)
  }
  if (Array.isArray(value)) value.forEach((v, i) => onlyStrings(v, `${path}[${i}]`))
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) onlyStrings(v, `${path}.${k}`)
  }
}

const invalid = (detail: string) => new HttpProblem(422, 'invalid_expectation', detail)

function uint64(field: string, value: string): bigint {
  const n = BigInt(value)
  if (n > UINT64_MAX) throw invalid(`${field} must be below 2^64.`)
  return n
}

function toNewExpectation(tenantId: string, b: ExpectationBody): NewExpectation {
  let asset: AssetId
  try {
    asset = b.asset === undefined || b.asset === 'native' ? NATIVE : parseAsset(b.asset)
  } catch (err) {
    if (err instanceof InvalidAssetError) throw invalid(`asset must be "native" or CODE:ISSUER: ${err.message}`)
    throw err
  }
  let amount: Money
  try {
    amount = Money.parse(b.amount, asset)
  } catch (err) {
    if (err instanceof PrecisionError) throw invalid(`amount: ${err.message}`)
    throw err
  }
  let memo: Memo | null = null
  if (b.memo?.type === 'text') {
    if (Buffer.byteLength(b.memo.value, 'utf8') > 28) throw invalid('memo.value must fit in a text memo: 28 bytes.')
    memo = { type: 'text', value: b.memo.value }
  } else if (b.memo?.type === 'id') {
    if (!new RegExp(UINT64).test(b.memo.value)) throw invalid('memo.value must be a whole number for an id memo.')
    memo = { type: 'id', value: uint64('memo.value', b.memo.value) }
  }
  return {
    tenantId,
    reference: b.reference,
    account: b.account,
    direction: b.direction ?? 'credit',
    amount,
    muxedId: b.muxedId === undefined ? null : uint64('muxedId', b.muxedId),
    memo,
    payers: b.payers ?? [],
    dueAt: b.dueAt === undefined ? null : new Date(b.dueAt),
    expiresAt: b.expiresAt === undefined ? null : new Date(b.expiresAt),
    metadata: b.metadata ?? {},
  }
}

export function createServer(options: ServerOptions): FastifyInstance {
  const { store, authenticate } = options
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
    // Reject what the schemas do not name, rather than silently dropping it.
    ajv: { customOptions: { removeAdditional: false } },
  })
  app.decorateRequest('tenantId', '')

  app.setErrorHandler((err: FastifyError, request, reply) => {
    let problem: HttpProblem
    if (err instanceof HttpProblem) problem = err
    else if (err.validation !== undefined) problem = new HttpProblem(400, 'invalid_request', err.message)
    else if (err instanceof ValidationError) problem = invalid(err.message)
    else if (err instanceof ConstraintError && err.constraint === 'expectation_reference_unique') {
      problem = new HttpProblem(409, 'reference_taken', 'An expectation with this reference already exists.')
    } else if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      problem = new HttpProblem(400, 'invalid_request', err.message)
    } else {
      request.log.error({ err }, 'request failed')
      // Say nothing about the inside of the server to a caller.
      problem = new HttpProblem(500, 'internal', 'The request could not be completed.')
    }
    if (problem.status === 401) void reply.header('www-authenticate', 'Bearer')
    return reply.code(problem.status).type('application/problem+json').send(problem.toJSON())
  })
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .type('application/problem+json')
      .send(new HttpProblem(404, 'not_found', `No route for ${request.method} ${request.url.split('?')[0]}.`).toJSON()),
  )

  app.get('/v1/health', async () => ({ ok: true }))
  const openapi = buildOpenApi()
  app.get('/v1/openapi.json', async () => openapi)

  app.register(
    async (v1) => {
      v1.addHook('onRequest', async (request) => {
        const header = request.headers.authorization
        const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
        const tenantId = token === '' ? null : await authenticate(token)
        if (tenantId === null) throw new HttpProblem(401, 'unauthorized', 'Send Authorization: Bearer <API key>.')
        request.tenantId = tenantId
      })

      v1.get<{ Querystring: Paging & { disposition?: Disposition; account?: string } }>(
        '/movements',
        { schema: { querystring: query.movements } },
        async ({ tenantId, query: q }) =>
          page(
            await store.listMovements({
              tenantId,
              limit: q.limit,
              ...after(q),
              ...(q.disposition === undefined ? {} : { disposition: q.disposition }),
              ...(q.account === undefined ? {} : { account: q.account }),
            }),
            q.limit,
            movementJson,
          ),
      )

      v1.get<{ Params: { id: string } }>('/movements/:id', { schema: { params: idParams } }, async ({ tenantId, params }) => {
        const movement = await store.getMovement(tenantId, params.id)
        if (movement === null) throw new HttpProblem(404, 'not_found', `No movement ${params.id}.`)
        const movementId = movement.id
        return {
          movement: movementJson(movement),
          allocations: (await store.listAllocations({ tenantId, movementId })).map(allocationJson),
          exceptions: (await store.listExceptions({ tenantId, movementId })).map(exceptionJson),
          journal: (await store.listJournalEntries({ tenantId, movementId })).map(journalEntryJson),
        }
      })

      v1.get<{ Querystring: Paging & { status?: string; account?: string } }>(
        '/expectations',
        { schema: { querystring: query.expectations } },
        async ({ tenantId, query: q }) =>
          page(
            await store.listExpectations({
              tenantId,
              limit: q.limit,
              ...after(q),
              ...(q.status === undefined ? {} : { status: q.status.split(',') as ExpectationStatus[] }),
              ...(q.account === undefined ? {} : { account: q.account }),
            }),
            q.limit,
            expectationJson,
          ),
      )

      v1.get<{ Params: { id: string } }>('/expectations/:id', { schema: { params: idParams } }, async ({ tenantId, params }) => {
        const expectation = await store.getExpectation(tenantId, params.id)
        if (expectation === null) throw new HttpProblem(404, 'not_found', `No expectation ${params.id}.`)
        const allocations = await store.listAllocations({ tenantId, expectationId: expectation.id })
        return { expectation: expectationJson(expectation), allocations: allocations.map(allocationJson) }
      })

      v1.post<{ Body: ExpectationBody }>(
        '/expectations',
        { schema: { body: expectationBody }, preValidation: async (request) => onlyStrings(request.body, '') },
        async (request, reply) => {
        const created = await store.transaction((tx) => tx.insertExpectation(toNewExpectation(request.tenantId, request.body)))
        return reply.code(201).header('location', `/v1/expectations/${created.id}`).send(expectationJson(created))
        },
      )

      v1.get<{ Querystring: Paging & { status?: ExceptionStatus; code?: ExceptionCode } }>(
        '/exceptions',
        { schema: { querystring: query.exceptions } },
        async ({ tenantId, query: q }) =>
          page(
            await store.listExceptions({
              tenantId,
              limit: q.limit,
              ...after(q),
              ...(q.status === undefined ? {} : { status: q.status }),
              ...(q.code === undefined ? {} : { code: q.code }),
            }),
            q.limit,
            exceptionJson,
          ),
      )

      v1.get<{ Querystring: Paging }>('/events', { schema: { querystring: query.events } }, async ({ tenantId, query: q }) =>
        page(await store.listEvents({ tenantId, limit: q.limit, ...after(q) }), q.limit, outboxEventJson),
      )

      v1.post<{ Params: { id: string }; Body: ExceptionDecision }>(
        '/exceptions/:id/resolve',
        { schema: { params: idParams, body: resolveBody }, preValidation: async (request) => onlyStrings(request.body, '') },
        async ({ tenantId, params, body }) => {
          try {
            return resolutionJson(await decideException({ store, tenantId, exceptionId: params.id, decision: body }))
          } catch (err) {
            if (err instanceof NotFoundError) {
              if (err.entity === 'exception') throw new HttpProblem(404, 'not_found', `No exception ${params.id}.`)
              throw new HttpProblem(422, 'invalid_resolution', `No ${err.entity} ${err.id}.`)
            }
            if (err instanceof ValidationError || err instanceof PrecisionError) throw new HttpProblem(422, 'invalid_resolution', err.message)
            if (err instanceof ConstraintError) throw new HttpProblem(409, 'resolution_refused', err.message)
            throw err
          }
        },
      )

      const dates = (q: { from?: string; to?: string }) => ({
        ...(q.from === undefined ? {} : { effectiveFrom: new Date(q.from) }),
        ...(q.to === undefined ? {} : { effectiveBefore: new Date(q.to) }),
      })

      v1.get<{ Querystring: Paging & { from?: string; to?: string } }>(
        '/journal',
        { schema: { querystring: query.journal } },
        async ({ tenantId, query: q }) =>
          page(await store.listJournalEntries({ tenantId, limit: q.limit, ...after(q), ...dates(q) }), q.limit, journalEntryJson),
      )

      v1.get<{ Querystring: { from?: string; to?: string } }>(
        '/journal.csv',
        { schema: { querystring: query.journalCsv } },
        async ({ tenantId, query: q }, reply) => {
          const { effectiveFrom, effectiveBefore } = dates(q)
          const rows = journalCsvRows({
            store,
            tenantId,
            ...(effectiveFrom === undefined ? {} : { from: effectiveFrom }),
            ...(effectiveBefore === undefined ? {} : { to: effectiveBefore }),
          })
          return reply
            .type('text/csv; charset=utf-8')
            .header('content-disposition', 'attachment; filename="journal.csv"')
            .send(Readable.from(rows))
        },
      )
    },
    { prefix: '/v1' },
  )

  return app
}

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Store } from 'nostro'
import { HorizonEffectsSource, HorizonFeesSource, JOURNAL_CSV_COLUMNS, MemoryStore, Money, NATIVE, reconcile, sync } from 'nostro'
import { FakeHorizon } from 'nostro-testkit'
import { apiKeys, createServer } from '../src/index.js'

const A = `G${'A'.repeat(55)}`
const B = `G${'B'.repeat(55)}`
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const ACME_KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)
const auth = (key = ACME_KEY) => ({ authorization: `Bearer ${key}` })

/** acme: A is paid 25 XLM for INV-1042 and pays B 5 XLM and a fee; reconciled. */
async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore()
  const h = new FakeHorizon()
  h.payment(10, B, A, '25', { memo: 'INV-1042' })
  h.payment(11, A, B, '5', { memo: 'refund' })
  const client = h.client()
  for (const source of [new HorizonEffectsSource({ client, network: 'testnet' }), new HorizonFeesSource({ client, network: 'testnet' })]) {
    await sync({ store, source, tenantId: 'acme', accounts: [A] })
  }
  await store.transaction((tx) =>
    tx.insertExpectation({ tenantId: 'acme', reference: 'INV-1042', account: A, amount: Money.parse('25', NATIVE) }),
  )
  await reconcile({ store, tenantId: 'acme' })
  return store
}

function server(store: Store) {
  return createServer({ store, authenticate: apiKeys({ [ACME_KEY]: 'acme', [OTHER_KEY]: 'other' }) })
}

describe('authentication', () => {
  it('answers /v1/health to anyone, and everything else only with a key', async () => {
    const app = server(new MemoryStore())
    expect((await app.inject('/v1/health')).json()).toEqual({ ok: true })
    for (const headers of [{}, { authorization: 'Basic eDp5' }, { authorization: 'Bearer ' }, auth('c'.repeat(64))]) {
      const res = await app.inject({ url: '/v1/movements', headers })
      expect(res.statusCode).toBe(401)
      expect(res.headers['www-authenticate']).toBe('Bearer')
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/)
      expect(res.json()).toEqual({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        code: 'unauthorized',
        detail: 'Send Authorization: Bearer <API key>.',
      })
    }
    expect((await app.inject({ url: '/v1/movements', headers: auth() })).statusCode).toBe(200)
  })

  it('refuses short keys, a key without a tenant, and no keys at all', () => {
    expect(() => apiKeys({ short: 'acme' })).toThrow(/at least 32/)
    expect(() => apiKeys({ [ACME_KEY]: ' ' })).toThrow(/needs a tenant/)
    expect(() => apiKeys({})).toThrow(/at least one/)
  })

  it("never shows one tenant another's records", async () => {
    const app = server(await seeded())
    const [m] = (await app.inject({ url: '/v1/movements', headers: auth() })).json().data
    expect((await app.inject({ url: '/v1/movements', headers: auth(OTHER_KEY) })).json()).toEqual({ data: [], next: null })
    expect((await app.inject({ url: `/v1/movements/${m.id}`, headers: auth(OTHER_KEY) })).statusCode).toBe(404)
  })
})

describe('movements', () => {
  it('pages in ingest order, and filters by disposition and account', async () => {
    const app = server(await seeded())
    const get = async (query: string) => (await app.inject({ url: `/v1/movements?${query}`, headers: auth() })).json()
    const all = await get('')
    expect(all.data.map((m: { kind: string; direction: string; amount: string }) => `${m.kind} ${m.direction} ${m.amount}`)).toEqual([
      'transfer credit 25.0000000',
      'transfer debit 5.0000000',
      'fee debit 0.0000100',
    ])
    expect(all.next).toBeNull()
    const first = await get('limit=2')
    expect(first.data).toHaveLength(2)
    expect(first.next).toBe(first.data[1].seq)
    const rest = await get(`limit=2&after=${first.next}`)
    expect(rest.data.map((m: { id: string }) => m.id)).toEqual([all.data[2].id])
    expect(rest.next).toBeNull()
    expect((await get('disposition=ignored')).data.map((m: { kind: string }) => m.kind)).toEqual(['fee'])
    expect((await get(`account=${B}`)).data).toEqual([])
  })

  it('shows one movement with its allocations, exceptions and journal entries', async () => {
    const app = server(await seeded())
    const [credit] = (await app.inject({ url: '/v1/movements', headers: auth() })).json().data
    const res = await app.inject({ url: `/v1/movements/${credit.id}`, headers: auth() })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.movement).toMatchObject({ id: credit.id, disposition: 'allocated', memo: { type: 'text', value: 'INV-1042' } })
    expect(body.allocations).toEqual([expect.objectContaining({ amount: '25.0000000', asset: 'native', strategy: 'memo_text' })])
    expect(body.exceptions).toEqual([])
    expect(body.journal).toHaveLength(1)
    expect(body.journal[0].lines.map((l: { role: string; side: string }) => `${l.role} ${l.side}`)).toEqual([
      'cash debit',
      'receivable credit',
    ])
    expect((await app.inject({ url: '/v1/movements/nope', headers: auth() })).json()).toMatchObject({ status: 404, code: 'not_found' })
  })

  it('answers 400 for a query it does not understand, rather than ignoring it', async () => {
    const app = server(new MemoryStore())
    for (const query of ['limit=0', 'limit=501', 'limit=ten', 'after=-1', 'disposition=lost', 'account=GABC', 'dispositon=pending']) {
      const res = await app.inject({ url: `/v1/movements?${query}`, headers: auth() })
      expect(res.statusCode, query).toBe(400)
      expect(res.json()).toMatchObject({ status: 400, code: 'invalid_request' })
    }
  })
})

describe('expectations', () => {
  const post = (app: ReturnType<typeof server>, payload: unknown) =>
    app.inject({ method: 'POST', url: '/v1/expectations', headers: auth(), payload: payload as object })

  it('records one, says where it is, and refuses the same reference twice', async () => {
    const app = server(new MemoryStore())
    const body = {
      reference: 'INV-7',
      account: A,
      amount: '1200.5',
      asset: `USDC:${ISSUER}`,
      muxedId: '18446744073709551615',
      memo: { type: 'id', value: '7' },
      payers: [B],
      dueAt: '2026-11-01T00:00:00Z',
      expiresAt: '2026-12-01T17:00:00+01:00',
      metadata: { po: '77' },
    }
    const created = await post(app, body)
    expect(created.statusCode).toBe(201)
    const e = created.json()
    expect(created.headers.location).toBe(`/v1/expectations/${e.id}`)
    expect(e).toMatchObject({
      reference: 'INV-7',
      direction: 'credit',
      amount: '1200.5000000',
      asset: `USDC:${ISSUER}`,
      muxedId: '18446744073709551615',
      memo: { type: 'id', value: '7' },
      dueAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-12-01T16:00:00.000Z',
      status: 'open',
      metadata: { po: '77' },
    })
    const again = await post(app, body)
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'reference_taken' })
    const one = await app.inject({ url: `/v1/expectations/${e.id}`, headers: auth() })
    expect(one.json()).toEqual({ expectation: e, allocations: [] })
    expect((await app.inject({ url: '/v1/expectations/nope', headers: auth() })).statusCode).toBe(404)
  })

  it('lists them with what has been paid, by status and account, a page at a time', async () => {
    const app = server(await seeded())
    await post(app, { reference: 'INV-1043', account: A, amount: '10' })
    await post(app, { reference: 'PAY-1', account: B, amount: '3', direction: 'debit' })
    const get = async (query: string) => (await app.inject({ url: `/v1/expectations?${query}`, headers: auth() })).json()
    expect((await get('')).data.map((e: { reference: string; status: string }) => `${e.reference} ${e.status}`)).toEqual([
      'INV-1042 settled',
      'INV-1043 open',
      'PAY-1 open',
    ])
    expect((await get('status=open,partially_paid')).data.map((e: { reference: string }) => e.reference)).toEqual(['INV-1043', 'PAY-1'])
    expect((await get(`account=${B}`)).data.map((e: { direction: string }) => e.direction)).toEqual(['debit'])
    const first = await get('limit=1')
    expect((await get(`limit=2&after=${first.next}`)).data.map((e: { reference: string }) => e.reference)).toEqual(['INV-1043', 'PAY-1'])
    const [settled] = (await get('status=settled')).data
    const detail = (await app.inject({ url: `/v1/expectations/${settled.id}`, headers: auth() })).json()
    expect(detail.allocations).toEqual([expect.objectContaining({ amount: '25.0000000' })])
    expect((await app.inject({ url: '/v1/expectations?status=paid', headers: auth() })).statusCode).toBe(400)
  })

  it('answers 400 for a malformed body and 422 for one it cannot record exactly', async () => {
    const app = server(new MemoryStore())
    const ok = { reference: 'R', account: A, amount: '1' }
    for (const body of [
      {},
      { ...ok, amount: 1 },
      { ...ok, amount: 123456789012345678901234567890 },
      { ...ok, payers: [1] },
      { ...ok, metadata: { paid: true } },
      { ...ok, amount: '-1' },
      { ...ok, amount: '1e3' },
      { ...ok, account: 'M123' },
      { ...ok, colour: 'red' },
      { ...ok, direction: 'sideways' },
      { ...ok, memo: { type: 'hash', value: 'aa' } },
      { ...ok, dueAt: 'tomorrow' },
      { ...ok, muxedId: '-5' },
      { ...ok, reference: '' },
    ]) {
      const res = await post(app, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(res.json()).toMatchObject({ code: 'invalid_request' })
    }
    expect((await post(app, { ...ok, amount: 1 })).json().detail).toBe('body.amount must be a string: amounts and ids are sent as strings.')
    for (const [body, detail] of [
      [{ ...ok, amount: '1.00000001' }, 'refusing to round'],
      [{ ...ok, amount: '0' }, 'amount: must be positive'],
      [{ ...ok, asset: 'USDC' }, 'asset must be "native" or CODE:ISSUER'],
      [{ ...ok, memo: { type: 'text', value: 'x'.repeat(29) } }, '28 bytes'],
      [{ ...ok, memo: { type: 'id', value: 'seven' } }, 'whole number'],
      [{ ...ok, memo: { type: 'id', value: '18446744073709551616' } }, 'memo.value must be below 2^64'],
      [{ ...ok, muxedId: '18446744073709551616' }, 'muxedId must be below 2^64'],
    ] as const) {
      const res = await post(app, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(422)
      expect(res.json()).toMatchObject({ code: 'invalid_expectation' })
      expect(res.json().detail).toContain(detail)
    }
    expect((await app.inject({ url: '/v1/expectations', headers: auth() })).json().data).toEqual([])
    const big = await post(app, { ...ok, metadata: { note: 'x'.repeat(70 * 1024) } })
    expect(big.statusCode).toBe(400)
  })
})

describe('exceptions and the journal', () => {
  it('lists exceptions by status and code', async () => {
    const app = server(await seeded())
    const get = async (query: string) => (await app.inject({ url: `/v1/exceptions?${query}`, headers: auth() })).json()
    expect((await get('status=open')).data.map((x: { code: string; amount: string }) => `${x.code} ${x.amount}`)).toEqual([
      'UNEXPECTED_DEBIT 5.0000000',
    ])
    expect((await get('code=WRONG_ASSET')).data).toEqual([])
    expect((await get('status=resolved')).data).toEqual([])
    expect((await app.inject({ url: '/v1/exceptions?code=nope', headers: auth() })).statusCode).toBe(400)
  })

  it('pages the journal, by effective date, and downloads it as CSV', async () => {
    const app = server(await seeded())
    const get = async (query: string) => (await app.inject({ url: `/v1/journal?${query}`, headers: auth() })).json()
    const all = await get('')
    expect(all.data.map((j: { kind: string }) => j.kind)).toEqual(['initial', 'initial', 'initial'])
    expect((await get('limit=2')).next).toBe(all.data[1].seq)
    expect((await get('from=2026-10-07T00:00:00Z')).data).toEqual([])
    expect((await get('to=2026-10-07T00:00:00Z')).data).toHaveLength(3)

    const csv = await app.inject({ url: '/v1/journal.csv', headers: auth() })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(csv.headers['content-disposition']).toBe('attachment; filename="journal.csv"')
    const rows = csv.body.split('\r\n')
    expect(rows[0]).toBe(JOURNAL_CSV_COLUMNS.join(','))
    expect(rows).toHaveLength(1 + 6 + 1)
    const none = await app.inject({ url: '/v1/journal.csv?from=2026-10-07T00:00:00Z', headers: auth() })
    expect(none.body).toBe(`${JOURNAL_CSV_COLUMNS.join(',')}\r\n`)
    expect((await app.inject({ url: '/v1/journal.csv?from=yesterday', headers: auth() })).statusCode).toBe(400)
  })
})

describe('events', () => {
  it('pages the event log, the same events webhooks deliver', async () => {
    const app = server(await seeded())
    const get = async (query: string) => (await app.inject({ url: `/v1/events?${query}`, headers: auth() })).json()
    const all = await get('')
    expect(all.data.map((e: { type: string }) => e.type)).toEqual([
      'expectation.settled',
      'movement.decided',
      'exception.opened',
      'movement.decided',
      'movement.decided',
    ])
    expect(all.data[0].data.expectation).toMatchObject({ reference: 'INV-1042', status: 'settled', amount: '25.0000000' })
    const first = await get('limit=2')
    expect((await get(`after=${first.next}`)).data).toHaveLength(3)
    expect((await app.inject({ url: '/v1/events', headers: auth(OTHER_KEY) })).json()).toEqual({ data: [], next: null })
    expect((await app.inject({ url: '/v1/events?type=x', headers: auth() })).statusCode).toBe(400)
  })
})

describe('errors', () => {
  it('answers an unknown route with a problem, not an HTML page', async () => {
    const res = await server(new MemoryStore()).inject('/v2/nothing')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ status: 404, code: 'not_found', detail: 'No route for GET /v2/nothing.' })
  })

  it('says nothing about the inside of the server when the store fails', async () => {
    const store = new MemoryStore()
    store.listMovements = async () => {
      throw new Error('connection to db.internal:5432 refused')
    }
    const res = await server(store).inject({ url: '/v1/movements', headers: auth() })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'internal',
      detail: 'The request could not be completed.',
    })
    expect(res.body).not.toContain('db.internal')
  })

  it('refuses a NUL before it can reach the database, in a path or in a body', async () => {
    const app = server(new MemoryStore())
    for (const url of ['/v1/movements/a%00b', '/v1/expectations/%00']) {
      const res = await app.inject({ url, headers: auth() })
      expect(res.statusCode, url).toBe(400)
      expect(res.json()).toMatchObject({ code: 'invalid_request' })
    }
    const post = (payload: object) => app.inject({ method: 'POST', url: '/v1/expectations', headers: auth(), payload })
    const ok = { reference: 'R', account: A, amount: '1' }
    expect((await post({ ...ok, reference: 'a\u0000b' })).json()).toMatchObject({ status: 422, code: 'invalid_expectation' })
    expect((await post({ ...ok, metadata: { note: 'a\u0000b' } })).json()).toMatchObject({ status: 422, code: 'invalid_expectation' })
    expect((await post({ ...ok, reference: 'a\ud800b' })).json()).toMatchObject({ status: 422, code: 'invalid_expectation' })
  })

  it('answers a body that is not JSON with a problem', async () => {
    const res = await server(new MemoryStore()).inject({
      method: 'POST',
      url: '/v1/expectations',
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: '{"reference":',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid_request' })
  })
})

describe('layering', () => {
  it("imports only nostro's public entry point, never its internals", () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url))
    const imports = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/from '([^']+)'/g)].map((m): [string, string] => [f, m[1]!]))
    const outside = imports.filter(([, spec]) => !spec.startsWith('./') && !spec.startsWith('node:') && spec !== 'fastify')
    expect(outside.length).toBeGreaterThan(0)
    expect(outside.filter(([, spec]) => spec !== 'nostro')).toEqual([])
  })
})

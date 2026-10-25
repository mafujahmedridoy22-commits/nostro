/**
 * The OpenAPI document is a contract: it must be valid, describe exactly the
 * routes the server has, and match what the server actually sends.
 */
import SwaggerParser from '@apidevtools/swagger-parser'
import { Ajv2020 } from 'ajv/dist/2020.js'
import formats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import { HorizonEffectsSource, HorizonFeesSource, MemoryStore, Money, NATIVE, reconcile, sync } from 'nostro'
import { FakeHorizon } from 'nostro-testkit'
import { apiKeys, buildOpenApi, createServer } from '../src/index.js'

const A = `G${'A'.repeat(55)}`
const B = `G${'B'.repeat(55)}`
const KEY = 'a'.repeat(64)
// ajv-formats is CommonJS: under NodeNext its default export arrives wrapped.
const addFormats = (formats as unknown as { default: typeof formats.default }).default
const headers = { authorization: `Bearer ${KEY}` }

async function app() {
  const store = new MemoryStore()
  const h = new FakeHorizon()
  h.payment(10, B, A, '25', { memo: 'INV-1042' })
  h.payment(11, A, B, '5', { memo: 'refund' })
  const client = h.client()
  for (const source of [new HorizonEffectsSource({ client, network: 'testnet' }), new HorizonFeesSource({ client, network: 'testnet' })]) {
    await sync({ store, source, tenantId: 'acme', accounts: [A] })
  }
  await store.transaction((tx) =>
    tx.insertExpectation({ tenantId: 'acme', reference: 'INV-1042', account: A, amount: Money.parse('25', NATIVE), muxedId: 7n, memo: { type: 'id', value: 7n } }),
  )
  await reconcile({ store, tenantId: 'acme' })
  const server = createServer({ store, authenticate: apiKeys({ [KEY]: 'acme' }) })
  await server.ready()
  return server
}

/** `method path` for every route Fastify has, from its route tree, without HEAD. */
function routesOf(tree: string): string[] {
  const out: string[] = []
  const stack: string[] = []
  for (const line of tree.split('\n')) {
    const m = /^([│ ]*)[├└]── (\S+) \(([^)]+)\)/.exec(line)
    if (m === null) continue
    const depth = m[1]!.length / 4
    stack.length = depth
    const path = (stack[depth - 1] ?? '') + m[2]!
    stack.push(path)
    for (const method of m[3]!.split(', ')) if (method !== 'HEAD') out.push(`${method} ${path.replace(/:(\w+)/g, '{$1}')}`)
  }
  return out.sort()
}

describe('the OpenAPI document', () => {
  it("carries this package's version", async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(buildOpenApi().info.version).toBe(pkg.version)
    expect(pkg.version).toBe('0.1.0')
  })

  it('is valid OpenAPI 3.1', async () => {
    await expect(SwaggerParser.validate(structuredClone(buildOpenApi()) as never)).resolves.toBeDefined()
  })

  it('describes exactly the routes the server has', async () => {
    const server = await app()
    const doc = buildOpenApi()
    const documented = Object.entries(doc.paths)
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
      .sort()
    expect(routesOf(server.printRoutes({ commonPrefix: false }))).toEqual(documented)
  })

  it('is what the server serves at /v1/openapi.json, without a key', async () => {
    const res = await (await app()).inject('/v1/openapi.json')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(buildOpenApi())))
  })

  it('matches what the server actually sends', async () => {
    const server = await app()
    const doc = buildOpenApi()
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    addFormats(ajv)
    ajv.addSchema({ $id: 'nostro', components: doc.components })
    const conforms = (status: number, body: unknown, method: string, path: string) => {
      const op = (doc.paths as Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: object }> }> }>>)[path]![method]!
      const response = op.responses[String(status)]
      expect(response, `${method} ${path} documents ${status}`).toBeDefined()
      const [, media] = Object.entries(response!.content!)[0]!
      const schema = JSON.parse(JSON.stringify(media.schema).replaceAll('"#/components', '"nostro#/components'))
      const validate = ajv.compile(schema)
      expect(validate(body), `${method} ${path} ${status}: ${ajv.errorsText(validate.errors)}`).toBe(true)
      ajv.removeSchema(schema)
    }
    const call = async (method: 'GET' | 'POST', url: string, path: string, payload?: object, auth = true) => {
      const res = await server.inject({ method, url, ...(auth ? { headers } : {}), ...(payload === undefined ? {} : { payload }) })
      conforms(res.statusCode, res.json(), method.toLowerCase(), path)
      return res
    }

    await call('GET', '/v1/health', '/v1/health')
    const movements = (await call('GET', '/v1/movements', '/v1/movements')).json()
    expect(movements.data.length).toBeGreaterThan(0)
    for (const m of movements.data) await call('GET', `/v1/movements/${m.id}`, '/v1/movements/{id}')
    const expectations = (await call('GET', '/v1/expectations', '/v1/expectations')).json()
    await call('GET', `/v1/expectations/${expectations.data[0].id}`, '/v1/expectations/{id}')
    await call('GET', '/v1/exceptions?status=open', '/v1/exceptions')
    expect((await call('GET', '/v1/events', '/v1/events')).json().data.length).toBeGreaterThan(0)
    await call('GET', '/v1/journal?limit=1', '/v1/journal')
    const created = await call('POST', '/v1/expectations', '/v1/expectations', {
      reference: 'INV-9', account: A, amount: '3', payers: [B], dueAt: '2026-11-01T00:00:00Z', metadata: { po: '1' },
    })
    expect(created.statusCode).toBe(201)

    // And every documented error, in the shape documented.
    expect((await call('GET', '/v1/movements', '/v1/movements', undefined, false)).statusCode).toBe(401)
    expect((await call('GET', '/v1/movements?limit=0', '/v1/movements')).statusCode).toBe(400)
    expect((await call('GET', '/v1/movements/nope', '/v1/movements/{id}')).statusCode).toBe(404)
    expect((await call('POST', '/v1/expectations', '/v1/expectations', { reference: 'INV-9', account: A, amount: '3' })).statusCode).toBe(409)
    expect((await call('POST', '/v1/expectations', '/v1/expectations', { reference: 'R', account: A, amount: '0' })).statusCode).toBe(422)
  })
})

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyWebhook } from '@nostro-labs/nostro'
import { FakeHorizon } from 'nostro-testkit'
import { main } from '../src/index.js'
import { A, B, migrated, nostro } from './helpers.js'

type Page = { data: { reference: string }[] }

const KEY = 'k'.repeat(64)
const env = { NOSTRO_API_KEYS: `acme:${KEY}` }

/** Start `nostro serve` in-process; returns its output so far, its address, and a way to stop it. */
async function start(cwd: string, argv: readonly string[], options: { env?: Record<string, string>; fetch?: typeof fetch } = {}) {
  const out = { stdout: '', stderr: '' }
  const stop = new AbortController()
  const done = main(['serve', '--port', '0', ...argv], {
    stdout: { write: (s) => ((out.stdout += s), true) },
    stderr: { write: (s) => ((out.stderr += s), true) },
    env: options.env ?? env,
    cwd,
    signal: stop.signal,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25))
    if (!check()) throw new Error(`timed out; stdout: ${out.stdout} stderr: ${out.stderr}`)
  }
  await until(() => out.stdout.includes('Listening on'))
  const address = /Listening on (\S+) /.exec(out.stdout)![1]!
  const get = async (path: string, key = KEY) => fetch(`${address}${path}`, { headers: { authorization: `Bearer ${key}` } })
  return { out, address, get, until, stop: async () => (stop.abort(), done) }
}

describe('nostro serve', () => {
  it('serves the API, and syncs and reconciles the watched accounts every interval', async () => {
    const cwd = await migrated()
    const h = new FakeHorizon()
    h.payment(10, B, A, '25', { memo: 'INV-1042' })
    await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25', '--tenant', 'acme'])
    await nostro(cwd, ['expect', 'INV-1043', '--account', A, '--amount', '10', '--tenant', 'acme'])
    const server = await start(cwd, ['--account', A, '--tenant', 'acme', '--interval', '1'], { fetch: h.fetch })
    expect(server.out.stdout).toContain(`Syncing and reconciling 1 account(s) on testnet for tenant acme every 1s.\n`)

    expect(await (await fetch(`${server.address}/v1/health`)).json()).toEqual({ ok: true })
    expect((await server.get('/v1/movements', 'x'.repeat(64))).status).toBe(401)
    await server.until(() => server.out.stdout.includes('synced 1 new movement(s), decided 1.'))
    const settled = (await (await server.get('/v1/expectations?status=settled')).json()) as Page
    expect(settled.data.map((e) => e.reference)).toEqual(['INV-1042'])

    // A payment arriving later is picked up by a later round.
    h.payment(12, B, A, '10', { memo: 'INV-1043' })
    await server.until(() => server.out.stdout.split('synced 1 new movement(s), decided 1.').length === 3)
    const all = (await (await server.get('/v1/expectations?status=settled')).json()) as Page
    expect(all.data.map((e) => e.reference)).toEqual(['INV-1042', 'INV-1043'])

    expect(await server.stop()).toBe(0)
    expect(server.out.stdout).toMatch(/Stopped\.\n$/)
    await expect(fetch(`${server.address}/v1/health`)).rejects.toThrow()
  })

  it('delivers each decision to the webhook, signed, and retries one that failed', async () => {
    const cwd = await migrated()
    const h = new FakeHorizon()
    h.payment(10, B, A, '25', { memo: 'INV-1042' })
    await nostro(cwd, ['expect', 'INV-1042', '--account', A, '--amount', '25', '--tenant', 'acme'])
    const secret = 'w'.repeat(64)
    const received: { headers: Record<string, string>; body: string }[] = []
    let refuse = 1
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith('https://hooks.example/')) return h.fetch(url, init)
      if (refuse-- > 0) return new Response('busy', { status: 503 })
      received.push({ headers: init!.headers as Record<string, string>, body: init!.body as string })
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const server = await start(cwd, ['--account', A, '--tenant', 'acme', '--interval', '1', '--webhook-url', 'https://hooks.example/n'], {
      env: { ...env, NOSTRO_WEBHOOK_SECRET: secret },
      fetch,
    })
    expect(server.out.stdout).toContain("Delivering tenant acme's events to https://hooks.example/n.\n")
    // One payment to A (B paid the fee): the invoice settles and the movement is decided.
    await server.until(() => server.out.stdout.includes('delivered 2 event(s).'))
    expect(server.out.stderr).toMatch(/Webhook failed on event \S+: HTTP 503; retrying next round\.\n/)
    expect(received.map((r) => JSON.parse(r.body).type)).toEqual(['expectation.settled', 'movement.decided'])
    expect(received.every((r) => verifyWebhook({ secret, header: r.headers['nostro-signature'], body: r.body }))).toBe(true)
    expect(await server.stop()).toBe(0)
  })

  it('serves the API alone when no account is watched, with keys from a file', async () => {
    const cwd = await migrated()
    writeFileSync(join(cwd, 'keys'), `# tenants\n\nacme:${KEY}\nother:${'o'.repeat(40)}\n`)
    const server = await start(cwd, ['--keys-file', 'keys'], { env: {} })
    expect(server.out.stdout).toContain('No accounts to watch and no webhook: serving the API only.\n')
    expect((await server.get('/v1/movements')).status).toBe(200)
    expect((await server.get('/v1/movements', 'o'.repeat(40))).status).toBe(200)
    expect(await server.stop()).toBe(0)
  })

  it('reports a failing round and keeps going', async () => {
    const cwd = await migrated()
    const fetchFails = (async () =>
      new Response(JSON.stringify({ type: 'https://stellar.org/horizon-errors/bad_request', status: 400, title: 'Bad Request' }), {
        status: 400,
      })) as typeof fetch
    const server = await start(cwd, ['--account', A, '--interval', '1'], { fetch: fetchFails })
    await server.until(() => server.out.stderr.split(`horizon ${A}:`).length >= 3)
    expect((await server.get('/v1/health')).status).toBe(200)
    expect(await server.stop()).toBe(0)
  })

  it('says which address it is bound to', async () => {
    const cwd = await migrated()
    const server = await start(cwd, ['--host', '0.0.0.0'])
    expect(server.address).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/)
    expect((await fetch(server.address.replace('0.0.0.0', '127.0.0.1') + '/v1/health')).status).toBe(200)
    expect(await server.stop()).toBe(0)
  })

  it('refuses to start without usable keys, a usable port, or an up-to-date database', async () => {
    const cwd = await migrated()
    const run = (argv: string[], e: Record<string, string> = env) => nostro(cwd, ['serve', ...argv], { env: e })
    expect(await run([], {})).toMatchObject({ code: 2 })
    expect((await run([], {})).stderr).toContain('serve needs API keys')
    expect((await run([], { NOSTRO_API_KEYS: KEY })).stderr).toContain('Each API key is tenant:key.')
    expect(await run([], { NOSTRO_API_KEYS: 'acme:short' })).toMatchObject({ code: 1, stderr: 'nostro: API keys must be at least 32 characters.\n' })
    expect((await run(['--keys-file', 'missing'])).stderr).toContain('Cannot read --keys-file')
    expect((await run(['--port', '70000'])).code).toBe(2)
    expect((await run([], { ...env, NOSTRO_PORT: 'http' })).code).toBe(2)
    expect((await run(['--interval', '0'])).code).toBe(2)
    expect((await run(['--webhook-url', 'https://hooks.example/n'])).stderr).toContain('A webhook needs NOSTRO_WEBHOOK_SECRET')
    expect((await run(['--webhook-url', 'https://hooks.example/n'], { ...env, NOSTRO_WEBHOOK_SECRET: 'short' })).code).toBe(2)
    expect((await run(['--webhook-url', 'hooks'])).stderr).toContain('--webhook-url must be a URL')
    expect((await run(['--webhook-url', 'ftp://hooks.example'])).stderr).toContain('must be an http(s) URL')
    expect((await nostro(await migrated(), ['serve', '--db', 'missing.db'], { env })).stderr).toContain('No database at')
  })
})

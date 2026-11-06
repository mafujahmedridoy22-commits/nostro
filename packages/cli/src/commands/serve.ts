import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Store } from '@nostro-labs/nostro'
import { MIN_WEBHOOK_SECRET_LENGTH, deliverWebhooks } from '@nostro-labs/nostro'
import { apiKeys, createServer } from '@nostro-labs/server'
import type { Args } from '../args.js'
import { CliError, NETWORK, UsageError, accounts, database, integer, network, positionals, string, strings, tenant } from '../args.js'
import type { Command } from '../command.js'
import { NETWORK_HELP, horizonClient, movementSources } from '../command.js'
import type { Io } from '../io.js'
import { clean, write } from '../io.js'
import { assertCurrent, openStore, redact } from '../store.js'
import { reconcileAll, syncAll } from '../work.js'

/**
 * API keys as `tenant:key` pairs: comma-separated in NOSTRO_API_KEYS, or one
 * per line in --keys-file (blank lines and `#` comments skipped). Never on
 * the command line, where `ps` would show them.
 */
function keys(args: Args, io: Io): Record<string, string> {
  const file = string(args, 'keys-file')
  let entries: string[]
  if (file !== undefined) {
    let text: string
    try {
      text = readFileSync(resolve(io.cwd, file), 'utf8')
    } catch (err) {
      throw new CliError(`Cannot read --keys-file: ${(err as Error).message}`)
    }
    entries = text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
  } else {
    entries = (io.env.NOSTRO_API_KEYS ?? '').split(',').map((e) => e.trim()).filter((e) => e !== '')
  }
  if (entries.length === 0) {
    throw new UsageError('serve needs API keys: set NOSTRO_API_KEYS=tenant:key[,tenant:key...] or pass --keys-file.')
  }
  const out: Record<string, string> = {}
  for (const entry of entries) {
    const at = entry.indexOf(':')
    if (at < 1) throw new UsageError('Each API key is tenant:key.')
    out[entry.slice(at + 1)] = entry.slice(0, at)
  }
  return out
}

export const serve: Command = {
  name: 'serve',
  summary: 'Run the HTTP API; keep accounts synced and reconciled, and deliver webhooks',
  usage: '[--account <G...>] [options]',
  help: `Serves the HTTP API (see packages/server) over the database. With accounts to watch, it also
syncs and reconciles them for --tenant every --interval seconds, as "nostro sync" and "nostro
reconcile" would. With --webhook-url it delivers that tenant's events there after each round,
signed with NOSTRO_WEBHOOK_SECRET (docs/webhooks.md). Stops cleanly on Ctrl-C or SIGTERM, finishing
the round it is in.

API keys decide the tenant each request may read. They come from NOSTRO_API_KEYS
(tenant:key,tenant:key) or --keys-file (one tenant:key per line), never the command line. Each key
must be at least 32 characters: openssl rand -hex 32.

Options:
  --port <n>          Port to listen on (env NOSTRO_PORT; default 8080; 0 picks a free one)
  --host <address>    Address to listen on (env NOSTRO_HOST; default 127.0.0.1; 0.0.0.0 in a container)
  --keys-file <file>  API keys, one tenant:key per line
  --interval <s>      Seconds between rounds (default 30)
  --webhook-url <url> Deliver events here (env NOSTRO_WEBHOOK_URL); the secret comes only from
                      NOSTRO_WEBHOOK_SECRET
${NETWORK_HELP}
  --db <path|url>     SQLite file, or a postgres:// URL (env NOSTRO_DB; default ./nostro.db)
  --tenant <id>       The tenant the watched accounts belong to (env NOSTRO_TENANT; default "default")
  -h, --help          Show this help`,
  options: {
    db: { type: 'string' },
    tenant: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    ...NETWORK,
    port: { type: 'string' },
    host: { type: 'string' },
    'keys-file': { type: 'string' },
    interval: { type: 'string' },
    'webhook-url': { type: 'string' },
  },
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const authenticate = (() => {
      try {
        return apiKeys(keys(args, io))
      } catch (err) {
        if (err instanceof UsageError) throw err
        throw new CliError((err as Error).message)
      }
    })()
    const rawPort = string(args, 'port') ?? io.env.NOSTRO_PORT
    if (rawPort !== undefined && (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65_535)) {
      throw new UsageError('--port must be a whole number from 0 to 65535.')
    }
    const port = rawPort === undefined ? 8080 : Number(rawPort)
    const host = string(args, 'host') ?? io.env.NOSTRO_HOST ?? '127.0.0.1'
    const interval = integer(args, 'interval', 30, 1, 86_400)
    const watched =
      strings(args, 'account').length > 0 || (io.env.NOSTRO_ACCOUNTS ?? '').trim() !== '' ? accounts(args, io) : []
    const net = watched.length > 0 ? network(args, io) : null
    const hook = webhook(args, io)

    const opened = await openStore(database(args, io), io, { create: false })
    const { store } = opened
    try {
      await assertCurrent(opened)
      const app = createServer({ store, authenticate })
      await app.listen({ port, host })
      // Fastify reports one loopback address even when bound to every interface; say what was asked for.
      const bound = (app.server.address() as AddressInfo).port
      const address = `http://${host.includes(':') ? `[${host}]` : host}:${bound}`
      await write(io.stdout, `Listening on ${address} (database ${opened.label}).\n`)

      if (net === null && hook === null) {
        await write(io.stdout, 'No accounts to watch and no webhook: serving the API only.\n')
        await stopped(io.signal)
      } else {
        if (net !== null) {
          await write(
            io.stdout,
            `Syncing and reconciling ${watched.length} account(s) on ${net.name} for tenant ${clean(tenantId)} every ${interval}s.\n`,
          )
        }
        if (hook !== null) await write(io.stdout, `Delivering tenant ${clean(tenantId)}'s events to ${redact(hook.url)}.\n`)
        const sources = net === null ? [] : movementSources(horizonClient(net, io), net)
        while (io.signal?.aborted !== true) {
          try {
            if (net !== null) {
              const streams = await syncAll({ store, tenantId, accounts: watched, sources })
              const totals = await reconcileAll(store, tenantId, 100)
              const inserted = streams.reduce((n, s) => n + s.inserted, 0)
              if (inserted > 0 || totals.decided > 0) {
                await write(io.stdout, `${new Date().toISOString()} synced ${inserted} new movement(s), decided ${totals.decided}.\n`)
              }
              for (const s of streams) {
                if (s.error !== null) await write(io.stderr, `${s.source} ${s.account}: ${clean(s.error.message)}\n`)
              }
              for (const [id, error] of totals.errors) await write(io.stderr, `Failed on movement ${id}: ${clean(error)}\n`)
            }
            if (hook !== null) await deliver(store, tenantId, hook, io)
          } catch (err) {
            await write(io.stderr, `Round failed: ${clean((err as Error).message)}\n`)
          }
          await sleep(interval * 1000, undefined, io.signal === undefined ? {} : { signal: io.signal }).catch(() => undefined)
        }
      }
      await app.close()
      await write(io.stdout, 'Stopped.\n')
      return 0
    } finally {
      await store.close()
    }
  },
}

interface Webhook {
  readonly url: string
  readonly secret: string
}

/** The webhook destination, if one is configured; its secret only ever comes from the environment. */
function webhook(args: Args, io: Io): Webhook | null {
  const url = string(args, 'webhook-url') ?? io.env.NOSTRO_WEBHOOK_URL
  if (url === undefined) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UsageError(`--webhook-url must be a URL, not ${JSON.stringify(url)}.`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new UsageError('--webhook-url must be an http(s) URL.')
  const secret = io.env.NOSTRO_WEBHOOK_SECRET
  if (secret === undefined || secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new UsageError(`A webhook needs NOSTRO_WEBHOOK_SECRET, at least ${MIN_WEBHOOK_SECRET_LENGTH} characters: openssl rand -hex 32.`)
  }
  return { url, secret }
}

/** Deliver until caught up or a delivery fails; a failed event is retried next round. */
async function deliver(store: Store, tenantId: string, hook: Webhook, io: Io): Promise<void> {
  let total = 0
  for (;;) {
    const report = await deliverWebhooks({
      store,
      tenantId,
      url: hook.url,
      secret: hook.secret,
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    })
    total += report.delivered
    if (report.failure !== null) {
      await write(io.stderr, `Webhook failed on event ${report.failure.eventId}: ${clean(report.failure.reason)}; retrying next round.\n`)
    }
    if (report.delivered === 0 || report.failure !== null || report.contended) break
  }
  if (total > 0) await write(io.stdout, `${new Date().toISOString()} delivered ${total} event(s).\n`)
}

/** Resolves when the signal fires; never, without one. */
function stopped(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done) => {
    if (signal === undefined) return
    if (signal.aborted) done()
    else signal.addEventListener('abort', () => done(), { once: true })
  })
}

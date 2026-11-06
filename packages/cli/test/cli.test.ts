import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { Money, NATIVE } from '@nostro-labs/nostro'
import { SqliteStore } from '@nostro-labs/store-sqlite'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro, workspace } from './helpers.js'

const setVersion = (file: string, version: number) => {
  const db = new Database(file)
  db.pragma(`user_version = ${version}`)
  db.close()
}

/** A is paid 25 XLM for INV-1042, then pays B 5 XLM and the fee. */
function paid(): FakeHorizon {
  const h = new FakeHorizon()
  h.payment(10, B, A, '25', { memo: 'INV-1042' })
  h.payment(11, A, B, '5', { memo: 'refund' })
  return h
}

async function expect1042(cwd: string, tenantId = 'default', amount = '25'): Promise<void> {
  const store = new SqliteStore({ filename: join(cwd, 'nostro.db') })
  await store.transaction((tx) =>
    tx.insertExpectation({ tenantId, reference: 'INV-1042', account: A, amount: Money.parse(amount, NATIVE) }),
  )
  await store.close()
}

describe('nostro', () => {
  it('prints an overview: on stdout when asked, on stderr with status 2 when no command is given', async () => {
    const cwd = workspace()
    const asked = await nostro(cwd, ['--help'])
    expect(asked.code).toBe(0)
    expect(asked.stdout).toMatch(/Commands:\n {2}migrate +Create the database/)
    expect(asked.stdout).toContain('never signs a transaction')
    expect((await nostro(cwd, ['help'])).stdout).toBe(asked.stdout)
    const bare = await nostro(cwd, [])
    expect(bare).toMatchObject({ code: 2, stdout: '', stderr: asked.stdout })
  })

  it("prints a command's help", async () => {
    const cwd = workspace()
    const help = await nostro(cwd, ['sync', '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toMatch(/^Usage: nostro sync --account <G\.\.\.> \[options\]\n/)
    expect(help.stdout).toContain('--once')
  })

  it('gives and refuses --memo-hash on expect', async () => {
    const cwd = await migrated()
    const hash = 'a'.repeat(64)
    const ok = await nostro(cwd, ['expect', 'INV-9', '--account', A, '--amount', '25', '--memo-hash', hash])
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('Recorded INV-9:')
    const bad = await nostro(cwd, ['expect', 'INV-10', '--account', A, '--amount', '25', '--memo-hash', 'not-hex'])
    expect(bad).toMatchObject({ code: 2 })
    expect(bad.stderr).toContain('--memo-hash must be 64 lowercase hex characters.')
  })

  it('prints its version', async () => {
    const { code, stdout } = await nostro(workspace(), ['--version'])
    expect(code).toBe(0)
    expect(stdout).toMatch(/^\d+\.\d+\.\d+\n$/)
  })

  it('exits 2 on a command line it does not understand, and says where to look', async () => {
    const cwd = workspace()
    expect(await nostro(cwd, ['frobnicate'])).toMatchObject({
      code: 2,
      stderr: 'nostro: Unknown command "frobnicate".\nRun "nostro --help" for usage.\n',
    })
    expect((await nostro(cwd, ['help', 'frobnicate'])).code).toBe(2)
    const unknown = await nostro(cwd, ['migrate', '--frobnicate'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toMatch(/frobnicate[\s\S]*Run "nostro migrate --help" for usage/)
    expect((await nostro(cwd, ['migrate', 'extra'])).stderr).toContain('Unexpected argument "extra"')
    expect(existsSync(join(cwd, 'nostro.db'))).toBe(false)
  })
})

describe('nostro migrate', () => {
  it('creates the database, then reports it up to date', async () => {
    const cwd = workspace()
    const file = join(cwd, 'nostro.db')
    expect(await nostro(cwd, ['migrate'])).toMatchObject({
      code: 0,
      stdout: `Migrated ${file} from schema version 0 to 4.\n`,
    })
    expect((await nostro(cwd, ['migrate'])).stdout).toBe(`${file} is up to date (schema version 4).\n`)
    expect(JSON.parse((await nostro(cwd, ['migrate', '--json'])).stdout)).toEqual({ database: file, from: 4, to: 4 })
  })

  it('takes the database from --db or NOSTRO_DB, with or without a sqlite: prefix', async () => {
    const cwd = workspace()
    await nostro(cwd, ['migrate', '--db', 'sqlite:a.db'])
    await nostro(cwd, ['migrate'], { env: { NOSTRO_DB: 'b.db' } })
    await nostro(cwd, ['migrate', '--db', 'c.db'], { env: { NOSTRO_DB: 'ignored.db' } })
    expect(['a.db', 'b.db', 'c.db', 'ignored.db', 'nostro.db'].map((f) => existsSync(join(cwd, f)))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ])
  })

  it('leaves alone a database migrated by a newer nostro', async () => {
    const cwd = await migrated()
    setVersion(join(cwd, 'nostro.db'), 99)
    const { code, stderr } = await nostro(cwd, ['migrate'])
    expect(code).toBe(1)
    expect(stderr).toMatch(/schema version 99, newer than this nostro understands \(4\)\. Upgrade @nostro-labs\/cli; nothing was changed/)
  })

  it('refuses an in-memory database, which would vanish when it exits', async () => {
    for (const db of [':memory:', 'sqlite:']) {
      expect(await nostro(workspace(), ['migrate', '--db', db])).toMatchObject({
        code: 1,
        stderr: 'nostro: --db must name a database file or a postgres:// URL.\n',
      })
    }
  })
})

describe('opening a database', () => {
  it('never creates one outside migrate', async () => {
    const cwd = workspace()
    const { code, stderr } = await nostro(cwd, ['reconcile'])
    expect(code).toBe(1)
    expect(stderr).toBe(`nostro: No database at ${join(cwd, 'nostro.db')}. Create it with "nostro migrate".\n`)
    expect(existsSync(join(cwd, 'nostro.db'))).toBe(false)
  })

  it('refuses one that was never migrated, is behind, or is ahead', async () => {
    const cwd = workspace()
    const file = join(cwd, 'nostro.db')
    await new SqliteStore({ filename: file }).close()
    expect((await nostro(cwd, ['reconcile'])).stderr).toBe(`nostro: ${file} has not been set up. Run "nostro migrate" first.\n`)
    setVersion(file, 1)
    expect((await nostro(cwd, ['reconcile'])).stderr).toContain('is at schema version 1; this nostro needs 4. Run "nostro migrate".')
    setVersion(file, 99)
    const ahead = await nostro(cwd, ['reconcile'])
    expect(ahead.code).toBe(1)
    expect(ahead.stderr).toContain('newer than this nostro understands (4). Upgrade @nostro-labs/cli.')
  })

  it('reports an unreachable PostgreSQL without printing its password', async () => {
    const { code, stderr } = await nostro(workspace(), ['reconcile', '--db', 'postgres://nostro:s3cret@127.0.0.1:1/nostro'])
    expect(code).toBe(1)
    expect(stderr).toMatch(/^nostro: .*ECONNREFUSED/)
    expect(stderr).not.toContain('s3cret')
  })

  it('shows a stack trace only with NOSTRO_DEBUG', async () => {
    const db = ['reconcile', '--db', 'postgres://nostro@127.0.0.1:1/nostro']
    expect((await nostro(workspace(), db)).stderr.split('\n')).toHaveLength(2)
    expect((await nostro(workspace(), db, { env: { NOSTRO_DEBUG: '1' } })).stderr).toMatch(/\n {4}at /)
  })

  const url = process.env.NOSTRO_TEST_DATABASE_URL
  it.runIf(url !== undefined)('uses PostgreSQL for a postgres:// URL, in NOSTRO_PG_SCHEMA', async () => {
    const schema = `nostro_cli_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const env = { NOSTRO_DB: url!, NOSTRO_PG_SCHEMA: schema }
    const cwd = workspace()
    try {
      const first = await nostro(cwd, ['migrate'], { env })
      expect(first.code).toBe(0)
      expect(first.stdout).toContain(`(schema ${schema}) from schema version 0 to 3.`)
      expect(first.stdout).not.toContain(':nostro@')
      const synced = await nostro(cwd, ['sync', '--account', A, '--json'], { env, fetch: paid().fetch })
      expect(synced.code).toBe(0)
      expect(JSON.parse(synced.stdout).streams.map((s: { inserted: number }) => s.inserted)).toEqual([2, 1])
      expect(existsSync(join(cwd, 'nostro.db'))).toBe(false)
    } finally {
      const pool = new pg.Pool({ connectionString: url })
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await pool.end()
    }
  })
})

describe('nostro sync', () => {
  it('ingests effects and fees until caught up; a second run finds nothing new', async () => {
    const cwd = await migrated()
    const h = paid()
    const first = await nostro(cwd, ['sync', '--account', A], { fetch: h.fetch })
    expect(first.code).toBe(0)
    expect(first.stdout.split('\n')).toEqual([
      'ACCOUNT                                                   SOURCE        NEW  ALREADY HAD  STATE',
      `${A}  horizon       2    0            caught up`,
      `${A}  horizon-fees  1    0            caught up`,
      '',
    ])
    expect(h.requests.every((u) => u.host === 'horizon-testnet.stellar.org')).toBe(true)

    const again = JSON.parse((await nostro(cwd, ['sync', '--account', A, '--json'], { fetch: h.fetch })).stdout)
    expect(again).toMatchObject({ network: 'testnet', horizon: 'https://horizon-testnet.stellar.org' })
    expect(again.streams).toEqual([
      expect.objectContaining({ account: A, source: 'horizon', inserted: 0, caughtUp: true, error: null }),
      expect.objectContaining({ account: A, source: 'horizon-fees', inserted: 0, caughtUp: true, error: null }),
    ])
  })

  it('takes accounts from NOSTRO_ACCOUNTS and the network from NOSTRO_NETWORK', async () => {
    const cwd = await migrated()
    const h = paid()
    const env = { NOSTRO_ACCOUNTS: `${A}, ${B} ${A}`, NOSTRO_NETWORK: 'public' }
    const run = JSON.parse((await nostro(cwd, ['sync', '--json'], { env, fetch: h.fetch })).stdout)
    expect(run.network).toBe('public')
    expect(run.streams.map((s: { account: string }) => s.account)).toEqual([A, B, A, B])
    expect(h.requests.every((u) => u.host === 'horizon.stellar.org')).toBe(true)
  })

  it('needs --horizon for a network it has no default for', async () => {
    const cwd = await migrated()
    const unknown = await nostro(cwd, ['sync', '--account', A, '--network', 'futurenet'])
    expect(unknown).toMatchObject({ code: 2 })
    expect(unknown.stderr).toContain('Network futurenet has no default Horizon; pass --horizon <url>.')
    const h = paid()
    const given = await nostro(cwd, ['sync', '--account', A, '--network', 'futurenet', '--horizon', 'https://h.example'], {
      fetch: h.fetch,
    })
    expect(given.code).toBe(0)
    expect(h.requests.every((u) => u.host === 'h.example')).toBe(true)
  })

  it('exits 2 on a missing or malformed account, network or Horizon', async () => {
    const cwd = await migrated()
    for (const [argv, message] of [
      [[], 'Name at least one account'],
      [['--account', 'GABC'], '"GABC" is not a G... account id.'],
      [['--account', A, '--network', 'Main Net'], '--network must be a lowercase label'],
      [['--account', A, '--horizon', 'ftp://h.example'], '--horizon must be an http(s) URL'],
      [['--account', A, '--horizon', 'not a url'], '--horizon must be a URL'],
    ] as const) {
      const run = await nostro(cwd, ['sync', ...argv])
      expect(run.code).toBe(2)
      expect(run.stderr).toContain(message)
    }
  })

  it('with --once, stops after one round of pages', async () => {
    const cwd = await migrated()
    const h = new FakeHorizon()
    for (let ledger = 10; ledger < 2_011; ledger++) h.payment(ledger, B, A, '1')
    const once = await nostro(cwd, ['sync', '--account', A, '--once'], { fetch: h.fetch })
    expect(once.code).toBe(0)
    expect(once.stdout).toMatch(/horizon {7}\d+ +0 +more to read/)
    const rest = JSON.parse((await nostro(cwd, ['sync', '--account', A, '--json'], { fetch: h.fetch })).stdout)
    expect(rest.streams[0]).toMatchObject({ source: 'horizon', caughtUp: true })
    expect(rest.streams[0].inserted).toBeGreaterThan(0)
    const store = new SqliteStore({ filename: join(cwd, 'nostro.db') })
    expect(await store.listMovements({ tenantId: 'default', limit: 5_000 })).toHaveLength(2_001)
    await store.close()
  })

  it('reports progress on a terminal, and not in JSON', async () => {
    const cwd = await migrated()
    const tty = await nostro(cwd, ['sync', '--account', A], { fetch: paid().fetch, tty: true })
    expect(tty.stderr).toBe(`horizon ${A}: 2 new so far\nhorizon-fees ${A}: 1 new so far\n`)
    expect((await nostro(cwd, ['sync', '--account', A, '--json'], { fetch: paid().fetch, tty: true })).stderr).toBe('')
  })

  it('exits 1 when Horizon fails, saying how', async () => {
    const cwd = await migrated()
    const fetch = (async () =>
      new Response(JSON.stringify({ type: 'https://stellar.org/horizon-errors/bad_request', status: 400, title: 'Bad Request' }), {
        status: 400,
      })) as typeof globalThis.fetch
    const run = await nostro(cwd, ['sync', '--account', A], { fetch })
    expect(run.code).toBe(1)
    expect(run.stdout).toMatch(/horizon {7}0 {4}0 {12}failed: .*Bad Request/)
    const asJson = JSON.parse((await nostro(cwd, ['sync', '--account', A, '--json'], { fetch })).stdout)
    expect(asJson.streams[0].error).toMatch(/Bad Request/)
  })

  it('says when a re-delivered record disagrees with what was recorded', async () => {
    const cwd = await migrated()
    const h = paid()
    await nostro(cwd, ['sync', '--account', A], { fetch: h.fetch })
    h.effects = h.effects.map((e) => (e.account === A && e.type === 'account_credited' ? { ...e, amount: '26' } : e))
    const db = new Database(join(cwd, 'nostro.db'))
    db.exec('DELETE FROM cursors')
    db.close()
    const run = await nostro(cwd, ['sync', '--account', A], { fetch: h.fetch })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('1 re-delivered record(s) disagreed with what was recorded; each opened a SOURCE_GAP_DETECTED exception (nostro exceptions --code SOURCE_GAP_DETECTED).')
  })
})

describe('nostro reconcile', () => {
  it('decides every pending movement and posts each to the journal; a rerun has nothing to do', async () => {
    const cwd = await migrated()
    await nostro(cwd, ['sync', '--account', A], { fetch: paid().fetch })
    await expect1042(cwd)
    const run = await nostro(cwd, ['reconcile'])
    expect(run).toMatchObject({ code: 0, stderr: '' })
    expect(run.stdout).toBe(
      'Decided 3 movement(s): 1 allocated, 1 raised as exceptions, 1 ignored.\n' +
        'Exceptions: UNEXPECTED_DEBIT 1\n' +
        'Posted 3 journal entries.\n',
    )
    expect((await nostro(cwd, ['reconcile'])).stdout).toBe('Nothing to reconcile: no movement is pending.\n')
  })

  it('says when a payment was more than was owed', async () => {
    const cwd = await migrated()
    await nostro(cwd, ['sync', '--account', A], { fetch: paid().fetch })
    await expect1042(cwd, 'default', '20')
    expect((await nostro(cwd, ['reconcile'])).stdout).toMatch(
      /^Decided 3 movement\(s\): 1 overpaid \(allocated, the rest raised as OVERPAYMENT\), 1 raised as exceptions, 1 ignored\.\n/,
    )
  })

  it('works in batches, within one tenant', async () => {
    const cwd = await migrated()
    const fetch = paid().fetch
    await nostro(cwd, ['sync', '--account', A, '--tenant', 'acme'], { fetch })
    await expect1042(cwd, 'acme')
    expect((await nostro(cwd, ['reconcile'])).stdout).toBe('Nothing to reconcile: no movement is pending.\n')
    const run = JSON.parse((await nostro(cwd, ['reconcile', '--batch', '1', '--json'], { env: { NOSTRO_TENANT: 'acme' } })).stdout)
    expect(run).toEqual({
      decided: 3,
      allocated: 1,
      partial: 0,
      ignored: 1,
      journalEntries: 3,
      exceptions: { UNEXPECTED_DEBIT: 1 },
      errors: [],
    })
  })

  it('exits 1 and names each movement it could not decide', async () => {
    const cwd = await migrated()
    await nostro(cwd, ['sync', '--account', A], { fetch: paid().fetch })
    const db = new Database(join(cwd, 'nostro.db'))
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON journal_lines BEGIN SELECT RAISE(ABORT, 'disk on fire\u001b[2J'); END")
    db.close()
    const run = await nostro(cwd, ['reconcile'])
    expect(run.code).toBe(1)
    expect(run.stdout).toMatch(/^Decided 0 movement\(s\)\.\n/)
    const failures = run.stderr.trimEnd().split('\n')
    expect(failures).toHaveLength(3)
    expect(failures.every((f) => /^Failed on movement [0-9a-f-]{36}: disk on fire\\u001b\[2J$/.test(f))).toBe(true)
    const asJson = JSON.parse((await nostro(cwd, ['reconcile', '--json'])).stdout)
    expect(asJson.errors).toHaveLength(3)
  })

  it('exits 2 on a batch size it cannot use, or an empty tenant', async () => {
    const cwd = await migrated()
    for (const argv of [['--batch', '0'], ['--batch', '1.5'], ['--batch', '10001'], ['--tenant', ' ']]) {
      expect((await nostro(cwd, ['reconcile', ...argv])).code).toBe(2)
    }
  })
})

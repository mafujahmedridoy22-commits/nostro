#!/usr/bin/env node
/**
 * Check the packages as a user would get them, before publishing.
 *
 *   pnpm build
 *   node scripts/check-packages.mjs
 *
 * Packs each publishable package, checks what is in each tarball (built
 * code, README, LICENSE; no sources or tests; no workspace: ranges left),
 * installs the tarballs with npm into an empty directory, and uses them
 * there: the library, the SQLite store's native module, the server, the
 * `nostro` binary, and the TypeScript types. Exits non-zero on any failure.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES = ['core', 'store-sqlite', 'store-postgres', 'server', 'cli']
const work = mkdtempSync(join(tmpdir(), 'nostro-packages-'))
const run = (cmd, args, cwd, input) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) })
let failed = false
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  failed ||= !ok
}

try {
  const version = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).version
  const tarballs = []
  for (const pkg of PACKAGES) {
    const dir = join(root, 'packages', pkg)
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name
    const out = run('pnpm', ['pack', '--pack-destination', work], dir).trim().split('\n').pop()
    tarballs.push(out)
    const files = run('tar', ['tzf', out], work).trim().split('\n')
    const manifest = JSON.parse(run('tar', ['xzOf', out, 'package/package.json'], work))
    check(
      ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/dist/index.js', 'package/dist/index.d.ts'].every((f) =>
        files.includes(f),
      ),
      `${name}: tarball has package.json, README, LICENSE and built code with types`,
    )
    check(!files.some((f) => /^package\/(src|test)\//.test(f)), `${name}: no sources or tests in the tarball`)
    check(manifest.version === version, `${name}: version ${manifest.version}`)
    check(!JSON.stringify(manifest).includes('workspace:'), `${name}: no workspace: ranges left`)
  }

  const app = join(work, 'app')
  run('mkdir', ['-p', app], work)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }))
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...tarballs], app)
  check(true, 'npm installed all five tarballs into an empty directory')

  writeFileSync(
    join(app, 'use.mjs'),
    `
import assert from 'node:assert/strict'
import { MemoryStore, Money, NATIVE, doctor, journalCsv, reconcile, signWebhook, verifyWebhook } from 'nostro'
import { SqliteStore } from 'nostro-store-sqlite'
import { PostgresStore } from 'nostro-store-postgres'
import { apiKeys, createServer } from 'nostro-server'

const A = 'G' + 'A'.repeat(55)
assert.equal(Money.parse('0.1', NATIVE).add(Money.parse('0.2', NATIVE)).toString(), '0.3000000')

// A payment, an expectation, a decision, the books.
const store = new MemoryStore()
await store.transaction(async (tx) => {
  await tx.insertExpectation({ tenantId: 't', reference: 'INV-1', account: A, amount: Money.parse('25', NATIVE) })
  await tx.insertMovements([{ tenantId: 't', network: 'testnet', source: 'x', externalId: '1', account: A, direction: 'credit',
    kind: 'transfer', amount: Money.parse('25', NATIVE), memo: { type: 'text', value: 'inv 1' }, ledger: 1, occurredAt: new Date() }])
})
const decided = await reconcile({ store, tenantId: 't' })
assert.equal(decided.allocated, 1)
assert.equal((await doctor({ store, tenantId: 't' })).ok, true)
assert.equal((await journalCsv({ store, tenantId: 't' })).split('\\r\\n').length, 4)
const events = await store.listEvents({ tenantId: 't' })
assert.deepEqual(events.map((e) => e.type), ['expectation.settled', 'movement.decided'])
const secret = 's'.repeat(32), body = '{}', t = Math.floor(Date.now() / 1000)
assert.equal(verifyWebhook({ secret, header: signWebhook(secret, body, t), body }), true)

// The SQLite store's native module loads, and migrates.
const sqlite = new SqliteStore({ filename: 'app.db' })
await sqlite.migrate()
const v = await sqlite.schemaVersion()
assert.equal(v.current, v.latest)
await sqlite.close()

new PostgresStore({ connectionString: 'postgres://u@127.0.0.1:1/x' })

const server = createServer({ store, authenticate: apiKeys({ ['k'.repeat(32)]: 't' }) })
assert.deepEqual((await server.inject('/v1/health')).json(), { ok: true })
assert.equal((await server.inject('/v1/openapi.json')).json().info.version, '${version}')
const listed = await server.inject({ url: '/v1/expectations', headers: { authorization: 'Bearer ' + 'k'.repeat(32) } })
assert.equal(listed.json().data[0].status, 'settled')
await server.close()
console.log('used')
`,
  )
  check(run('node', ['use.mjs'], app).trim() === 'used', 'the library, both stores and the server work from the installed packages')

  const nostro = join(app, 'node_modules', '.bin', 'nostro')
  check(run(nostro, ['--version'], app).trim() === version, `the nostro binary runs, and says ${version}`)
  check(run(nostro, ['migrate', '--db', 'cli.db'], app).includes('from schema version 0 to'), 'nostro migrate creates a database')
  check(run(nostro, ['doctor', '--db', 'cli.db'], app).includes('OK: I1 and I3 hold'), 'nostro doctor passes on it')

  writeFileSync(
    join(app, 'types.ts'),
    `
import { Money, NATIVE, type Store, type MovementJson } from 'nostro'
import { SqliteStore } from 'nostro-store-sqlite'
import { PostgresStore } from 'nostro-store-postgres'
import { createServer, apiKeys } from 'nostro-server'
const store: Store = new SqliteStore({ filename: 'x.db' })
const pg: Store = new PostgresStore({ connectionString: 'postgres://u@h/d' })
void pg
const amount: Money = Money.parse('1', NATIVE)
const json: Pick<MovementJson, 'amount'> = { amount: amount.toString() }
createServer({ store, authenticate: apiKeys({ ['k'.repeat(32)]: 't' }) })
void json
`,
  )
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] }, files: ['types.ts'] }),
  )
  // As any TypeScript project on Node has.
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '@types/node@22'], app)
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  let typed = true
  try {
    run('node', [tsc, '-p', 'tsconfig.json'], app)
  } catch (err) {
    typed = false
    console.log(err.stdout)
  }
  check(typed, 'the published types compile in a strict TypeScript project')
} catch (err) {
  console.log(err.stdout ?? '', err.stderr ?? '', err.message)
  failed = true
} finally {
  rmSync(work, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

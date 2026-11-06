/**
 * Runs the shared Store conformance suite against a real PostgreSQL.
 *
 * Set NOSTRO_TEST_DATABASE_URL to a database the tests may create schemas
 * in; each test gets a fresh schema, dropped afterwards. Without it the suite
 * is skipped locally and fails in CI.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import type { StoreTx } from 'nostro'
import { Money, NATIVE } from 'nostro'
import { describeStoreConformance, describeStoreProperties } from 'nostro-testkit'
import { PostgresStore } from '../src/index.js'

const url = process.env.NOSTRO_TEST_DATABASE_URL
if (url === undefined && process.env.CI !== undefined) {
  throw new Error('NOSTRO_TEST_DATABASE_URL must be set in CI; the Postgres store would go untested.')
}

const pool = url === undefined ? undefined : new pg.Pool({ connectionString: url, max: 20 })
const schemas: string[] = []

async function freshStore(options: { schema?: string; now?: () => Date } = {}): Promise<PostgresStore> {
  const schema = options.schema ?? `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  schemas.push(schema)
  const store = new PostgresStore({ pool: pool!, schema, ...(options.now === undefined ? {} : { now: options.now }) })
  await store.migrate()
  return store
}

afterAll(async () => {
  if (pool === undefined) return
  for (const schema of new Set(schemas)) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await pool.end()
}, 300_000) // the property tests make a schema per history

if (pool === undefined) {
  describe.skip('PostgresStore (set NOSTRO_TEST_DATABASE_URL to run)', () => {
    it('conformance', () => {})
  })
} else {
  describeStoreConformance('PostgresStore', () => freshStore())
  describeStoreProperties('PostgresStore', (now) => freshStore({ now }), { runs: 15, differential: true })

  describe('PostgresStore', () => {
    it('migrates idempotently, even when several processes migrate at once', async () => {
      const schema = `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      await Promise.all([1, 2, 3].map(() => freshStore({ schema })))
      await freshStore({ schema })
      const { rows } = await pool.query(`SELECT version FROM "${schema}".migrations ORDER BY version`)
      expect(rows.map((r) => r.version)).toEqual([1, 2, 3])
    })

    it('reports the schema version without changing it', async () => {
      const schema = `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      schemas.push(schema)
      const store = new PostgresStore({ pool: pool!, schema })
      expect(await store.schemaVersion()).toEqual({ current: 0, latest: 3 })
      expect(await store.schemaVersion()).toEqual({ current: 0, latest: 3 })
      await store.migrate()
      expect(await store.schemaVersion()).toEqual({ current: 3, latest: 3 })
      await pool.query(`DELETE FROM "${schema}".migrations WHERE version = 3`)
      expect(await store.schemaVersion()).toEqual({ current: 2, latest: 3 })
    })

    it('commits events in seq order, so a reader after a seq can never miss one', async () => {
      const store = await freshStore()
      const open = (tenantId: string, detail: string) => (tx: StoreTx) =>
        tx.openException({ tenantId, code: 'MEMO_MISSING', account: `G${'A'.repeat(55)}`, detail })
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      let written!: () => void
      const emitted = new Promise<void>((r) => (written = r))
      const slow = store.transaction(async (tx) => {
        await open('t', 'first')(tx)
        written()
        await held
      })
      await emitted
      let fastDone = false
      const fast = store.transaction(open('t', 'second')).then(() => (fastDone = true))
      // Another tenant's events do not wait.
      await store.transaction(open('u', 'elsewhere'))
      await new Promise((r) => setTimeout(r, 200))
      expect(fastDone).toBe(false)
      expect(await store.listEvents({ tenantId: 't' })).toEqual([])
      release()
      await Promise.all([slow, fast])
      const events = await store.listEvents({ tenantId: 't' })
      expect(events.map((e) => (e.payload as { exception: { detail: string } }).exception.detail)).toEqual(['first', 'second'])
      expect(events[0]!.seq).toBeLessThan(events[1]!.seq)
    })

    it('keeps amounts exact beyond 64 bits', async () => {
      const store = await freshStore()
      const huge = Money.fromRaw(2n ** 100n + 7n, NATIVE)
      const e = await store.transaction((tx) =>
        tx.insertExpectation({ tenantId: 't', reference: 'R', account: `G${'A'.repeat(55)}`, amount: huge }),
      )
      expect((await store.getExpectation('t', e.id))!.amount.raw).toBe(2n ** 100n + 7n)
    })

    it('enforces the hard constraints in the database too, not only in code', async () => {
      const store = await freshStore()
      const s = schemas[schemas.length - 1]!
      await expect(
        pool.query(
          `INSERT INTO "${s}".expectations (id, tenant_id, reference, account, direction, asset, decimals,
             amount, payers, status, metadata, created_at, updated_at)
           VALUES ('x', 't', 'r', 'a', 'credit', 'native', 7, 0, '{}', 'open', '{}', now(), now())`,
        ),
      ).rejects.toThrow(/check constraint/)
      expect(await store.listExpectations({ tenantId: 't' })).toEqual([])
    })

    it('reports a reference taken by a concurrent transaction, and leaves this one usable', async () => {
      const store = await freshStore()
      const insert = (tx: Parameters<Parameters<PostgresStore['transaction']>[0]>[0]) =>
        tx.insertExpectation({ tenantId: 't', reference: 'INV-RACE', account: `G${'A'.repeat(55)}`, amount: Money.parse('1', NATIVE) })
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      const first = store.transaction(async (tx) => {
        await insert(tx)
        await held // keep the row uncommitted while the second transaction tries
      })
      await new Promise((r) => setTimeout(r, 50))
      const second = store.transaction(async (tx) => {
        // The pre-check cannot see the uncommitted row; the unique index must catch it.
        const attempt = insert(tx).catch((e: unknown) => e)
        setTimeout(release, 50)
        const err = await attempt
        await tx.setCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' }, 'still-usable')
        return err
      })
      await first
      expect(await second).toMatchObject({ name: 'ConstraintError', constraint: 'expectation_reference_unique' })
      expect(await store.getCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' })).toBe('still-usable')
    })

    describe('journal, enforced by the database itself', () => {
      /** A store with one movement, and the schema it lives in. */
      async function withMovement() {
        const store = await freshStore()
        const s = `"${schemas[schemas.length - 1]!}"`
        const { inserted } = await store.transaction((tx) =>
          tx.insertMovements([
            {
              tenantId: 't',
              network: 'testnet',
              source: 'horizon',
              externalId: 'e1',
              account: `G${'A'.repeat(55)}`,
              direction: 'credit',
              kind: 'transfer',
              amount: Money.parse('10', NATIVE),
              ledger: 1,
              occurredAt: new Date('2026-10-05T00:00:00Z'),
            },
          ]),
        )
        return { store, s, movement: inserted[0]! }
      }
      const rawEntry = async (client: pg.PoolClient, s: string, lines: [string, string][]) => {
        await client.query(
          `INSERT INTO ${s}.journal_entries (id, tenant_id, kind, effective_at, posted_at, description)
           VALUES ('raw', 't', 'reclass', now(), now(), 'raw')`,
        )
        for (const [i, [side, amount]] of lines.entries()) {
          await client.query(
            `INSERT INTO ${s}.journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
             VALUES ('raw', $1, 't', 'x', 'unapplied', $2, 'native', 7, $3)`,
            [i + 1, side, amount],
          )
        }
      }

      it('refuses an unbalanced entry at COMMIT, even written with raw SQL', async () => {
        const { s } = await withMovement()
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await rawEntry(client, s, [
            ['debit', '10'],
            ['credit', '9'],
          ])
          await expect(client.query('COMMIT')).rejects.toThrow(/does not balance/)
        } finally {
          client.release()
        }
        const one = await pool.connect()
        try {
          await one.query('BEGIN')
          await rawEntry(one, s, [['debit', '10']])
          await expect(one.query('COMMIT')).rejects.toThrow(/fewer than two lines/)
        } finally {
          one.release()
        }
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${s}.journal_entries`)
        expect(rows[0].n).toBe(0)
      })

      it('refuses to edit, delete or truncate posted entries', async () => {
        const { store, s, movement } = await withMovement()
        await store.transaction((tx) =>
          tx.postJournalEntry({
            tenantId: 't',
            movementId: movement.id,
            postingNo: 1,
            kind: 'initial',
            description: 'Received 10 XLM',
            lines: [
              { account: 'cash', role: 'cash', side: 'debit', amount: movement.amount },
              { account: 'unapplied', role: 'unapplied', side: 'credit', amount: movement.amount },
            ],
          }),
        )
        for (const sql of [
          `UPDATE ${s}.journal_entries SET description = 'edited'`,
          `DELETE FROM ${s}.journal_entries`,
          `UPDATE ${s}.journal_lines SET amount = 1`,
          `DELETE FROM ${s}.journal_lines`,
          `TRUNCATE ${s}.journal_lines, ${s}.journal_entries`,
        ]) {
          await expect(pool.query(sql)).rejects.toThrow(/append-only/)
        }
        expect(await store.listJournalEntries({ tenantId: 't' })).toHaveLength(1)
      })

      it('upgrades a version 1 database with data to the latest version', async () => {
        const { store, s, movement } = await withMovement()
        // Put the schema back to version 1, keeping its data.
        await pool.query(`DROP TABLE ${s}.journal_lines, ${s}.journal_entries, ${s}.events`)
        await pool.query(
          `DROP FUNCTION ${s}.journal_entry_balanced, ${s}.journal_line_balanced, ${s}.journal_check_entry, ${s}.journal_append_only, ${s}.events_append_only`,
        )
        await pool.query(`DELETE FROM ${s}.migrations WHERE version > 1`)
        await store.migrate()
        expect((await store.getMovement('t', movement.id))!.amount.toString()).toBe('10.0000000')
        expect(await store.listJournalEntries({ tenantId: 't' })).toEqual([])
        expect(await store.listEvents({ tenantId: 't' })).toEqual([])
      })
    })

    it('rejects a schema name that is not a plain identifier', () => {
      expect(() => new PostgresStore({ pool: pool!, schema: 'x"; DROP TABLE y; --' })).toThrow(/Invalid schema name/)
      expect(() => new PostgresStore({})).toThrow(/needs a pool or a connectionString/)
    })

    it('owns and ends a pool it created from a connection string', async () => {
      const store = new PostgresStore({ connectionString: url!, schema: 'unused' })
      await store.close()
      await expect(store.getCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' })).rejects.toThrow()
    })
  })
}

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { Money, NATIVE, doctor } from 'nostro'
import { describeStoreConformance, describeStoreProperties } from 'nostro-testkit'
import { SqliteStore } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'nostro-sqlite-'))
let files = 0
const freshFile = () => join(dir, `store-${++files}.db`)

async function freshStore(filename = freshFile()): Promise<SqliteStore> {
  const store = new SqliteStore({ filename })
  await store.migrate()
  return store
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describeStoreConformance('SqliteStore', () => freshStore())
describeStoreProperties(
  'SqliteStore',
  async (now) => {
    const store = new SqliteStore({ filename: freshFile(), now })
    await store.migrate()
    return store
  },
  { runs: 25, differential: true },
)

/** A store file holding one movement and its initial journal entry. */
async function journaled(): Promise<string> {
  const filename = freshFile()
  const store = await freshStore(filename)
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
  const m = inserted[0]!
  await store.transaction((tx) =>
    tx.postJournalEntry({
      tenantId: 't',
      movementId: m.id,
      postingNo: 1,
      kind: 'initial',
      description: 'Received 10 XLM',
      lines: [
        { account: 'cash', role: 'cash', side: 'debit', amount: m.amount },
        { account: 'unapplied', role: 'unapplied', side: 'credit', amount: m.amount },
      ],
    }),
  )
  await store.close()
  return filename
}

describe('SqliteStore', () => {
  it('refuses an in-memory database, which a second connection could not share', () => {
    for (const filename of ['', ':memory:', 'file::memory:?cache=shared']) {
      expect(() => new SqliteStore({ filename })).toThrow(/needs a database file/)
    }
  })

  it('migrates idempotently and records the schema version', async () => {
    const filename = freshFile()
    const store = new SqliteStore({ filename })
    expect(await store.schemaVersion()).toEqual({ current: 0, latest: 4 })
    await store.migrate()
    await store.migrate()
    expect(await store.schemaVersion()).toEqual({ current: 4, latest: 4 })
    await store.close()
    const db = new Database(filename, { readonly: true })
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    db.close()
  })

  it('keeps amounts exact beyond 64 bits', async () => {
    const store = await freshStore()
    const e = await store.transaction((tx) =>
      tx.insertExpectation({
        tenantId: 't',
        reference: 'R',
        account: `G${'A'.repeat(55)}`,
        amount: Money.fromRaw(2n ** 100n + 7n, NATIVE),
      }),
    )
    expect((await store.getExpectation('t', e.id))!.amount.raw).toBe(2n ** 100n + 7n)
    await store.close()
  })

  it('enforces positive integer amounts in the database too, not only in code', async () => {
    const filename = freshFile()
    const store = await freshStore(filename)
    await store.close()
    const db = new Database(filename)
    for (const amount of ['0', '-5', '1.5', '007', '12a']) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO expectations (id, tenant_id, reference, account, direction, asset, decimals, amount,
               payers, status, metadata, created_at, updated_at)
             VALUES (?, 't', ?, 'a', 'credit', 'native', 7, ?, '[]', 'open', '{}', 0, 0)`,
          )
          .run(`x${amount}`, `r${amount}`, amount),
      ).toThrow(/CHECK constraint/)
    }
    db.close()
  })

  it('refuses to edit or delete posted journal entries', async () => {
    const filename = await journaled()
    const db = new Database(filename)
    for (const sql of [
      "UPDATE journal_entries SET description = 'edited'",
      'DELETE FROM journal_entries',
      "UPDATE journal_lines SET amount = '1'",
      'DELETE FROM journal_lines',
    ]) {
      expect(() => db.prepare(sql).run()).toThrow(/append-only/)
    }
    db.close()
  })

  it('cannot refuse a line inserted behind its back, so doctor() reports it', async () => {
    const filename = await journaled()
    const db = new Database(filename)
    db.prepare(
      `INSERT INTO journal_lines (entry_id, line_no, tenant_id, account, role, side, asset, decimals, amount)
       VALUES ((SELECT id FROM journal_entries), 3, 't', 'cash', 'cash', 'debit', 'native', 7, '1')`,
    ).run()
    db.close()
    const store = await freshStore(filename)
    const report = await doctor({ store, tenantId: 't' })
    expect(report.ok).toBe(false)
    expect(report.findings).toEqual([expect.objectContaining({ invariant: 'I3', code: 'journal_unbalanced' })])
    await store.close()
  })

  it('upgrades a version 1 database with data to the latest version', async () => {
    const filename = freshFile()
    const store = await freshStore(filename)
    await store.transaction((tx) => tx.setCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' }, 'kept'))
    await store.close()
    const db = new Database(filename)
    db.exec('DROP TABLE journal_lines; DROP TABLE journal_entries; DROP TABLE events; PRAGMA user_version = 1')
    db.close()
    const upgraded = await freshStore(filename)
    expect(await upgraded.getCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' })).toBe('kept')
    expect(await upgraded.listJournalEntries({ tenantId: 't' })).toEqual([])
    expect(await upgraded.listEvents({ tenantId: 't' })).toEqual([])
    await upgraded.close()
  })

  it('sees committed data across separate store instances on one file', async () => {
    const filename = freshFile()
    const a = await freshStore(filename)
    const b = new SqliteStore({ filename })
    await a.transaction((tx) => tx.setCursor({ tenantId: 't', network: 'n', source: 's', account: 'x' }, '42'))
    expect(await b.getCursor({ tenantId: 't', network: 'n', source: 's', account: 'x' })).toBe('42')
    await a.close()
    await b.close()
  })
})

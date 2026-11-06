import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { JOURNAL_CSV_COLUMNS } from '@nostro-labs/nostro'
import { SqliteStore } from '@nostro-labs/store-sqlite'
import { FakeHorizon } from 'nostro-testkit'
import { A, B, migrated, nostro } from './helpers.js'

/** A is paid 25 XLM for INV-1042, then pays B 5 XLM and the 100-stroop fee: 19.9999900 left. */
function horizon(balance = '19.9999900'): FakeHorizon {
  const h = new FakeHorizon()
  h.payment(10, B, A, '25', { memo: 'INV-1042' })
  h.payment(11, A, B, '5', { memo: 'refund' })
  h.accounts.set(A, { id: A, last_modified_ledger: 11, balances: [{ balance, asset_type: 'native' }] })
  return h
}

/** Synced, with INV-1042 expected, and reconciled unless asked not to. */
async function books(h = horizon(), reconcile = true): Promise<string> {
  const cwd = await migrated()
  for (const argv of [
    ['sync', '--account', A],
    ['expect', 'INV-1042', '--account', A, '--amount', '25'],
    ...(reconcile ? [['reconcile']] : []),
  ]) {
    const run = await nostro(cwd, argv, { fetch: h.fetch })
    if (run.code !== 0) throw new Error(run.stderr)
  }
  return cwd
}

describe('nostro doctor', () => {
  it('passes reconciled books, and says that I2 was not checked', async () => {
    const run = await nostro(await books(), ['doctor'])
    expect(run).toMatchObject({ code: 0, stderr: '' })
    expect(run.stdout).toBe(
      'movements  3 (allocated 1, exception 1, ignored 1)\n' +
        'pending    none\n' +
        'journal    3 entries, debits equal credits in every asset (1)\n' +
        'balances   not checked; run with --attest\n' +
        '\nOK: I1 and I3 hold; I2 was not checked (run with --attest).\n',
    )
  })

  it('says how much is still pending, and since when', async () => {
    const run = await nostro(await books(horizon(), false), ['doctor'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('pending    3, the oldest from 2026-10-06 00:00 UTC; run "nostro reconcile"\n')
    expect(run.stdout).toContain('journal    0 entries\n')
  })

  it('with --attest, checks each balance against the chain at the ledger it last changed in', async () => {
    const h = horizon()
    const run = await nostro(await books(h), ['doctor', '--attest', '--account', A], { fetch: h.fetch })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('balances   checked against the chain for 1 account(s)\n')
    expect(run.stdout).toContain(
      'ACCOUNT                                                   ASSET  CHAIN       RECORDED    AT LEDGER  RESULT\n' +
        `${A}  XLM    19.9999900  19.9999900  11         match\n`,
    )
    expect(run.stdout).toMatch(/\nOK: I1, I2 and I3 hold\.\n$/)
    expect(h.requests.some((u) => u.pathname === `/accounts/${A}`)).toBe(true)
  })

  it('fails when the chain disagrees, after the attempts it was given', async () => {
    const h = horizon('20.0000000')
    const cwd = await books(h)
    const run = await nostro(cwd, ['doctor', '--attest', '--attempts', '1'], { fetch: h.fetch, env: { NOSTRO_ACCOUNTS: A } })
    expect(run.code).toBe(1)
    expect(run.stdout).toMatch(new RegExp(`${A} {2}XLM {4}20\\.0000000 {2}19\\.9999900 {2}11 {9}mismatch\\n`))
    expect(run.stdout).toMatch(new RegExp(`error {5}I2 {9}balance_mismatch {2}${A} XLM {2}`))
    expect(run.stdout).toMatch(/\nFAILED: 1 error\(s\)\. What each means and what to do: https:\/\/github\.com\/nostro-labs\/nostro\/blob\/main\/docs\/invariants\.md\n$/)
    const asJson = JSON.parse((await nostro(cwd, ['doctor', '--attest', '--attempts', '1', '--account', A, '--json'], { fetch: h.fetch })).stdout)
    expect(asJson.ok).toBe(false)
    expect(asJson.balances).toEqual([
      { account: A, asset: 'native', chain: '20.0000000', recorded: '19.9999900', ledger: 11, status: 'mismatch' },
    ])
    expect(asJson.findings).toEqual([expect.objectContaining({ invariant: 'I2', code: 'balance_mismatch', account: A })])
  })

  it('fails on a disposition the records no longer support, naming the movement', async () => {
    const cwd = await books()
    const db = new Database(join(cwd, 'nostro.db'))
    const { id } = db.prepare("SELECT id FROM movements WHERE disposition = 'exception'").get() as { id: string }
    db.prepare("UPDATE movements SET disposition = 'allocated' WHERE id = ?").run(id)
    db.close()
    const run = await nostro(cwd, ['doctor'])
    expect(run.code).toBe(1)
    expect(run.stdout).toMatch(new RegExp(`error {5}I1 {9}disposition_unsupported {2}movement ${id} {2}`))
    expect(run.stdout).toContain('FAILED: 1 error(s)')
    const asJson = JSON.parse((await nostro(cwd, ['doctor', '--json'])).stdout)
    expect(asJson).toMatchObject({ ok: false, movements: { total: 3 }, balances: null })
    expect(asJson.journal.totals).toEqual([{ asset: 'native', debits: '30.0000100', credits: '30.0000100' }])
  })

  it('lists a warning without failing: a decision made by hand and not posted yet', async () => {
    const cwd = await books(horizon(), false)
    const store = new SqliteStore({ filename: join(cwd, 'nostro.db') })
    const [first] = await store.listMovements({ tenantId: 'default', limit: 1 })
    await store.transaction((tx) => tx.setDisposition('default', first!.id, 'ignored', 'test payment'))
    await store.close()
    const run = await nostro(cwd, ['doctor'])
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(new RegExp(`warning {3}I3 {9}journal_stale {2}movement ${first!.id} {2}`))
    expect(run.stdout).toMatch(
      /\nRun "nostro post" to post the decisions the journal does not reflect yet\.\n\nOK: I1 and I3 hold; I2 was not checked \(run with --attest\), with 1 warning\(s\)\.\n$/,
    )

    expect((await nostro(cwd, ['post'])).stdout).toBe('Posted 1 entry (1 initial, 0 reclass, 0 correction) over 3 movement(s).\n')
    expect((await nostro(cwd, ['post'])).stdout).toBe('The journal reflects every decision (3 movement(s) examined).\n')
    expect(JSON.parse((await nostro(cwd, ['post', '--json'])).stdout)).toEqual({
      examined: 3,
      posted: { initial: 0, reclass: 0, correction: 0 },
      errors: [],
    })
    expect((await nostro(cwd, ['doctor'])).stdout).not.toContain('journal_stale')
  })

  it('post exits 1 and names each movement it could not post', async () => {
    const cwd = await books(horizon(), false)
    const store = new SqliteStore({ filename: join(cwd, 'nostro.db') })
    const [first] = await store.listMovements({ tenantId: 'default', limit: 1 })
    await store.transaction((tx) => tx.setDisposition('default', first!.id, 'ignored', 'test payment'))
    await store.close()
    const db = new Database(join(cwd, 'nostro.db'))
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON journal_lines BEGIN SELECT RAISE(ABORT, 'disk on fire'); END")
    db.close()
    const run = await nostro(cwd, ['post'])
    expect(run).toMatchObject({ code: 1, stderr: `Failed on movement ${first!.id}: disk on fire\n` })
    expect(JSON.parse((await nostro(cwd, ['post', '--json'])).stdout).errors).toEqual([{ movementId: first!.id, error: 'disk on fire' }])
  })

  it('exits 2 when told about accounts without --attest, or the reverse', async () => {
    const cwd = await migrated()
    const without = await nostro(cwd, ['doctor', '--account', A])
    expect(without.code).toBe(2)
    expect(without.stderr).toContain('--account is for --attest')
    expect((await nostro(cwd, ['doctor', '--attest'])).stderr).toContain('Name at least one account')
    expect((await nostro(cwd, ['doctor', '--attest', '--account', A, '--attempts', '0'])).code).toBe(2)
    // NOSTRO_ACCOUNTS is for sync too, so without --attest it is not an error.
    expect((await nostro(cwd, ['doctor'], { env: { NOSTRO_ACCOUNTS: A } })).code).toBe(0)
  })
})

describe('nostro export', () => {
  it('writes the journal as CSV to stdout, a row per line', async () => {
    const run = await nostro(await books(), ['export'])
    expect(run.code).toBe(0)
    const rows = run.stdout.split('\r\n')
    expect(rows[0]).toBe(JOURNAL_CSV_COLUMNS.join(','))
    expect(rows.at(-1)).toBe('')
    expect(rows).toHaveLength(1 + 6 + 1)
    expect(rows.filter((r) => r.includes(',cash,native,25.0000000,,'))).toHaveLength(1)
  })

  it('takes a date range', async () => {
    const cwd = await books()
    const header = `${JOURNAL_CSV_COLUMNS.join(',')}\r\n`
    expect((await nostro(cwd, ['export', '--from', '2026-10-07'])).stdout).toBe(header)
    expect((await nostro(cwd, ['export', '--to', '2026-10-06T00:00:00Z'])).stdout).toBe(header)
    expect((await nostro(cwd, ['export', '--from', '2026-10-06', '--to', '2026-10-07'])).stdout.split('\r\n')).toHaveLength(8)
    for (const argv of [['--from', '2026-10-07', '--to', '2026-10-07'], ['--from', 'yesterday'], ['--json'], ['--force']]) {
      expect((await nostro(cwd, ['export', ...argv])).code).toBe(2)
    }
  })

  it('writes a file it will not overwrite unless forced', async () => {
    const cwd = await books()
    const path = join(cwd, 'journal.csv')
    const first = await nostro(cwd, ['export', '--output', 'journal.csv'])
    expect(first).toMatchObject({ code: 0, stdout: `Wrote 6 journal line(s) to ${path}.\n` })
    expect(readFileSync(path, 'utf8')).toBe((await nostro(cwd, ['export'])).stdout)

    writeFileSync(path, 'mine')
    const again = await nostro(cwd, ['export', '--output', 'journal.csv'])
    expect(again).toMatchObject({ code: 1, stderr: `nostro: ${path} exists; pass --force to overwrite it.\n` })
    expect(readFileSync(path, 'utf8')).toBe('mine')
    expect((await nostro(cwd, ['export', '--output', path, '--force'])).code).toBe(0)
    expect(readFileSync(path, 'utf8')).toMatch(/^entry_id,/)
  })

  it('leaves no partial file behind when it fails part-way', async () => {
    const cwd = await books()
    const db = new Database(join(cwd, 'nostro.db'))
    // A line nostro cannot read back, so the export fails after writing the header.
    db.exec('DROP TRIGGER journal_lines_no_update')
    db.exec("UPDATE journal_lines SET asset = 'bogus' WHERE rowid = (SELECT max(rowid) FROM journal_lines)")
    db.close()
    const run = await nostro(cwd, ['export', '--output', 'journal.csv'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Invalid asset id "bogus"')
    expect(existsSync(join(cwd, 'journal.csv'))).toBe(false)
  })

  it('refuses to write where it cannot', async () => {
    const run = await nostro(await books(), ['export', '--output', 'missing/dir/journal.csv'])
    expect(run.code).toBe(1)
    expect(run.stderr).toMatch(/ENOENT/)
  })
})

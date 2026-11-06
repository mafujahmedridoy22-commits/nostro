/**
 * The journal half of the Store contract, as executable tests.
 *
 * Every store runs these: entries are append-only and balanced per asset,
 * posting numbers are a compare-and-set per movement, and a movement's cash
 * leg can only ever net to zero or exactly its amount.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JournalQuery, Movement, NewJournalEntry, NewJournalLine, Store } from '@nostro-labs/nostro'
import { Money, NotFoundError, ValidationError, asset } from '@nostro-labs/nostro'

const T = 'tenant-a'
const T2 = 'tenant-b'
const ACCOUNT = `G${'A'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const usdc = (v: string) => Money.parse(v, USDC)
const CASH = `assets:stellar:testnet:${ACCOUNT}`
const constraint = (name: string) => ({ name: 'ConstraintError', constraint: name })

let counter = 0

export function describeJournalConformance(name: string, makeStore: () => Store | Promise<Store>): void {
  describe(`Journal conformance: ${name}`, () => {
    let store: Store

    beforeEach(async () => {
      store = await makeStore()
    })
    afterEach(async () => {
      await store.close()
    })

    async function movement(amount = usdc('10'), tenantId = T): Promise<Movement> {
      counter += 1
      const { inserted } = await store.transaction((tx) =>
        tx.insertMovements([
          {
            tenantId,
            network: 'testnet',
            source: 'horizon',
            externalId: `journal-${counter}`,
            account: ACCOUNT,
            direction: 'credit',
            kind: 'transfer',
            amount,
            ledger: 1000 + counter,
            occurredAt: new Date('2026-10-05T12:00:00Z'),
          },
        ]),
      )
      return inserted[0]!
    }

    const lines = (amount: Money, counter = 'liabilities:unapplied-receipts'): NewJournalLine[] => [
      { account: CASH, role: 'cash', side: 'debit', amount },
      { account: counter, role: 'unapplied', side: 'credit', amount },
    ]
    const entry = (m: Movement, over: Partial<NewJournalEntry> = {}): NewJournalEntry => ({
      tenantId: m.tenantId,
      movementId: m.id,
      postingNo: 1,
      kind: 'initial',
      effectiveAt: m.occurredAt,
      description: 'Received 10 USDC',
      lines: lines(m.amount),
      ...over,
    })
    const post = (n: NewJournalEntry) => store.transaction((tx) => tx.postJournalEntry(n))

    it('posts an entry and reads it back exactly, lines in order and frozen', async () => {
      const m = await movement()
      const e = await post(entry(m))
      expect(e).toMatchObject({
        tenantId: T,
        movementId: m.id,
        postingNo: 1,
        kind: 'initial',
        effectiveAt: m.occurredAt,
        description: 'Received 10 USDC',
      })
      expect(e.postedAt).toBeInstanceOf(Date)
      const [read] = await store.listJournalEntries({ tenantId: T })
      expect(read!.lines.map((l) => [l.account, l.role, l.side, l.amount.toString(), l.expectationId, l.exceptionId])).toEqual([
        [CASH, 'cash', 'debit', '10.0000000', null, null],
        ['liabilities:unapplied-receipts', 'unapplied', 'credit', '10.0000000', null, null],
      ])
      expect(Object.isFrozen(read)).toBe(true)
      expect(Object.isFrozen(read!.lines)).toBe(true)
      expect(Object.isFrozen(read!.lines[0])).toBe(true)
    })

    it('defaults the effective date to the store clock', async () => {
      const m = await movement()
      const { effectiveAt, ...rest } = entry(m)
      void effectiveAt
      const e = await post(rest)
      expect(e.effectiveAt.getTime()).toBe(e.postedAt.getTime())
    })

    it('keeps amounts beyond 64 bits exact', async () => {
      const huge = Money.fromRaw(2n ** 70n + 3n, USDC)
      const m = await movement(huge)
      await post(entry(m))
      const [read] = await store.listJournalEntries({ tenantId: T, movementId: m.id })
      expect(read!.lines.map((l) => l.amount.raw)).toEqual([2n ** 70n + 3n, 2n ** 70n + 3n])
    })

    it('refuses an unbalanced entry and records nothing', async () => {
      const m = await movement()
      const unbalanced = entry(m, {
        lines: [
          { account: CASH, role: 'cash', side: 'debit', amount: usdc('10') },
          { account: 'x', role: 'unapplied', side: 'credit', amount: usdc('9') },
        ],
      })
      await expect(post(unbalanced)).rejects.toMatchObject(constraint('journal_unbalanced'))
      expect(await store.listJournalEntries({ tenantId: T })).toEqual([])
    })

    it('appends only at the next posting number', async () => {
      const m = await movement()
      await expect(post(entry(m, { postingNo: 2 }))).rejects.toMatchObject(constraint('journal_posting_conflict'))
      await post(entry(m))
      await expect(post(entry(m, { kind: 'reclass', lines: lines(usdc('1'), 'x').map((l) => ({ ...l, role: 'unapplied' })) }))).rejects.toMatchObject(
        constraint('journal_posting_conflict'),
      )
      const reclass: NewJournalEntry = entry(m, {
        postingNo: 2,
        kind: 'reclass',
        lines: [
          { account: 'liabilities:unapplied-receipts', role: 'unapplied', side: 'debit', amount: usdc('10') },
          { account: 'liabilities:customer-credit', role: 'customer_credit', side: 'credit', amount: usdc('10') },
        ],
      })
      await post(reclass)
      expect((await store.listJournalEntries({ tenantId: T, movementId: m.id })).map((e) => e.postingNo)).toEqual([1, 2])
    })

    it("never lets a movement's cash leg drift from its amount", async () => {
      const m = await movement()
      await post(entry(m))
      await expect(post(entry(m, { postingNo: 2, kind: 'correction' }))).rejects.toMatchObject(constraint('journal_cash_mismatch'))
    })

    it('keeps lines in the movement asset', async () => {
      const m = await movement()
      const xlm = Money.parse('10', 'native' as never)
      await expect(post(entry(m, { lines: lines(xlm) }))).rejects.toMatchObject(constraint('journal_asset'))
    })

    it('requires the movement, expectations and exceptions it names to exist in the tenant', async () => {
      const m = await movement()
      await expect(post(entry(m, { movementId: 'missing' }))).rejects.toBeInstanceOf(NotFoundError)
      await expect(post(entry(m, { tenantId: T2 }))).rejects.toBeInstanceOf(NotFoundError)
      const withExpectation = entry(m, { lines: lines(m.amount).map((l, i) => (i === 1 ? { ...l, expectationId: 'missing' } : l)) })
      await expect(post(withExpectation)).rejects.toBeInstanceOf(NotFoundError)
      const withException = entry(m, { lines: lines(m.amount).map((l, i) => (i === 1 ? { ...l, exceptionId: 'missing' } : l)) })
      await expect(post(withException)).rejects.toBeInstanceOf(NotFoundError)
      await expect(post(entry(m, { lines: [] }))).rejects.toBeInstanceOf(ValidationError)
    })

    it('links lines to expectations and exceptions', async () => {
      const m = await movement()
      const [e, x] = await store.transaction(async (tx) => [
        await tx.insertExpectation({ tenantId: T, reference: `J-${counter}`, account: ACCOUNT, amount: usdc('10') }),
        await tx.openException({ tenantId: T, code: 'OVERPAYMENT', movementId: m.id, detail: 'x' }),
      ])
      const linked = entry(m, {
        lines: [
          { account: CASH, role: 'cash', side: 'debit', amount: usdc('10') },
          { account: 'assets:receivable', role: 'receivable', side: 'credit', amount: usdc('6'), expectationId: (e as { id: string }).id },
          { account: 'liabilities:customer-credit', role: 'customer_credit', side: 'credit', amount: usdc('4'), exceptionId: (x as { id: string }).id },
        ],
      })
      const posted = await post(linked)
      expect(posted.lines.map((l) => [l.expectationId, l.exceptionId])).toEqual([
        [null, null],
        [(e as { id: string }).id, null],
        [null, (x as { id: string }).id],
      ])
    })

    it('accepts a manual entry not tied to a movement', async () => {
      const manual = await post({
        tenantId: T,
        kind: 'reclass',
        description: 'Write off suspense',
        lines: [
          { account: 'expenses:write-off', role: 'uncategorized_expense', side: 'debit', amount: usdc('1') },
          { account: 'assets:suspense', role: 'unexplained', side: 'credit', amount: usdc('1') },
        ],
      })
      expect(manual).toMatchObject({ movementId: null, postingNo: null })
    })

    it('lists entries in posting order, filtered and scoped by tenant', async () => {
      const a = await movement()
      const b = await movement()
      const other = await movement(usdc('10'), T2)
      const ea = await post(entry(a, { effectiveAt: new Date('2026-10-01T00:00:00Z') }))
      const eb = await post(entry(b, { effectiveAt: new Date('2026-10-03T00:00:00Z') }))
      await post(entry(other))
      const ids = async (q: Omit<JournalQuery, 'tenantId'>) =>
        (await store.listJournalEntries({ tenantId: T, ...q })).map((e) => e.id)
      expect(await ids({})).toEqual([ea.id, eb.id])
      expect(await ids({ movementId: b.id })).toEqual([eb.id])
      expect(await ids({ afterSeq: ea.seq })).toEqual([eb.id])
      expect(await ids({ limit: 1 })).toEqual([ea.id])
      expect(await ids({ effectiveFrom: new Date('2026-10-02T00:00:00Z') })).toEqual([eb.id])
      expect(await ids({ effectiveBefore: new Date('2026-10-03T00:00:00Z') })).toEqual([ea.id])
      expect(await ids({ movementId: other.id })).toEqual([])
    })

    it('rolls back an entry when its transaction throws', async () => {
      const m = await movement()
      await expect(
        store.transaction(async (tx) => {
          await tx.postJournalEntry(entry(m))
          throw new Error('abort')
        }),
      ).rejects.toThrow('abort')
      expect(await store.listJournalEntries({ tenantId: T })).toEqual([])
      await post(entry(m)) // posting number 1 is still free

      // Roll back a second entry on a movement that already has one committed.
      const reclass = entry(m, {
        postingNo: 2,
        kind: 'reclass',
        lines: [
          { account: 'liabilities:unapplied-receipts', role: 'unapplied', side: 'debit', amount: usdc('10') },
          { account: 'liabilities:customer-credit', role: 'customer_credit', side: 'credit', amount: usdc('10') },
        ],
      })
      await expect(
        store.transaction(async (tx) => {
          await tx.postJournalEntry(reclass)
          throw new Error('abort')
        }),
      ).rejects.toThrow('abort')
      expect(await store.listJournalEntries({ tenantId: T, movementId: m.id })).toHaveLength(1)
      await post(reclass)
      expect((await store.listJournalEntries({ tenantId: T, movementId: m.id })).map((e) => e.postingNo)).toEqual([1, 2])
    })

    it('lets only one of two concurrent posters append to a movement', async () => {
      const m = await movement()
      // Both read before either starts, as two workers can: each believes
      // posting 1 is free. Reading first is what makes this deterministic;
      // left to chance, a slow reader sees the other's entry and is refused by
      // the check below instead. The store must let exactly one win.
      const [one, two] = await Promise.all([
        store.listJournalEntries({ tenantId: T, movementId: m.id }),
        store.listJournalEntries({ tenantId: T, movementId: m.id }),
      ])
      const poster = (seen: readonly unknown[]) =>
        store.transaction(async (tx) => {
          await new Promise((r) => setTimeout(r, 20))
          return tx.postJournalEntry(entry(m, { postingNo: seen.length + 1 }))
        })
      const results = await Promise.allSettled([poster(one), poster(two)])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(rejected.reason).toMatchObject(constraint('journal_posting_conflict'))
      expect(await store.listJournalEntries({ tenantId: T, movementId: m.id })).toHaveLength(1)
    })

    it('refuses to post the same cash twice, even with the right posting number', async () => {
      const m = await movement()
      await store.transaction((tx) => tx.postJournalEntry(entry(m, { postingNo: 1 })))
      await expect(store.transaction((tx) => tx.postJournalEntry(entry(m, { postingNo: 2 })))).rejects.toMatchObject(
        constraint('journal_cash_mismatch'),
      )
      expect(await store.listJournalEntries({ tenantId: T, movementId: m.id })).toHaveLength(1)
    })
  })
}

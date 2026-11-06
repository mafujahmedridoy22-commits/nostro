/**
 * What must hold after any payment history whatsoever, as property tests.
 * Every store runs them, and each store's decisions are compared with the
 * memory store's: the same history must produce the same books everywhere.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Money as MoneyType, Store } from '@nostro-labs/nostro'
import { MemoryStore, Money, doctor, journalCsv, postJournal, reconcile, signedAmount, sumAmounts } from '@nostro-labs/nostro'
import type { Delivered, Scenario } from './scenario.js'
import { SCENARIO_ACCOUNT, SCENARIO_NOW, runScenario, scenario } from './scenario.js'

/** Parse RFC 4180 CSV, which is what the journal export promises. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c !== '"') cell += c
      else if (text[i + 1] === '"') (cell += '"'), i++
      else quoted = false
    } else if (c === '"') quoted = true
    else if (c === ',') row.push(cell), (cell = '')
    else if (c === '\r' && text[i + 1] === '\n') row.push(cell), rows.push(row), (row = []), (cell = ''), i++
    else cell += c
  }
  return rows
}

/** Every invariant, checked from the records themselves rather than from what reconcile reported. */
export async function checkBooks(store: Store, tenantId: string, delivered: Delivered): Promise<void> {
  const movements = await store.listMovements({ tenantId })
  const expectations = await store.listExpectations({ tenantId })
  const expectationById = new Map(expectations.map((e) => [e.id, e]))
  const paid = new Map<string, MoneyType>()
  let exceptionCount = 0
  let closedCount = 0

  expect(movements).toHaveLength(delivered.length)
  for (const m of movements) {
    const at = `movement ${m.externalId}`
    const allocations = await store.listAllocations({ tenantId, movementId: m.id })
    const exceptions = await store.listExceptions({ tenantId, movementId: m.id })
    const total = sumAmounts(allocations.map((a) => a.amount), m.amount)
    exceptionCount += exceptions.length
    closedCount += exceptions.filter((x) => x.status !== 'open').length

    // Nothing is silently dropped, and nothing is allocated twice over.
    expect(total.compare(m.amount), `${at} over-allocated`).toBeLessThanOrEqual(0)
    switch (m.disposition) {
      case 'allocated':
        expect(total.equals(m.amount), `${at} is allocated but not in full`).toBe(true)
        expect(exceptions.filter((x) => x.status === 'open'), at).toEqual([])
        break
      case 'partial': {
        const residual = m.amount.subtract(total)
        expect(total.isZero(), `${at} is partial with nothing allocated`).toBe(false)
        expect(residual.isZero(), `${at} is partial with nothing left`).toBe(false)
        const open = exceptions.filter((x) => x.status === 'open')
        expect(open, at).toHaveLength(1)
        expect(open[0]!.amount!.equals(residual), `${at}: the exception must cover exactly the residual`).toBe(true)
        break
      }
      case 'exception':
        expect(total.isZero(), `${at} raised an exception but has allocations`).toBe(true)
        expect(exceptions, at).toHaveLength(1)
        expect(exceptions[0]!.amount!.equals(m.amount), `${at}: the exception must cover the whole amount`).toBe(true)
        break
      case 'ignored':
        expect(m.ignoredReason, at).toBeTruthy()
        expect(exceptions.filter((x) => x.status === 'open'), at).toEqual([])
        // Nothing but a fee is ignored unless a person said so, and closed its exception saying why.
        if (m.kind !== 'fee') expect(exceptions.some((x) => x.status === 'dismissed' && x.resolutionNote === m.ignoredReason), at).toBe(true)
        break
      case 'pending':
        throw new Error(`${at} is still pending`)
    }

    // Whatever settled by itself quoted something: an amount alone never settles anything.
    if (allocations.some((a) => a.strategy !== 'manual')) {
      expect(m.muxedId !== null || m.memo !== null, `${at} settled on its amount alone`).toBe(true)
    }
    if (allocations.length > 0) expect(m.kind, `${at}: a fee is never matched`).not.toBe('fee')
    for (const a of allocations) {
      const e = expectationById.get(a.expectationId)!
      // A lookalike asset never settles the real thing.
      expect(a.amount.asset, at).toBe(e.amount.asset)
      expect(m.amount.asset, at).toBe(e.amount.asset)
      expect(m.direction, at).toBe(e.direction)
      expect(m.account, at).toBe(e.account)
      if (e.expiresAt !== null && a.strategy !== 'manual') {
        expect(m.occurredAt.getTime(), `${at} paid after expiry`).toBeLessThanOrEqual(e.expiresAt.getTime())
      }
      const sum = paid.get(e.id)
      paid.set(e.id, sum === undefined ? a.amount : sum.add(a.amount))
    }

    // The journal says what the chain says, for this movement, whatever was decided.
    const entries = await store.listJournalEntries({ tenantId, movementId: m.id })
    expect(entries.length, `${at} was never posted`).toBeGreaterThan(0)
    const cash = entries
      .flatMap((e) => e.lines)
      .filter((l) => l.role === 'cash' || l.role === 'issued')
      .reduce((n, l) => n + (l.side === 'debit' ? l.amount.raw : -l.amount.raw), 0n)
    expect(cash, `${at}: the cash leg must equal the movement`).toBe(signedAmount(m).raw)
    for (const entry of entries) {
      const net = entry.lines.reduce((n, l) => n + (l.side === 'debit' ? l.amount.raw : -l.amount.raw), 0n)
      expect(net, `${at}: entry ${entry.postingNo} does not balance`).toBe(0n)
    }
  }

  for (const e of expectations) {
    const at = `expectation ${JSON.stringify(e.reference)}`
    const sum = paid.get(e.id) ?? Money.zero(e.amount.asset, e.amount.decimals)
    expect(sum.compare(e.amount), `${at} over-allocated`).toBeLessThanOrEqual(0)
    const status = e.status === 'cancelled' ? 'cancelled' : sum.isZero() ? 'open' : sum.equals(e.amount) ? 'settled' : 'partially_paid'
    expect(e.status, at).toBe(status)
    if (e.status === 'cancelled') expect(sum.isZero(), `${at} was cancelled with money on it`).toBe(true)
  }

  const report = await doctor({ store, tenantId })
  expect(report.findings).toEqual([])
  expect(report.movements.byDisposition.pending).toBe(0)

  // One event per decision, no more and no fewer.
  const events = await store.listEvents({ tenantId })
  const subjects = (type: string) => events.filter((e) => e.type === type).map((e) => e.subjectId).sort()
  expect([...new Set(subjects('movement.decided'))]).toEqual(movements.map((m) => m.id).sort())
  for (const m of movements) {
    // A movement's decisions form an unbroken chain, from pending to what it is now: none lost, none repeated.
    let was = 'pending'
    for (const e of events.filter((x) => x.type === 'movement.decided' && x.subjectId === m.id)) {
      const { previous, movement } = e.payload as { previous: string; movement: { disposition: string } }
      expect(previous, `movement ${m.externalId}: an event was lost or repeated`).toBe(was)
      expect(movement.disposition, `movement ${m.externalId}: an event for no change`).not.toBe(was)
      was = movement.disposition
    }
    expect(was, `movement ${m.externalId}: the last event is not what it is now`).toBe(m.disposition)
  }
  expect(subjects('exception.opened')).toHaveLength(exceptionCount)
  expect(subjects('exception.resolved').length + subjects('exception.dismissed').length).toBe(closedCount)
  expect(subjects('expectation.settled')).toEqual(expectations.filter((e) => e.status === 'settled').map((e) => e.id).sort())
  expect(subjects('expectation.cancelled')).toEqual(expectations.filter((e) => e.status === 'cancelled').map((e) => e.id).sort())

  // The export carries every line, exactly, and hostile text survives it.
  const rows = parseCsv(await journalCsv({ store, tenantId }))
  const [header, ...lines] = rows
  const column = (name: string) => header!.indexOf(name)
  const totals = new Map<string, bigint>()
  for (const line of lines) {
    expect(line, 'a CSV row has the wrong number of columns').toHaveLength(header!.length)
    const asset = line[column('asset')]!
    const debit = line[column('debit')]!
    const credit = line[column('credit')]!
    const value = (s: string) => BigInt(s.replace('.', ''))
    totals.set(asset, (totals.get(asset) ?? 0n) + (debit === '' ? -value(credit) : value(debit)))
    const reference = line[column('expectation_reference')]!
    if (reference !== '') {
      const known = expectations.map((e) => e.reference)
      expect(known.includes(reference) || known.includes(reference.slice(1)), `CSV mangled the reference ${JSON.stringify(reference)}`).toBe(true)
    }
  }
  expect([...totals.values()].every((n) => n === 0n), 'the CSV does not balance').toBe(true)
  expect(lines).toHaveLength(report.journal.totals.length === 0 ? 0 : (await store.listJournalEntries({ tenantId })).flatMap((e) => e.lines).length)
}

/** The decisions, keyed by what the scenario chose rather than by generated ids, for comparing stores. */
export async function snapshot(store: Store, tenantId: string) {
  const movements = await store.listMovements({ tenantId })
  const expectations = await store.listExpectations({ tenantId })
  const external = new Map(movements.map((m) => [m.id, m.externalId]))
  const reference = new Map(expectations.map((e) => [e.id, e.reference]))
  const exceptions = await store.listExceptions({ tenantId })
  const amount = (m: MoneyType | null) => (m === null ? null : `${m.toString()} ${m.asset}`)
  const allocations = []
  for (const m of movements) {
    for (const a of await store.listAllocations({ tenantId, movementId: m.id })) {
      allocations.push([m.externalId, reference.get(a.expectationId), amount(a.amount), a.strategy, a.score])
    }
  }
  return {
    movements: movements.map((m) => [m.externalId, m.disposition, m.ignoredReason, amount(m.amount), m.memo === null ? null : String(m.memo.value)]),
    expectations: expectations.map((e) => [e.reference, e.status, amount(e.amount)]),
    allocations,
    exceptions: exceptions.map((x) => [x.code, x.status, amount(x.amount), external.get(x.movementId!), x.detail, x.resolutionNote]),
    journal: (await store.listJournalEntries({ tenantId })).map((j) => [
      external.get(j.movementId!),
      j.postingNo,
      j.kind,
      j.description,
      j.lines.map((l) => [l.account, l.role, l.side, amount(l.amount), l.expectationId === null ? null : reference.get(l.expectationId)]),
    ]),
    events: (await store.listEvents({ tenantId })).map((e) => e.type),
  }
}

export interface PropertyOptions {
  /** Histories per property. */
  readonly runs: number
  /** Compare every decision with the memory store's. Pointless for the memory store itself. */
  readonly differential?: boolean
}

/** `makeStore` must use the clock it is given, so decisions are comparable across stores. */
export function describeStoreProperties(
  name: string,
  makeStore: (now: () => Date) => Store | Promise<Store>,
  options: PropertyOptions,
): void {
  describe(`Store properties: ${name}`, () => {
    const now = () => SCENARIO_NOW
    // NOSTRO_PROPERTY_RUNS searches harder, for a run by hand before a release.
    const runs = Number(process.env.NOSTRO_PROPERTY_RUNS ?? options.runs)
    const TIMEOUT = Math.max(180_000, runs * 6_000)
    const tenantId = 'prop'
    /** Each history gets a store of its own, so a failure is about that history alone. */
    async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
      const store = await makeStore(now)
      try {
        return await fn(store)
      } finally {
        await store.close()
      }
    }

    it(
      'the books hold after any payment history',
      () =>
        fc.assert(
          fc.asyncProperty(scenario, (steps: Scenario) =>
            withStore(async (store) => {
              const delivered = await runScenario(store, tenantId, steps)
              await checkBooks(store, tenantId, delivered)
            }),
          ),
          { numRuns: runs },
        ),
      TIMEOUT,
    )

    it(
      'nothing changes when every payment is delivered again and everything is run again',
      () =>
        fc.assert(
          fc.asyncProperty(scenario, (steps: Scenario) =>
            withStore(async (store) => {
              const delivered = await runScenario(store, tenantId, steps)
              const before = await snapshot(store, tenantId)
              if (delivered.length > 0) {
                const replay = await store.transaction((tx) => tx.insertMovements(delivered))
                expect(replay.inserted).toEqual([])
                expect(replay.conflicts).toEqual([])
                expect(replay.duplicates).toHaveLength(delivered.length)
              }
              expect((await reconcile({ store, tenantId })).processed).toBe(0)
              const posted = await postJournal({ store, tenantId })
              expect(posted.posted).toEqual({ initial: 0, reclass: 0, correction: 0 })
              expect(await snapshot(store, tenantId)).toEqual(before)
            }),
          ),
          { numRuns: runs },
        ),
      TIMEOUT,
    )

    it(
      'what an invoice ends up paid does not depend on the order payments arrive',
      () =>
        fc.assert(
          fc.asyncProperty(
            fc
              .record({
                owed: fc.array(fc.bigInt({ min: 1n, max: 50n }), { minLength: 1, maxLength: 4 }),
                payments: fc.array(fc.record({ invoice: fc.nat(3), raw: fc.bigInt({ min: 1n, max: 50n }) }), { maxLength: 12 }),
              })
              .chain(({ owed, payments }) =>
                fc
                  .shuffledSubarray(payments, { minLength: payments.length, maxLength: payments.length })
                  .map((shuffled) => ({ owed, payments, shuffled })),
              ),
            async ({ owed, payments, shuffled }) => {
              const run = (order: typeof payments) => withStore(async (store) => {
                const steps: Scenario = [
                  ...owed.map((raw, key) => ({
                    op: 'expect' as const,
                    key,
                    suffix: '',
                    account: SCENARIO_ACCOUNT,
                    direction: 'credit' as const,
                    asset: 'native' as never,
                    raw,
                    muxed: true,
                    expiresIn: null,
                  })),
                  ...order.map((p) => ({
                    op: 'pay' as const,
                    account: SCENARIO_ACCOUNT,
                    direction: 'credit' as const,
                    kind: 'transfer' as const,
                    asset: 'native' as never,
                    raw: p.raw,
                    quote: { by: 'muxed' as const, key: p.invoice % owed.length },
                    at: 0,
                  })),
                ]
                const delivered = await runScenario(store, tenantId, steps)
                await checkBooks(store, tenantId, delivered)
                const list = await store.listExpectations({ tenantId })
                const out = new Map<string, bigint>()
                for (const e of list) {
                  const allocations = await store.listAllocations({ tenantId, expectationId: e.id })
                  out.set(e.reference, sumAmounts(allocations.map((a) => a.amount), e.amount).raw)
                }
                return out
              })
              const first = await run(payments)
              expect(await run(shuffled)).toEqual(first)
              // And it is exactly what was owed, or what was sent if that was less.
              owed.forEach((raw, key) => {
                const sent = payments.filter((p) => p.invoice % owed.length === key).reduce((n, p) => n + p.raw, 0n)
                expect(first.get(`INV-${key}`)).toBe(sent < raw ? sent : raw)
              })
            },
          ),
          { numRuns: runs },
        ),
      TIMEOUT,
    )

    if (options.differential === true) {
      it(
        'makes exactly the decisions the memory store makes',
        () =>
          fc.assert(
            fc.asyncProperty(scenario, (steps: Scenario) =>
              withStore(async (store) => {
                const reference = new MemoryStore({ now })
                await runScenario(reference, tenantId, steps)
                await runScenario(store, tenantId, steps)
                expect(await snapshot(store, tenantId)).toEqual(await snapshot(reference, tenantId))
                await reference.close()
              }),
            ),
            { numRuns: runs },
          ),
        TIMEOUT,
      )
    }
  })
}

import { describe, expect, it } from 'vitest'
import type { Movement, MovementKind, NewMovement } from '../src/index.js'
import {
  MemoryStore,
  Money,
  NATIVE,
  NotFoundError,
  ValidationError,
  applyMovement,
  asset,
  closeException,
  decideException,
  doctor,
  ignoreMovement,
  reconcile,
  resolutionJson,
} from '../src/index.js'

const T = 'acme'
const A = `G${'A'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const xlm = (v: string) => Money.parse(v, NATIVE)
const constraint = (name: string) => ({ name: 'ConstraintError', constraint: name })

let n = 0
function books() {
  const store = new MemoryStore()
  const owe = (reference: string, amount: Money, over: { expiresAt?: Date; direction?: 'credit' | 'debit' } = {}) =>
    store.transaction((tx) => tx.insertExpectation({ tenantId: T, reference, account: A, amount, ...over }))
  /** A payment that matches nothing, decided by reconcile. */
  const paid = async (amount: Money, over: Partial<NewMovement> & { kind?: MovementKind } = {}): Promise<Movement> => {
    n += 1
    const { inserted } = await store.transaction((tx) =>
      tx.insertMovements([
        {
          tenantId: T,
          network: 'testnet',
          source: 'test',
          externalId: `op-${n}`,
          account: A,
          direction: 'credit',
          kind: 'transfer',
          amount,
          ledger: n,
          occurredAt: new Date('2026-11-01T00:00:00Z'),
          ...over,
        },
      ]),
    )
    await reconcile({ store, tenantId: T })
    return (await store.getMovement(T, inserted[0]!.id))!
  }
  const lines = async (movementId: string) =>
    (await store.listJournalEntries({ tenantId: T, movementId })).map((e) => [
      e.kind,
      e.lines.map((l) => `${l.side === 'debit' ? 'Dr' : 'Cr'} ${l.role} ${l.amount.toString()}`).sort().reverse(),
    ])
  const healthy = async () => expect((await doctor({ store, tenantId: T })).findings).toEqual([])
  return { store, owe, paid, lines, healthy }
}

describe('applyMovement', () => {
  it('applies a payment nothing matched, closing its exception and moving it in the books', async () => {
    const { store, owe, paid, lines, healthy } = books()
    const invoice = await owe('INV-1', xlm('7'))
    const m = await paid(xlm('7'))
    expect(m.disposition).toBe('exception')

    const report = await applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: invoice.id }], note: 'customer called' })

    expect(report.movement.disposition).toBe('allocated')
    expect(report.allocations).toEqual([expect.objectContaining({ strategy: 'manual', score: null, amount: xlm('7') })])
    expect(report.closed.map((x) => [x.status, x.resolutionNote])).toEqual([['resolved', 'customer called']])
    expect(report.opened).toBeNull()
    expect(report.journalEntry!.kind).toBe('reclass')
    expect((await store.getExpectation(T, invoice.id))!.status).toBe('settled')
    expect(await lines(m.id)).toEqual([
      ['initial', ['Dr cash 7.0000000', 'Cr unapplied 7.0000000']],
      ['reclass', ['Dr unapplied 7.0000000', 'Cr receivable 7.0000000']],
    ])
    await healthy()
    const types = (await store.listEvents({ tenantId: T })).map((e) => e.type)
    expect(types.slice(-3)).toEqual(['expectation.settled', 'exception.resolved', 'movement.decided'])
  })

  it('takes only what is owing unless told otherwise, and leaves the rest open for a person', async () => {
    const { store, owe, paid, lines, healthy } = books()
    const invoice = await owe('INV-1', xlm('7'))
    const m = await paid(xlm('10'))
    const report = await applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: invoice.id }], note: 'part of it' })

    expect(report.movement.disposition).toBe('partial')
    expect(report.opened).toMatchObject({ code: 'PARTIAL_UNRESOLVED', status: 'open', amount: xlm('3') })
    expect(await lines(m.id)).toEqual([
      ['initial', ['Dr cash 10.0000000', 'Cr unapplied 10.0000000']],
      ['reclass', ['Dr unapplied 7.0000000', 'Cr receivable 7.0000000']],
    ])
    await healthy()

    // The rest can be applied later, and that finishes it.
    const second = await owe('INV-2', xlm('3'))
    const done = await applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: second.id }], note: 'the rest' })
    expect(done.movement.disposition).toBe('allocated')
    expect(done.closed.map((x) => x.code)).toEqual(['PARTIAL_UNRESOLVED'])
    expect(await store.listExceptions({ tenantId: T, movementId: m.id, status: 'open' })).toEqual([])
    await healthy()
  })

  it('splits one payment across invoices, with amounts where given', async () => {
    const { store, owe, paid, healthy } = books()
    const [a, b] = [await owe('INV-1', xlm('6')), await owe('INV-2', xlm('6'))]
    const m = await paid(xlm('10'))
    const report = await applyMovement({
      store,
      tenantId: T,
      movementId: m.id,
      allocations: [{ expectationId: a.id, amount: xlm('4') }, { expectationId: b.id }],
      note: 'one wire, two invoices',
    })
    expect(report.allocations.map((x) => x.amount.toString())).toEqual(['4.0000000', '6.0000000'])
    expect(report.movement.disposition).toBe('allocated')
    expect((await store.getExpectation(T, a.id))!.status).toBe('partially_paid')
    expect((await store.getExpectation(T, b.id))!.status).toBe('settled')
    await healthy()
  })

  it('applies an overpayment to another invoice; what stays is still owed back', async () => {
    const { store, owe, paid, lines, healthy } = books()
    await owe('INV-1', xlm('25'))
    const other = await owe('INV-2', xlm('2'))
    const m = await paid(xlm('30'), { memo: { type: 'text', value: 'INV-1' } })
    expect(m.disposition).toBe('partial')

    const report = await applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: other.id }], note: 'apply to their next invoice' })
    expect(report.movement.disposition).toBe('partial')
    expect(report.opened).toMatchObject({ code: 'OVERPAYMENT', amount: xlm('3') })
    expect((await lines(m.id)).at(-1)).toEqual(['reclass', ['Dr customer_credit 2.0000000', 'Cr receivable 2.0000000']])
    await healthy()
  })

  it('pays an expired invoice, because deciding that is what a person is for', async () => {
    const { store, owe, paid, healthy } = books()
    const invoice = await owe('INV-1', xlm('7'), { expiresAt: new Date('2026-01-01T00:00:00Z') })
    const m = await paid(xlm('7'), { memo: { type: 'text', value: 'INV-1' } })
    const [late] = await store.listExceptions({ tenantId: T, movementId: m.id })
    expect(late!.code).toBe('LATE_BEYOND_WINDOW')
    const report = await applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: invoice.id }], note: 'grace period' })
    expect(report.movement.disposition).toBe('allocated')
    await healthy()
  })

  it('still refuses what no one may do, and leaves everything as it was', async () => {
    const { store, owe, paid, lines, healthy } = books()
    const m = await paid(xlm('5'))
    const before = await lines(m.id)
    const attempt = (expectationId: string, amount?: Money) =>
      applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId, ...(amount === undefined ? {} : { amount }) }], note: 'n' })

    const usdc = await owe('INV-USDC', Money.parse('5', USDC))
    await expect(attempt(usdc.id)).rejects.toMatchObject(constraint('allocation_asset'))
    await expect(attempt(usdc.id, Money.parse('5', USDC))).rejects.toMatchObject(constraint('allocation_asset'))
    const small = await owe('INV-SMALL', xlm('1'))
    await expect(attempt(small.id, xlm('2'))).rejects.toMatchObject(constraint('allocation_over_expectation'))
    const big = await owe('INV-BIG', xlm('100'))
    await expect(attempt(big.id, xlm('6'))).rejects.toMatchObject(constraint('allocation_over_movement'))
    const payout = await owe('PAY-1', xlm('5'), { direction: 'debit' })
    await expect(attempt(payout.id)).rejects.toMatchObject(constraint('allocation_direction'))
    const elsewhere = await store.transaction((tx) =>
      tx.insertExpectation({ tenantId: T, reference: 'INV-ELSEWHERE', account: `G${'C'.repeat(55)}`, amount: xlm('5') }),
    )
    await expect(attempt(elsewhere.id)).rejects.toMatchObject(constraint('allocation_account'))
    const cancelled = await owe('INV-GONE', xlm('5'))
    await store.transaction((tx) => tx.cancelExpectation(T, cancelled.id, 'gone'))
    await expect(attempt(cancelled.id)).rejects.toMatchObject(constraint('allocation_expectation_cancelled'))
    await expect(attempt('nope')).rejects.toBeInstanceOf(NotFoundError)

    // A failure part-way rolls back the allocations before it.
    const fine = await owe('INV-FINE', xlm('1'))
    await expect(
      applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: fine.id }, { expectationId: 'nope' }], note: 'n' }),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(await store.listAllocations({ tenantId: T, movementId: m.id })).toEqual([])
    expect((await store.getMovement(T, m.id))!.disposition).toBe('exception')
    expect(await lines(m.id)).toEqual(before)
    await healthy()
  })

  it('says when nothing is left owing, or left of the payment', async () => {
    const { store, owe, paid } = books()
    const settled = await owe('INV-1', xlm('1'))
    const first = await paid(xlm('1'))
    await applyMovement({ store, tenantId: T, movementId: first.id, allocations: [{ expectationId: settled.id }], note: 'n' })
    const m = await paid(xlm('5'))
    await expect(
      applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: settled.id }], note: 'n' }),
    ).rejects.toMatchObject(constraint('allocation_over_expectation'))
    const [a, b] = [await owe('INV-2', xlm('5')), await owe('INV-3', xlm('5'))]
    await expect(
      applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: a.id }, { expectationId: b.id }], note: 'n' }),
    ).rejects.toMatchObject(constraint('allocation_over_movement'))
  })

  it('refuses a movement with nothing left to decide, and two people deciding one', async () => {
    const { store, owe, paid } = books()
    const invoice = await owe('INV-1', xlm('5'))
    const fee = await paid(xlm('0.00001'), { kind: 'fee', direction: 'debit' })
    expect(fee.disposition).toBe('ignored')
    await expect(
      applyMovement({ store, tenantId: T, movementId: fee.id, allocations: [{ expectationId: invoice.id }], note: 'n' }),
    ).rejects.toMatchObject(constraint('movement_not_open'))

    const m = await paid(xlm('5'))
    const apply = () => applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: invoice.id }], note: 'n' })
    const [one, two] = await Promise.allSettled([apply(), apply()])
    expect(one.status).toBe('fulfilled')
    expect(two).toMatchObject({ status: 'rejected', reason: constraint('movement_not_open') })
    expect(await store.listAllocations({ tenantId: T, movementId: m.id })).toHaveLength(1)

    await expect(applyMovement({ store, tenantId: 'other', movementId: m.id, allocations: [{ expectationId: invoice.id }], note: 'n' })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('needs a note and somewhere to apply it', async () => {
    const { store, owe, paid } = books()
    const invoice = await owe('INV-1', xlm('5'))
    const m = await paid(xlm('5'))
    await expect(applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: invoice.id }], note: ' ' })).rejects.toBeInstanceOf(ValidationError)
    await expect(applyMovement({ store, tenantId: T, movementId: m.id, allocations: [], note: 'n' })).rejects.toBeInstanceOf(ValidationError)
    await expect(applyMovement({ store, tenantId: T, movementId: m.id, allocations: [{ expectationId: invoice.id }], note: 'a\0b' })).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('ignoreMovement', () => {
  it('takes money in or out of the queue, with a reason, and says so in the books', async () => {
    const { store, paid, lines, healthy } = books()
    const refund = await paid(xlm('9'))
    const report = await ignoreMovement({ store, tenantId: T, movementId: refund.id, reason: 'our own top-up' })
    expect(report.movement).toMatchObject({ disposition: 'ignored', ignoredReason: 'our own top-up' })
    expect(report.closed.map((x) => [x.status, x.resolutionNote])).toEqual([['dismissed', 'our own top-up']])
    expect(await lines(refund.id)).toEqual([
      ['initial', ['Dr cash 9.0000000', 'Cr unapplied 9.0000000']],
      ['reclass', ['Dr unapplied 9.0000000', 'Cr uncategorized_income 9.0000000']],
    ])
    const out = await paid(xlm('4'), { direction: 'debit' })
    await ignoreMovement({ store, tenantId: T, movementId: out.id, reason: 'paid a supplier' })
    expect((await lines(out.id)).at(-1)).toEqual(['reclass', ['Dr uncategorized_expense 4.0000000', 'Cr unexplained 4.0000000']])
    await healthy()
  })

  it('keeps what was allocated when the rest of an overpayment is written off', async () => {
    const { store, owe, paid, lines, healthy } = books()
    const invoice = await owe('INV-1', xlm('25'))
    const m = await paid(xlm('30'), { memo: { type: 'text', value: 'INV-1' } })
    await ignoreMovement({ store, tenantId: T, movementId: m.id, reason: 'customer said keep it' })
    expect((await store.getExpectation(T, invoice.id))!.status).toBe('settled')
    expect(await store.listAllocations({ tenantId: T, movementId: m.id })).toHaveLength(1)
    expect((await lines(m.id)).at(-1)).toEqual(['reclass', ['Dr customer_credit 5.0000000', 'Cr uncategorized_income 5.0000000']])
    await healthy()
  })

  it('needs a reason, and something to decide', async () => {
    const { store, paid } = books()
    const m = await paid(xlm('5'))
    await expect(ignoreMovement({ store, tenantId: T, movementId: m.id, reason: '' })).rejects.toBeInstanceOf(ValidationError)
    await ignoreMovement({ store, tenantId: T, movementId: m.id, reason: 'x' })
    await expect(ignoreMovement({ store, tenantId: T, movementId: m.id, reason: 'again' })).rejects.toMatchObject(constraint('movement_not_open'))
    await expect(ignoreMovement({ store, tenantId: T, movementId: 'nope', reason: 'x' })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('closeException', () => {
  it('closes one no movement depends on', async () => {
    const { store, owe, healthy } = books()
    const invoice = await owe('INV-1', xlm('1'))
    const about = await store.transaction((tx) => tx.openException({ tenantId: T, code: 'MEMO_MALFORMED', expectationId: invoice.id, detail: 'x' }))
    const closed = await closeException({ store, tenantId: T, exceptionId: about.id, status: 'dismissed', note: 'seen' })
    expect(closed).toMatchObject({ status: 'dismissed', resolutionNote: 'seen' })
    await healthy()
  })

  it('refuses the last open exception of an undecided movement, which would strand it', async () => {
    const { store, paid, healthy } = books()
    const m = await paid(xlm('5'))
    const [only] = await store.listExceptions({ tenantId: T, movementId: m.id })
    await expect(closeException({ store, tenantId: T, exceptionId: only!.id, status: 'resolved', note: 'n' })).rejects.toMatchObject(constraint('disposition_unsupported'))

    // With another still open, or once the movement is decided, it can go.
    const further = await store.transaction((tx) => tx.openException({ tenantId: T, code: 'SOURCE_GAP_DETECTED', movementId: m.id, detail: 'x' }))
    await closeException({ store, tenantId: T, exceptionId: further.id, status: 'resolved', note: 'n' })
    await ignoreMovement({ store, tenantId: T, movementId: m.id, reason: 'x' })
    const late = await store.transaction((tx) => tx.openException({ tenantId: T, code: 'SOURCE_GAP_DETECTED', movementId: m.id, detail: 'y' }))
    await closeException({ store, tenantId: T, exceptionId: late.id, status: 'dismissed', note: 'checked' })
    await healthy()
  })

  it('needs a note, and an exception', async () => {
    const { store } = books()
    await expect(closeException({ store, tenantId: T, exceptionId: 'nope', status: 'resolved', note: 'n' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(closeException({ store, tenantId: T, exceptionId: 'nope', status: 'resolved', note: '' })).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('decideException', () => {
  const exceptionOf = async (store: MemoryStore, movementId: string) => (await store.listExceptions({ tenantId: T, movementId }))[0]!

  it('applies by reference, with an amount as a string, and reports it all as JSON', async () => {
    const { store, owe, paid, healthy } = books()
    await owe('INV-1', xlm('7'))
    const m = await paid(xlm('10'))
    const x = await exceptionOf(store, m.id)
    const report = await decideException({
      store,
      tenantId: T,
      exceptionId: x.id,
      decision: { action: 'apply', allocations: [{ reference: 'INV-1', amount: '2.5' }], note: 'part of it' },
    })
    const json = JSON.parse(JSON.stringify(resolutionJson(report)))
    expect(json.movement).toMatchObject({ id: m.id, disposition: 'partial' })
    expect(json.allocations).toEqual([expect.objectContaining({ amount: '2.5000000', asset: 'native', strategy: 'manual' })])
    expect(json.closed).toEqual([expect.objectContaining({ id: x.id, status: 'resolved', resolutionNote: 'part of it' })])
    expect(json.opened).toMatchObject({ code: 'PARTIAL_UNRESOLVED', amount: '7.5000000' })
    expect(json.journalEntry).toMatchObject({ kind: 'reclass' })
    await healthy()
  })

  it('ignores, and closes', async () => {
    const { store, owe, paid, healthy } = books()
    const m = await paid(xlm('10'))
    const report = await decideException({ store, tenantId: T, exceptionId: (await exceptionOf(store, m.id)).id, decision: { action: 'ignore', note: 'top-up' } })
    expect(report.movement).toMatchObject({ disposition: 'ignored', ignoredReason: 'top-up' })

    const invoice = await owe('INV-1', xlm('1'))
    const about = await store.transaction((tx) => tx.openException({ tenantId: T, code: 'MEMO_MALFORMED', expectationId: invoice.id, detail: 'x' }))
    const closed = await decideException({ store, tenantId: T, exceptionId: about.id, decision: { action: 'close', status: 'dismissed', note: 'seen' } })
    expect(closed.movement).toBeNull()
    expect(closed.closed[0]).toMatchObject({ status: 'dismissed' })
    expect(resolutionJson(closed)).toMatchObject({ movement: null, opened: null, journalEntry: null })

    const late = await store.transaction((tx) => tx.openException({ tenantId: T, code: 'SOURCE_GAP_DETECTED', movementId: m.id, detail: 'x' }))
    const onDecided = await decideException({ store, tenantId: T, exceptionId: late.id, decision: { action: 'close', note: 'checked' } })
    expect(onDecided.movement).toMatchObject({ id: m.id })
    expect(onDecided.closed[0]).toMatchObject({ status: 'resolved' })
    await healthy()
  })

  it('refuses what it cannot do, by name', async () => {
    const { store, owe, paid } = books()
    const invoice = await owe('INV-1', xlm('1'))
    const about = await store.transaction((tx) => tx.openException({ tenantId: T, code: 'MEMO_MALFORMED', expectationId: invoice.id, detail: 'x' }))
    const decide = (exceptionId: string, decision: Parameters<typeof decideException>[0]['decision']) => decideException({ store, tenantId: T, exceptionId, decision })
    await expect(decide('nope', { action: 'ignore', note: 'n' })).rejects.toMatchObject({ entity: 'exception' })
    await expect(decide(about.id, { action: 'ignore', note: 'n' })).rejects.toBeInstanceOf(ValidationError)
    await expect(decide(about.id, { action: 'apply', allocations: [{ reference: 'INV-1' }], note: 'n' })).rejects.toBeInstanceOf(ValidationError)
    const m = await paid(xlm('5'))
    const x = (await store.listExceptions({ tenantId: T, movementId: m.id }))[0]!
    await expect(decide(x.id, { action: 'apply', allocations: [{ reference: 'INV-404' }], note: 'n' })).rejects.toMatchObject({ entity: 'expectation' })
    await expect(decide(x.id, { action: 'apply', allocations: [{ reference: 'INV-1', amount: '1.00000001' }], note: 'n' })).rejects.toMatchObject({ name: 'PrecisionError' })
    await expect(decide(x.id, { action: 'close', note: 'n' })).rejects.toMatchObject(constraint('disposition_unsupported'))
  })
})

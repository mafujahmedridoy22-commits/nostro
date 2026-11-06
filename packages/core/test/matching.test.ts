import { describe, expect, it } from 'vitest'
import type { Candidate, Decision, Expectation, MatchStrategy, Movement } from '../src/index.js'
import { Money, asset, combine, decide, normalizeReference } from '../src/index.js'

const ACCOUNT = `G${'A'.repeat(55)}`
const PAYER = `G${'B'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const FAKE_USDC = asset('USDC', 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW')
const usdc = (v: string) => Money.parse(v, USDC)

let n = 0
function movement(over: Partial<Movement> = {}): Movement {
  n += 1
  return {
    id: `m${n}`,
    tenantId: 't',
    seq: n,
    network: 'testnet',
    source: 'horizon',
    externalId: `effect-${n}`,
    revision: 1,
    account: ACCOUNT,
    direction: 'credit',
    kind: 'transfer',
    amount: usdc('10'),
    counterparty: PAYER,
    muxedId: null,
    memo: null,
    ledger: 1000,
    txHash: null,
    operationId: null,
    occurredAt: new Date('2026-10-05T12:00:00Z'),
    enrichment: 'complete',
    disposition: 'pending',
    ignoredReason: null,
    createdAt: new Date('2026-10-05T12:00:05Z'),
    ...over,
  }
}

function expectation(over: Partial<Expectation> = {}): Expectation {
  n += 1
  return {
    id: `e${n}`,
    tenantId: 't',
    seq: n,
    reference: `INV-${String(n).padStart(5, '0')}`,
    account: ACCOUNT,
    direction: 'credit',
    amount: usdc('10'),
    muxedId: null,
    memo: null,
    payers: [],
    dueAt: null,
    expiresAt: null,
    status: 'open',
    cancelReason: null,
    metadata: {},
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  }
}

const candidate = (e: Expectation, remaining: Money = e.amount): Candidate => ({ expectation: e, remaining })

function allocation(d: Decision) {
  if (d.outcome !== 'allocate') throw new Error(`expected an allocation, got ${JSON.stringify(d)}`)
  return d
}
function exception(d: Decision) {
  if (d.outcome !== 'exception') throw new Error(`expected an exception, got ${JSON.stringify(d)}`)
  return d
}

describe('normalizeReference', () => {
  it.each([
    ['INV-00123', '00123'],
    ['inv #00123', '00123'],
    ['Invoice 00123', '00123'],
    ['ＩＮＶ００１２３', '00123'],
    ['Invoice No. 123', '123'],
    ['REF #123', '123'],
    ['inv​-00123', '00123'],
    ['inv00123', '00123'],
    ['  ORDER-77 ', 'ORDER77'],
    ['#', ''],
    // A prefix after a stray separator, as wallets and people produce.
    ['- INV 123', '123'],
    [': #INV-00123', '00123'],
    ['I-NV 5', '5'],
  ])('normalises %j to %j', (input, want) => {
    expect(normalizeReference(input)).toBe(want)
  })

  it.each(['INVENTORY-5', 'NOVA-9', 'REFUND 3'])('strips a prefix only at a word boundary: %j', (input) => {
    expect(normalizeReference(input)).toBe(input.replace(/[\s-]/g, ''))
  })

  it('keeps leading zeros, which can be significant', () => {
    expect(normalizeReference('INV-00123')).not.toBe(normalizeReference('INV-123'))
  })
})

describe('combine', () => {
  it('takes the strongest signal per family and combines across families', () => {
    const s = (family: 'identifier' | 'amount', score: number) => ({ strategy: 'x', family, score, reason: '' })
    expect(combine([])).toBe(0)
    expect(combine([s('identifier', 0.85), s('identifier', 0.95)])).toBeCloseTo(0.95)
    expect(combine([s('identifier', 0.85), s('amount', 0.6)])).toBeCloseTo(0.94)
  })
})

describe('decide: identifying the expectation', () => {
  it('matches a payment to a muxed address with certainty', () => {
    const e = expectation({ muxedId: 42n })
    const d = allocation(decide(movement({ muxedId: 42n }), [candidate(e), candidate(expectation())]))
    expect(d).toMatchObject({ expectationId: e.id, strategy: 'muxed_id', score: 1, residual: null })
    expect(d.amount.toString()).toBe('10.0000000')
  })

  it('matches a memo id to the memo id asked for, or to the muxed id', () => {
    // A part-payment, so the amount strategy stays silent and the memo id's own score shows.
    const asked = expectation({ memo: { type: 'id', value: 7n } })
    const part = usdc('3')
    expect(allocation(decide(movement({ amount: part, memo: { type: 'id', value: 7n } }), [candidate(asked)]))).toMatchObject({
      expectationId: asked.id,
      strategy: 'memo_id',
      score: 0.95,
    })
    const muxed = expectation({ muxedId: 9n })
    const d = allocation(decide(movement({ memo: { type: 'id', value: 9n } }), [candidate(muxed)]))
    expect(JSON.stringify(d.evidence)).toContain('matches the muxed id')
  })

  it.each(['INV-00123', 'inv #00123', 'Invoice 00123', 'ＩＮＶ００１２３', 'inv​00123'])(
    'matches the text memo %j to reference INV-00123',
    (memo) => {
      const e = expectation({ reference: 'INV-00123', amount: usdc('99') })
      expect(allocation(decide(movement({ memo: { type: 'text', value: memo } }), [candidate(e)]))).toMatchObject({
        expectationId: e.id,
        strategy: 'memo_text',
      })
    },
  )

  it('matches a text memo against the memo the expectation asked for', () => {
    const e = expectation({ reference: 'internal-7781', memo: { type: 'text', value: 'ACME-42' } })
    expect(allocation(decide(movement({ memo: { type: 'text', value: 'acme 42' } }), [candidate(e)])).expectationId).toBe(e.id)
  })

  it('does not stack signals from the same family, but does across families', () => {
    const e = expectation({ reference: 'INV-1', muxedId: 5n })
    const both = allocation(decide(movement({ muxedId: 5n, memo: { type: 'text', value: 'INV-1' } }), [candidate(e)]))
    expect(both.score).toBe(1)
    const memoAndAmount = allocation(decide(movement({ memo: { type: 'text', value: 'INV-1' } }), [candidate(e)]))
    expect(memoAndAmount.score).toBe(0.94)
  })
})

describe('decide: amounts', () => {
  it('allocates a partial payment in full, leaving the rest owed', () => {
    const e = expectation({ reference: 'INV-1' })
    const d = allocation(decide(movement({ amount: usdc('4'), memo: { type: 'text', value: 'INV-1' } }), [candidate(e)]))
    expect(d.amount.toString()).toBe('4.0000000')
    expect(d.residual).toBeNull()
  })

  it('allocates what is still owed on a part-paid expectation and returns the overpayment', () => {
    const e = expectation({ reference: 'INV-1', status: 'partially_paid' })
    const d = allocation(
      decide(movement({ amount: usdc('9'), memo: { type: 'text', value: 'INV-1' } }), [candidate(e, usdc('6'))]),
    )
    expect(d.amount.toString()).toBe('6.0000000')
    expect(d.residual!.toString()).toBe('3.0000000')
  })
})

describe('decide: refusing a confident match', () => {
  it('refuses a lookalike asset with the same code but another issuer', () => {
    const e = expectation({ reference: 'INV-1' })
    const d = exception(
      decide(movement({ amount: Money.parse('10', FAKE_USDC), memo: { type: 'text', value: 'INV-1' } }), [candidate(e)]),
    )
    expect(d).toMatchObject({ code: 'WRONG_ASSET', expectationId: e.id })
    expect(d.detail).toMatch(/lookalike/)
  })

  it('refuses a payment after the expectation expired', () => {
    const e = expectation({ muxedId: 1n, expiresAt: new Date('2026-10-04T00:00:00Z') })
    expect(exception(decide(movement({ muxedId: 1n }), [candidate(e)]))).toMatchObject({
      code: 'LATE_BEYOND_WINDOW',
      expectationId: e.id,
    })
  })

  it('refuses a second payment to a settled expectation as a duplicate', () => {
    const e = expectation({ muxedId: 1n, status: 'settled' })
    expect(exception(decide(movement({ muxedId: 1n }), [candidate(e, usdc('0'))]))).toMatchObject({
      code: 'DUPLICATE_PAYMENT',
      expectationId: e.id,
    })
  })
})

describe('decide: not confident enough', () => {
  it('raises identifiers that point at different expectations as ambiguous', () => {
    const a = expectation({ muxedId: 1n })
    const b = expectation({ memo: { type: 'id', value: 2n } })
    const d = exception(decide(movement({ muxedId: 1n, memo: { type: 'id', value: 2n } }), [candidate(a), candidate(b)]))
    expect(d.code).toBe('AMBIGUOUS_MATCH')
    expect(d.detail).toMatch(/within 0.15/)
    expect((d.evidence as { candidates: unknown[] }).candidates).toHaveLength(2)
  })

  it('offers a unique amount match as a suggestion, never settling on amount alone', () => {
    const e = expectation()
    const d = exception(decide(movement(), [candidate(e), candidate(expectation({ amount: usdc('11') }))]))
    expect(d.code).toBe('AMBIGUOUS_MATCH')
    expect(d.detail).toMatch(/0.6, below the 0.7 threshold/)
    expect((d.evidence as { candidates: { expectationId: string }[] }).candidates[0]!.expectationId).toBe(e.id)
  })

  it('settles on amount when the caller lowers the threshold deliberately', () => {
    const e = expectation()
    expect(allocation(decide(movement(), [candidate(e)], { threshold: 0.5 })).strategy).toBe('exact_amount')
  })

  it('lists every candidate owed the same amount, oldest first', () => {
    const newer = expectation({ createdAt: new Date('2026-10-02T00:00:00Z') })
    const older = expectation({ createdAt: new Date('2026-09-30T00:00:00Z') })
    const d = exception(decide(movement(), [candidate(newer), candidate(older)]))
    const listed = (d.evidence as { candidates: { expectationId: string; score: number }[] }).candidates
    expect(listed.map((c) => [c.expectationId, c.score])).toEqual([
      [older.id, 0.2],
      [newer.id, 0.2],
    ])
  })

  it('ignores an amount match outside the expectation window', () => {
    const later = expectation({ createdAt: new Date('2026-10-20T00:00:00Z') })
    expect(exception(decide(movement(), [candidate(later)])).code).toBe('MEMO_MISSING')
  })

  it('gives the same decision whatever order the candidates arrive in', () => {
    const cs = [candidate(expectation()), candidate(expectation()), candidate(expectation({ muxedId: 3n }))]
    const m = movement({ muxedId: 3n })
    const a = JSON.stringify(decide(m, cs))
    expect(JSON.stringify(decide(m, [...cs].reverse()))).toBe(a)
    expect(JSON.stringify(decide(m, [cs[1]!, cs[2]!, cs[0]!]))).toBe(a)
  })
})

describe('decide: nothing to match', () => {
  it('ignores fees, which are posted to expense', () => {
    expect(decide(movement({ kind: 'fee', direction: 'debit' }), [candidate(expectation())])).toEqual({
      outcome: 'ignore',
      reason: 'network fee: posted to expense, never matched',
    })
  })

  it.each<[string, Partial<Movement>, boolean, string]>([
    ['an unexpected debit', { direction: 'debit' }, false, 'UNEXPECTED_DEBIT'],
    ['a credit whose enrichment is missing', { enrichment: 'missing' }, false, 'ENRICHMENT_MISSING'],
    ['a credit with no memo, nothing owed', {}, false, 'UNEXPECTED_CREDIT'],
    ['a credit with no memo, something owed', { amount: usdc('3') }, true, 'MEMO_MISSING'],
    ['a credit whose memo matches nothing', { memo: { type: 'text', value: 'INV-404' } }, false, 'UNMATCHED_NO_CANDIDATE'],
  ])('raises %s', (_, over, owed, code) => {
    const d = exception(decide(movement(over), owed ? [candidate(expectation())] : []))
    expect(d).toMatchObject({ code, expectationId: null })
    expect(d.amount!.toString()).toBe((over.amount ?? usdc('10')).toString())
  })

  it('lets a custom strategy contribute evidence', () => {
    const payer: MatchStrategy = {
      name: 'known_payer',
      family: 'payer',
      evaluate: (m, c) =>
        c.expectation.payers.includes(m.counterparty ?? '')
          ? { strategy: 'known_payer', family: 'payer', score: 0.55, reason: 'known payer' }
          : null,
    }
    const e = expectation({ payers: [PAYER] })
    const d = allocation(decide(movement(), [candidate(e)], { strategies: [payer, ...[]], threshold: 0.5 }))
    expect(d.strategy).toBe('known_payer')
  })
})

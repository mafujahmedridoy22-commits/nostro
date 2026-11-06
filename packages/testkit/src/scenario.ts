/**
 * Random but valid payment histories, for property tests.
 *
 * A scenario is a list of steps: record what is owed, a payment arrives (in
 * the right asset or a lookalike, quoting the invoice or not, too much or too
 * little), reconcile runs part-way through, an invoice is cancelled. Amounts
 * come from a small set often enough that exact matches, duplicates and
 * ambiguity actually happen, and from beyond 2^64 often enough to catch
 * anything that is not exact. Text is hostile: control characters, NUL,
 * bidirectional overrides, whatever fast-check can produce.
 */
import fc from 'fast-check'
import type { AssetId, Direction, Memo, MovementKind, NewMovement, Store } from 'nostro'
import { ConstraintError, Money, NATIVE, ValidationError, applyMovement, asset, ignoreMovement, reconcile } from 'nostro'

export const SCENARIO_ACCOUNT = `G${'A'.repeat(55)}`
const OTHER_ACCOUNT = `G${'C'.repeat(55)}`
const PAYER = `G${'B'.repeat(55)}`
const CIRCLE = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const LOOKALIKE = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW'

const ASSETS: readonly AssetId[] = [
  NATIVE,
  asset('USDC', CIRCLE),
  asset('USDC', LOOKALIKE), // same code, another issuer: must never settle real USDC
  asset('TOK', SCENARIO_ACCOUNT), // issued by the watched account itself
]

/** Fixed, so a run can be compared across stores. */
export const SCENARIO_NOW = new Date('2026-10-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const muxedIdOf = (key: number) => BigInt(1_000 + key)
const referenceOf = (key: number, suffix: string) => `INV-${key}${suffix}`

export type Quote =
  | { readonly by: 'none' }
  | { readonly by: 'muxed'; readonly key: number }
  | { readonly by: 'memoId'; readonly key: number }
  /** The invoice's reference, the way a person might type it. */
  | { readonly by: 'memoText'; readonly key: number; readonly style: number }
  | { readonly by: 'garbage'; readonly memo: Memo }

export type Step =
  | {
      readonly op: 'expect'
      readonly key: number
      readonly suffix: string
      readonly account: string
      readonly direction: Direction
      readonly asset: AssetId
      readonly raw: bigint
      readonly muxed: boolean
      /** Days from `SCENARIO_NOW`, or none. */
      readonly expiresIn: number | null
    }
  | {
      readonly op: 'pay'
      readonly account: string
      readonly direction: Direction
      readonly kind: MovementKind
      readonly asset: AssetId
      readonly raw: bigint
      readonly quote: Quote
      /** Days from `SCENARIO_NOW`. */
      readonly at: number
    }
  | { readonly op: 'reconcile'; readonly limit: number }
  | { readonly op: 'cancel'; readonly key: number }
  /**
   * A person applies a payment to invoices. Aimed: a payment still undecided,
   * to invoices it could settle. Otherwise whatever comes to hand, which the
   * store mostly refuses, and a refusal has to leave everything as it was.
   */
  | { readonly op: 'apply'; readonly aimed: boolean; readonly payment: number; readonly keys: readonly number[]; readonly note: string }
  /** A person decides a payment is not one to reconcile. */
  | { readonly op: 'ignore'; readonly aimed: boolean; readonly payment: number; readonly reason: string }

export type Scenario = readonly Step[]

const UNIT = 10_000_000n
const raw = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom(1n, 2n, 5n, 10n, 25n).map((n) => n * UNIT) },
  { weight: 2, arbitrary: fc.bigInt({ min: 1n, max: 100n * UNIT }) },
  { weight: 1, arbitrary: fc.bigInt({ min: 1n << 64n, max: 1n << 100n }) },
)
const key = fc.integer({ min: 0, max: 6 })
const account = fc.constantFrom(SCENARIO_ACCOUNT, SCENARIO_ACCOUNT, SCENARIO_ACCOUNT, OTHER_ACCOUNT)
const direction = fc.constantFrom<Direction>('credit', 'credit', 'credit', 'debit')
/** Random text rarely has the characters that break things, so those are asked for by name. */
const hostile = fc.oneof(
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 28 }) },
  { weight: 1, arbitrary: fc.constantFrom(',x', '"x"', ' x,"y"', '\r\nx', '\nx', '=cmd()', '+1', '@x', '\u0000x', '\ud800x', '\u202ex', '\u001b[2Jx', '\ud83d\ude00') },
)

const quote: fc.Arbitrary<Quote> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<Quote>({ by: 'none' }) },
  { weight: 1, arbitrary: key.map((k): Quote => ({ by: 'muxed', key: k })) },
  { weight: 1, arbitrary: key.map((k): Quote => ({ by: 'memoId', key: k })) },
  { weight: 2, arbitrary: fc.record({ key, style: fc.nat(4) }).map((q): Quote => ({ by: 'memoText', ...q })) },
  {
    weight: 1,
    arbitrary: fc.oneof(
      hostile.filter((s) => s !== '').map((value): Memo => ({ type: 'text', value })),
      fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map((value): Memo => ({ type: 'id', value })),
      fc.stringMatching(/^[0-9a-f]{64}$/).map((value): Memo => ({ type: 'hash', value })),
    ).map((memo): Quote => ({ by: 'garbage', memo })),
  },
)

type Invoice = Extract<Step, { op: 'expect' }>

const invoice: fc.Arbitrary<Invoice> = fc.record({
  op: fc.constant('expect' as const),
  key: fc.constant(0), // replaced by its position in the list
  suffix: fc.oneof({ weight: 3, arbitrary: fc.constant('') }, { weight: 1, arbitrary: hostile }),
  account,
  direction,
  asset: fc.constantFrom(...ASSETS),
  raw,
  muxed: fc.boolean(),
  expiresIn: fc.oneof({ weight: 3, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.integer({ min: -3, max: 3 }) }),
})

/** Any payment at all: usually one that matches nothing. */
const strayPayment: fc.Arbitrary<Step> = fc.record({
  op: fc.constant('pay' as const),
  account,
  direction,
  kind: fc.constantFrom<MovementKind>('transfer', 'transfer', 'transfer', 'transfer', 'fee', 'clawback'),
  asset: fc.constantFrom(...ASSETS),
  raw,
  quote,
  at: fc.integer({ min: -3, max: 3 }),
})

/**
 * A payment aimed at one of the invoices: right account, direction and asset
 * most of the time, for the amount owed, part of it or more than it, quoting
 * the invoice one way or another. Without these nearly nothing settles, and
 * the properties would hold without testing much.
 */
const aimedPayment = (invoices: readonly Invoice[]): fc.Arbitrary<Step> =>
  fc
    .record({
      to: fc.constantFrom(...invoices),
      asset: fc.oneof({ weight: 9, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.constantFrom(...ASSETS) }),
      offTarget: fc.oneof({ weight: 19, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
      share: fc.constantFrom('exact', 'exact', 'exact', 'half', 'third', 'over', 'double'),
      by: fc.constantFrom('muxed', 'muxed', 'memoId', 'memoText', 'memoText', 'none'),
      style: fc.nat(4),
      at: fc.integer({ min: -1, max: 3 }),
    })
    .map(({ to, asset, offTarget, share, by, style, at }): Step => {
      const amount = {
        exact: to.raw,
        half: to.raw / 2n,
        third: to.raw / 3n,
        over: to.raw + 1n,
        double: to.raw * 2n,
      }[share]!
      const q: Quote =
        by === 'none'
          ? { by: 'none' }
          : by === 'memoText'
            ? { by: 'memoText', key: to.key, style }
            : { by: by as 'muxed' | 'memoId', key: to.key }
      return {
        op: 'pay',
        account: offTarget ? OTHER_ACCOUNT : to.account,
        direction: to.direction,
        kind: 'transfer',
        asset: asset ?? to.asset,
        raw: amount > 0n ? amount : 1n,
        quote: q,
        at,
      }
    })

const aimed = fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) })
const because = fc.oneof(
  { weight: 4, arbitrary: fc.constant('checked with the customer') },
  { weight: 1, arbitrary: hostile.filter((s) => s.trim() !== '') },
)

/** Most histories record their invoices first; the rest let payments arrive before them. */
export const scenario: fc.Arbitrary<Scenario> = fc
  .record({ invoices: fc.array(invoice, { minLength: 1, maxLength: 6 }), upfront: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }) })
  .chain(({ invoices, upfront }) => {
    const numbered = invoices.map((inv, key) => ({ ...inv, key }))
    const step: fc.Arbitrary<Step> = fc.oneof(
      { weight: 2, arbitrary: fc.constantFrom<Step>(...numbered) },
      { weight: 8, arbitrary: aimedPayment(numbered) },
      { weight: 2, arbitrary: strayPayment },
      { weight: 1, arbitrary: fc.record({ op: fc.constant('reconcile' as const), limit: fc.integer({ min: 1, max: 5 }) }) },
      { weight: 1, arbitrary: fc.record({ op: fc.constant('cancel' as const), key: fc.nat(numbered.length - 1) }) },
      {
        weight: 3,
        arbitrary: fc.record({
          op: fc.constant('apply' as const),
          aimed,
          payment: fc.nat(40),
          keys: fc.array(fc.nat(numbered.length - 1), { minLength: 1, maxLength: 2 }),
          note: because,
        }),
      },
      { weight: 1, arbitrary: fc.record({ op: fc.constant('ignore' as const), aimed, payment: fc.nat(40), reason: because }) },
    )
    return fc.array(step, { minLength: 3, maxLength: 25 }).map((steps) => (upfront ? [...numbered, ...steps] : steps))
  })

function memoText(reference: string, style: number): string {
  const spelled = [
    reference,
    reference.toLowerCase(),
    reference.replace('-', ' #'),
    `Invoice ${reference.slice('INV-'.length)}`,
    `​ ${reference.replace('-', '_')} `,
  ][style]!
  // By code point: a memo cuts bytes, but never leaves half a character behind.
  return Array.from(spelled).slice(0, 28).join('')
}

/** Every movement a scenario delivered, by external id, for replaying. */
export type Delivered = readonly NewMovement[]

/**
 * Run a scenario through the real `reconcile`, and reconcile until nothing is
 * left pending. Any constraint the store raises on a cancel is expected (an
 * invoice with money on it cannot be cancelled); anything else is a failure.
 */
export async function runScenario(store: Store, tenantId: string, steps: Scenario): Promise<Delivered> {
  const references = new Map<number, string>()
  const delivered: NewMovement[] = []
  const settle = async (limit: number) => {
    const report = await reconcile({ store, tenantId, limit })
    if (report.errors.length > 0) throw report.errors[0]!.error
    return report
  }

  for (const [i, s] of steps.entries()) {
    switch (s.op) {
      case 'expect': {
        if (references.has(s.key)) break
        const reference = referenceOf(s.key, s.suffix)
        try {
          await store.transaction((tx) =>
            tx.insertExpectation({
              tenantId,
              reference,
              account: s.account,
              direction: s.direction,
              amount: Money.fromRaw(s.raw, s.asset),
              muxedId: s.muxed ? muxedIdOf(s.key) : null,
              expiresAt: s.expiresIn === null ? null : new Date(SCENARIO_NOW.getTime() + s.expiresIn * DAY),
            }),
          )
          references.set(s.key, reference)
        } catch (err) {
          // Hostile text every store refuses alike (a NUL, half a character), rather than each failing its own way.
          if (!(err instanceof ValidationError)) throw err
        }
        break
      }
      case 'pay': {
        const fee = s.kind === 'fee'
        const q = fee ? ({ by: 'none' } as const) : s.quote
        const memo: Memo | null =
          q.by === 'memoId'
            ? { type: 'id', value: muxedIdOf(q.key) }
            : q.by === 'memoText'
              ? { type: 'text', value: memoText(references.get(q.key) ?? referenceOf(q.key, ''), q.style) }
              : q.by === 'garbage'
                ? q.memo
                : null
        const movement: NewMovement = {
          tenantId,
          network: 'testnet',
          source: 'scenario',
          externalId: `op-${i}`,
          account: s.account,
          direction: fee ? 'debit' : s.direction,
          kind: s.kind,
          amount: Money.fromRaw(s.raw, fee ? NATIVE : s.asset),
          counterparty: fee ? null : PAYER,
          muxedId: q.by === 'muxed' ? muxedIdOf(q.key) : null,
          memo,
          ledger: 1_000 + i,
          txHash: i.toString(16).padStart(64, '0'),
          operationId: `${i}`,
          occurredAt: new Date(SCENARIO_NOW.getTime() + s.at * DAY),
        }
        delivered.push(movement)
        await store.transaction((tx) => tx.insertMovements([movement]))
        break
      }
      case 'reconcile':
        await settle(s.limit)
        break
      case 'cancel': {
        const reference = references.get(s.key)
        if (reference === undefined) break
        const e = await store.getExpectationByReference(tenantId, reference)
        try {
          await store.transaction((tx) => tx.cancelExpectation(tenantId, e!.id, 'cancelled in a scenario'))
        } catch (err) {
          if (!(err instanceof ConstraintError)) throw err
        }
        break
      }
      case 'apply':
      case 'ignore': {
        if (s.aimed) while ((await settle(100)).processed > 0);
        const movements = await store.listMovements({ tenantId })
        const undecided = movements.filter((m) => m.disposition === 'exception' || m.disposition === 'partial')
        const pool = s.aimed ? undecided : movements
        if (pool.length === 0) break
        const movement = pool[s.payment % pool.length]!
        // A refusal is expected here (the wrong asset, a settled invoice, a payment
        // already decided), and checkBooks sees that it left everything as it was.
        try {
          if (s.op === 'ignore') {
            await ignoreMovement({ store, tenantId, movementId: movement.id, reason: s.reason })
            break
          }
          const expectations = await store.listExpectations({ tenantId })
          const fitting = expectations.filter(
            (e) =>
              e.account === movement.account &&
              e.direction === movement.direction &&
              e.amount.asset === movement.amount.asset &&
              (e.status === 'open' || e.status === 'partially_paid'),
          )
          const named = s.keys.map((key) => expectations.find((e) => e.reference === references.get(key)))
          const chosen = s.aimed
            ? [...new Set(s.keys.map((key) => fitting[key % Math.max(fitting.length, 1)]))]
            : [...new Set(named)]
          const targets = chosen.filter((e) => e !== undefined)
          if (targets.length > 0) {
            await applyMovement({
              store,
              tenantId,
              movementId: movement.id,
              allocations: targets.map((e) => ({ expectationId: e.id })),
              note: s.note,
            })
          }
        } catch (err) {
          if (!(err instanceof ConstraintError || err instanceof ValidationError)) throw err
        }
        break
      }
    }
  }
  while ((await settle(100)).processed > 0);
  return delivered
}

/**
 * Normalisation against real Horizon records captured from the public
 * network (fixtures/horizon/pubnet). A handful of cases could not be found
 * live in reasonable time; those are built by editing a real record and are
 * marked "constructed".
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { HorizonEffect, HorizonOperation, HorizonTransaction, NewMovement } from '../src/index.js'
import { NATIVE, asset, normalizeEffects, normalizeFee, signedAmount } from '../src/index.js'

interface OperationFixture {
  readonly operation: HorizonOperation
  readonly effects: HorizonEffect[]
}

const dir = new URL('../../../fixtures/horizon/pubnet/', import.meta.url)
const load = (name: string): OperationFixture =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`${name}.json`, dir)), 'utf8')) as OperationFixture
const transactions = JSON.parse(
  readFileSync(fileURLToPath(new URL('transactions-for-fees.json', dir)), 'utf8'),
).transactions as Record<'tx-normal' | 'tx-fee-bump' | 'tx-failed', HorizonTransaction>

const ctx = (account: string) => ({ tenantId: 't', network: 'public', source: 'horizon', account })
const ops = (f: OperationFixture) => new Map([[f.operation.id, f.operation]])

/** Normalise a fixture from one account's point of view. */
function forAccount(f: OperationFixture, account: string, enriched = true): NewMovement[] {
  return normalizeEffects(f.effects, enriched ? ops(f) : new Map(), ctx(account))
}

const net = (movements: NewMovement[]) =>
  movements.reduce((acc, m) => acc + signedAmount(m).raw, 0n)

const summary = (m: NewMovement) => ({
  direction: m.direction,
  kind: m.kind,
  amount: m.amount.toString(),
  asset: m.amount.asset,
  counterparty: m.counterparty,
})

const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')

describe('normalizeEffects: payments', () => {
  it('records both sides of a payment, enriched from the joined transaction', () => {
    const f = load('payment-text-memo')
    const [credit] = forAccount(f, f.operation.to!)
    expect(credit).toMatchObject({
      direction: 'credit',
      kind: 'transfer',
      counterparty: f.operation.from,
      memo: { type: 'text', value: '' },
      txHash: f.operation.transaction_hash,
      ledger: 64798891,
      operationId: f.operation.id,
      externalId: f.effects[0]!.id,
      enrichment: 'complete',
    })
    const [debit] = forAccount(f, f.operation.from!)
    expect(debit).toMatchObject({ direction: 'debit', counterparty: f.operation.to })
    expect(debit!.amount.equals(credit!.amount)).toBe(true)
  })

  it('carries the muxed id of an M... destination', () => {
    const f = load('payment-muxed-destination')
    const [credit] = forAccount(f, 'GBWUWAQ26NG72VHQAM73A2FF7KRJ4HXUDHW556D2UEUGAVPMWDRBJINQ')
    expect(credit!.muxedId).toBe(15266350798n)
    expect(credit!.amount.asset).toBe(USDC)
    const [debit] = forAccount(f, f.operation.from!)
    expect(debit!.muxedId).toBeNull()
  })

  it('decodes id memos to bigint and hash memos from base64 to hex', () => {
    const id = load('payment-id-memo')
    expect(forAccount(id, id.operation.from!)[0]!.memo).toEqual({ type: 'id', value: 0n })
    const hash = load('payment-hash-memo')
    const expected = Buffer.from(hash.operation.transaction!.memo!, 'base64').toString('hex')
    expect(forAccount(hash, hash.operation.to!)[0]!.memo).toEqual({ type: 'hash', value: expected })
    expect(expected).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records a self-payment as a credit and a debit that net to zero', () => {
    const f = load('payment-id-memo')
    const movements = forAccount(f, f.operation.from!)
    expect(movements.map((m) => m.direction).sort()).toEqual(['credit', 'debit'])
    expect(net(movements)).toBe(0n)
  })

  it('classifies a payment out of its issuer as a mint on both sides', () => {
    const f = load('payment-hash-memo')
    expect(f.operation.from).toBe(f.operation.transaction!.source_account)
    expect(forAccount(f, f.operation.to!)[0]!.kind).toBe('mint')
    expect(forAccount(f, f.operation.from!)[0]!.kind).toBe('mint')
  })
})

describe('normalizeEffects: path payments and trades', () => {
  it('ignores the hop trades of a path payment source, so nothing is double-counted', () => {
    const f = load('path-payment-strict-send-orderbook')
    const source = f.operation.from!
    const movements = forAccount(f, source)
    expect(movements.map(summary)).toEqual([
      { direction: 'credit', kind: 'transfer', amount: '0.0927231', asset: NATIVE, counterparty: source },
      { direction: 'debit', kind: 'transfer', amount: expect.any(String), asset: USDC, counterparty: source },
    ])
  })

  it('counts the trade for a maker whose offer a path payment crossed', () => {
    const f = load('path-payment-strict-send-orderbook')
    const makerEffect = f.effects.find((e) => e.type === 'trade' && e.account !== f.operation.from)!
    const movements = forAccount(f, makerEffect.account)
    expect(movements.map((m) => [m.direction, m.amount.toString(), m.counterparty])).toEqual([
      ['debit', makerEffect.sold_amount, f.operation.from],
      ['credit', makerEffect.bought_amount, f.operation.from],
    ])
    expect(movements.map((m) => m.externalId)).toEqual([`${makerEffect.id}:sold`, `${makerEffect.id}:bought`])
  })

  it('nets an arbitrage path payment to exactly what the account gained', () => {
    const f = load('path-payment-strict-receive')
    const movements = forAccount(f, f.operation.from!)
    expect(movements).toHaveLength(2)
    expect(net(movements)).toBe(6n) // 0.6355938 in, 0.6355932 out
  })

  it('records both sides of a crossed offer, which has no credit or debit effects', () => {
    const f = load('manage-offer-crossed')
    expect(f.effects.every((e) => e.type === 'trade')).toBe(true)
    const [takerEffect, makerEffect] = f.effects as [HorizonEffect, HorizonEffect]
    const taker = forAccount(f, takerEffect.account)
    const maker = forAccount(f, makerEffect.account)
    expect(taker).toHaveLength(2)
    expect(maker).toHaveLength(2)
    // What one side sold, the other bought.
    expect(taker[0]!.amount.equals(maker[1]!.amount)).toBe(true)
    expect(taker[1]!.amount.equals(maker[0]!.amount)).toBe(true)
    expect(taker[0]!.counterparty).toBe(makerEffect.account)
  })

  it("reads liquidity_pool_trade from the pool's perspective (constructed)", () => {
    // A taker crossing a pool via an offer: no debit in the op, so the trade
    // counts. Live records confirm `sold` is what the pool gave the taker.
    const f = load('manage-offer-crossed')
    const taker = f.effects[0]!.account
    const effect: HorizonEffect = {
      ...f.effects[0]!,
      type: 'liquidity_pool_trade',
      sold: { asset: 'native', amount: '2.0000000' },
      bought: { asset: USDC, amount: '1.0000000' },
    }
    const movements = normalizeEffects([effect], ops(f), ctx(taker))
    expect(movements.map(summary)).toEqual([
      { direction: 'debit', kind: 'transfer', amount: '1.0000000', asset: USDC, counterparty: null },
      { direction: 'credit', kind: 'transfer', amount: '2.0000000', asset: NATIVE, counterparty: null },
    ])
  })
})

describe('normalizeEffects: accounts, balances and contracts', () => {
  it('produces nothing for zero-amount effects, which exist on sponsored account creation', () => {
    const f = load('create-account')
    expect(f.effects.find((e) => e.type === 'account_created')!.starting_balance).toBe('0.0000000')
    expect(forAccount(f, f.operation.account!)).toEqual([])
    expect(forAccount(f, f.operation.funder!)).toEqual([])
  })

  it('credits a starting balance from account_created', () => {
    const f = load('create-account-funded')
    const created = f.effects.find((e) => e.type === 'account_created')!
    expect(created.starting_balance).not.toBe('0.0000000')
    const [credit] = forAccount(f, f.operation.account!)
    expect(summary(credit!)).toEqual({
      direction: 'credit',
      kind: 'transfer',
      amount: created.starting_balance,
      asset: NATIVE,
      counterparty: f.operation.funder,
    })
  })

  it('does not double-count account_created alongside account_credited (constructed: CAP-73)', () => {
    const f = load('create-account')
    const created = f.effects.find((e) => e.type === 'account_created')!
    const effects: HorizonEffect[] = [
      { ...created, starting_balance: '5.0000000' },
      { ...created, id: `${created.id}x`, type: 'account_credited', asset_type: 'native', amount: '5.0000000' },
    ]
    const movements = normalizeEffects(effects, new Map(), ctx(created.account))
    expect(movements).toHaveLength(1)
    expect(net(movements)).toBe(50_000_000n)
  })

  it('records an account merge on both sides with the right counterparties', () => {
    const f = load('account-merge')
    expect(forAccount(f, f.operation.account!)[0]).toMatchObject({ direction: 'debit', counterparty: f.operation.into })
    expect(forAccount(f, f.operation.into!)[0]).toMatchObject({ direction: 'credit', counterparty: f.operation.account })
  })

  it('records creating and claiming a claimable balance', () => {
    const created = load('create-claimable-balance')
    expect(forAccount(created, created.operation.source_account).map(summary)).toEqual([
      expect.objectContaining({ direction: 'debit', amount: '11.6211486', counterparty: null }),
    ])
    const claimed = load('claim-claimable-balance')
    const [credit] = forAccount(claimed, claimed.operation.source_account)
    expect(credit).toMatchObject({ direction: 'credit', memo: { type: 'text', value: '🎣 spam claimed' } })
  })

  it('debits and credits each reserve on pool deposit and withdrawal', () => {
    const deposit = load('liquidity-pool-deposit')
    expect(forAccount(deposit, deposit.operation.source_account).map((m) => [m.direction, m.amount.toString()])).toEqual([
      ['debit', '18.0312298'],
      ['debit', '448.5350624'],
    ])
    const withdraw = load('liquidity-pool-withdraw')
    expect(forAccount(withdraw, withdraw.operation.source_account).map((m) => m.direction)).toEqual(['credit', 'credit'])
  })

  it('credits a SAC transfer to a G account, naming the contract it came from', () => {
    const f = load('sac-transfer-to-account')
    const recipient = 'GCO3COSJ33VT2Y6FFAMCC36GJTO5UB63ADHGYFBWGQWXSMRXNILUEPWA'
    const [credit] = forAccount(f, recipient)
    expect(summary(credit!)).toEqual({
      direction: 'credit',
      kind: 'transfer',
      amount: '227.7158700',
      asset: USDC,
      counterparty: 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T',
    })
  })

  it("ignores contract_* effects, which are filed under the invoker, not the invoker's balance", () => {
    const f = load('sac-transfer-to-account')
    expect(f.effects.filter((e) => e.account === f.operation.source_account).map((e) => e.type)).toEqual([
      'contract_debited',
      'contract_credited',
      'contract_debited',
    ])
    expect(forAccount(f, f.operation.source_account)).toEqual([])
  })

  it('classifies a clawback on both sides (constructed)', () => {
    const f = load('payment-text-memo')
    const issuer = f.effects[0]!.asset_issuer!
    const victim = f.operation.to!
    const op: HorizonOperation = { ...f.operation, type: 'clawback', source_account: issuer, from: victim }
    const effects = f.effects.map((e) => ({ ...e, account: e.type === 'account_credited' ? issuer : victim }))
    const credit = normalizeEffects(effects, new Map([[op.id, op]]), ctx(issuer))
    const debit = normalizeEffects(effects, new Map([[op.id, op]]), ctx(victim))
    expect(credit[0]).toMatchObject({ kind: 'clawback', counterparty: victim })
    expect(debit[0]).toMatchObject({ kind: 'clawback', counterparty: issuer })
  })
})

describe('normalizeEffects: missing enrichment', () => {
  it('still records the movement, with the ledger recovered from the operation id', () => {
    const f = load('payment-muxed-destination')
    const [credit] = forAccount(f, 'GBWUWAQ26NG72VHQAM73A2FF7KRJ4HXUDHW556D2UEUGAVPMWDRBJINQ', false)
    expect(credit).toMatchObject({
      enrichment: 'missing',
      txHash: null,
      memo: null,
      counterparty: null,
      ledger: f.operation.transaction!.ledger,
      muxedId: 15266350798n,
    })
  })

  it('emits unique external ids across every fixture', () => {
    const all = [
      'payment-text-memo',
      'path-payment-strict-send-orderbook',
      'path-payment-strict-receive',
      'manage-offer-crossed',
      'liquidity-pool-deposit',
    ].flatMap((name) => {
      const f = load(name)
      return [...new Set(f.effects.map((e) => e.account))].flatMap((a) => forAccount(f, a))
    })
    expect(new Set(all.map((m) => `${m.account}/${m.externalId}`)).size).toBe(all.length)
  })
})

describe('normalizeFee', () => {
  it('charges the fee to the fee account', () => {
    const tx = transactions['tx-normal']
    expect(normalizeFee(tx, ctx(tx.fee_account))).toMatchObject({
      direction: 'debit',
      kind: 'fee',
      externalId: `${tx.hash}:fee`,
      txHash: tx.hash,
      operationId: null,
      ledger: tx.ledger,
    })
    expect(normalizeFee(tx, ctx(tx.fee_account))!.amount.raw).toBe(100n)
  })

  it('charges a fee-bump to the outer fee payer, not the inner source', () => {
    const tx = transactions['tx-fee-bump']
    expect(tx.fee_account).not.toBe(tx.source_account)
    expect(normalizeFee(tx, ctx(tx.fee_account))!.amount.raw).toBe(18_461n)
    expect(normalizeFee(tx, ctx(tx.source_account))).toBeNull()
  })

  it('charges the fee of a failed transaction', () => {
    const tx = transactions['tx-failed']
    expect(tx.successful).toBe(false)
    expect(normalizeFee(tx, ctx(tx.fee_account))!.amount.raw).toBe(13_844n)
  })
})

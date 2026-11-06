/**
 * An in-memory Horizon with the real paging semantics: strictly-after
 * cursors, asc/desc order, and 404 for an account it has never seen. It
 * serves the feeds the Horizon sources read, so tests can run them offline.
 */
import { expect } from 'vitest'
import type { HorizonAccount, HorizonEffect, HorizonOperation, HorizonTransaction } from '@nostro-labs/nostro'
import { HorizonClient } from '@nostro-labs/nostro'

/** A TOID for operation `op` of the first transaction in `ledger`. */
export const toid = (ledger: number, op: number): string =>
  ((BigInt(ledger) << 32n) | (1n << 12n) | BigInt(op)).toString()

/** A 64-hex-digit transaction hash derived from `n`. */
export const hash = (n: number): string => n.toString(16).padStart(64, '0')

/** Order Horizon paging tokens: `<toid>-<order>`, or a bare toid meaning "after all of it". */
function position(token: string): [bigint, number] {
  const [op, order] = token.split('-')
  return [BigInt(op!), order === undefined ? Number.POSITIVE_INFINITY : Number(order)]
}
const after = (a: string, b: string) => {
  const [ao, an] = position(a)
  const [bo, bn] = position(b)
  return ao > bo || (ao === bo && an > bn)
}

export interface PaymentOptions {
  /** Whether the account operations feed lists it for both sides. Default true. */
  readonly listed?: boolean
  /** Non-value effects to add on the receiving side. Default 0. */
  readonly extra?: number
  /** The text memo. Default `INV-<ledger>`. */
  readonly memo?: string
}

export class FakeHorizon {
  effects: HorizonEffect[] = []
  operations = new Map<string, HorizonOperation>()
  /** Which accounts' operations feed lists each operation. */
  participants = new Map<string, Set<string>>()
  transactions: (HorizonTransaction & { participants: string[] })[] = []
  /** Account entries served at `/accounts/{id}`, with `Latest-Ledger`. */
  accounts = new Map<string, HorizonAccount>()
  latestLedger = 1
  gone = new Set<string>()
  requests: URL[] = []

  readonly fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    this.requests.push(url)
    const q = url.searchParams
    const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers })
    const notFound = () => respond({ type: 'https://stellar.org/horizon-errors/not_found', status: 404 }, 404)
    const page = <R extends { paging_token: string }>(all: R[]) => {
      const desc = q.get('order') === 'desc'
      const cursor = q.get('cursor')
      let rows = [...all].sort((x, y) => (after(x.paging_token, y.paging_token) ? 1 : -1))
      if (desc) rows.reverse()
      if (cursor !== null) rows = rows.filter((r) => (desc ? after(cursor, r.paging_token) : after(r.paging_token, cursor)))
      return respond({ _embedded: { records: rows.slice(0, Number(q.get('limit') ?? 10)) } })
    }
    const known = (account: string) =>
      this.effects.some((e) => e.account === account) || this.transactions.some((t) => t.participants.includes(account))

    let m: RegExpMatchArray | null
    if ((m = url.pathname.match(/^\/accounts\/(\w+)$/))) {
      const entry = this.accounts.get(m[1]!)
      return entry === undefined ? notFound() : respond(entry, 200, { 'latest-ledger': String(this.latestLedger) })
    }
    if ((m = url.pathname.match(/^\/accounts\/(\w+)\/effects$/))) {
      return known(m[1]!) ? page(this.effects.filter((e) => e.account === m![1])) : notFound()
    }
    if ((m = url.pathname.match(/^\/accounts\/(\w+)\/operations$/))) {
      expect(q.get('join')).toBe('transactions')
      return page([...this.operations.values()].filter((o) => this.participants.get(o.id)?.has(m![1]!)))
    }
    if ((m = url.pathname.match(/^\/operations\/(\d+)$/))) {
      const op = this.operations.get(m[1]!)
      return op === undefined || this.gone.has(op.id) ? notFound() : respond(op)
    }
    if ((m = url.pathname.match(/^\/accounts\/(\w+)\/transactions$/))) {
      if (!known(m[1]!)) return notFound()
      const failed = q.get('include_failed') === 'true'
      return page(this.transactions.filter((t) => t.participants.includes(m![1]!) && (failed || t.successful)))
    }
    throw new Error(`unrouted ${url.pathname}`)
  }) as typeof globalThis.fetch

  client(): HorizonClient {
    return new HorizonClient({ url: 'https://horizon.test', fetch: this.fetch, retries: 0 })
  }

  /**
   * Add a native payment from `from` to `to` in `ledger`, paid for by
   * `from` (a 100-stroop fee). Returns the operation id.
   */
  payment(ledger: number, from: string, to: string, amount: string, options: PaymentOptions = {}): string {
    const { listed = true, extra = 0, memo = `INV-${ledger}` } = options
    const id = toid(ledger, 1)
    const tx: HorizonTransaction = {
      hash: hash(ledger),
      paging_token: (BigInt(id) - 1n).toString(),
      ledger,
      created_at: '2026-10-06T00:00:00Z',
      successful: true,
      source_account: from,
      fee_account: from,
      fee_charged: '100',
      memo_type: 'text',
      memo,
    }
    this.operations.set(id, {
      id,
      paging_token: id,
      type: 'payment',
      source_account: from,
      transaction_hash: tx.hash,
      transaction: tx,
      from,
      to,
    })
    this.participants.set(id, new Set(listed ? [from, to] : [from]))
    const effect = (order: number, account: string, type: string, rest: Partial<HorizonEffect> = {}): HorizonEffect => ({
      id: `${id.padStart(19, '0')}-${String(order).padStart(10, '0')}`,
      paging_token: `${id}-${order}`,
      account,
      type,
      created_at: tx.created_at,
      ...rest,
    })
    this.effects.push(effect(1, to, 'account_credited', { asset_type: 'native', amount }))
    for (let i = 0; i < extra; i++) this.effects.push(effect(2 + i, to, 'signer_created'))
    this.effects.push(effect(2 + extra, from, 'account_debited', { asset_type: 'native', amount }))
    this.transactions.push({ ...tx, participants: [from, to] })
    this.latestLedger = Math.max(this.latestLedger, ledger)
    return id
  }
}

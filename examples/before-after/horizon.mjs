// A small simulated Horizon. Its records have the shape of real responses
// (see fixtures/horizon in the repository, captured from pubnet), including
// what real Horizon does and does not put on /payments: a SAC transfer is
// there with no top-level amount, and a claimable balance claim is not there.

const RAW = 10_000_000n
const toRaw = (v) => {
  const [whole, fraction = ''] = v.split('.')
  return BigInt(whole) * RAW + BigInt(fraction.padEnd(7, '0'))
}
const fromRaw = (n) => `${n / RAW}.${String(n % RAW).padStart(7, '0')}`
const PAYMENT_TYPES = new Set(['payment', 'create_account', 'invoke_host_function'])

export class SimulatedHorizon {
  url = 'https://horizon.example'
  #account
  #payer
  #ledger = 100
  #operations = []
  #effects = []
  #balances = new Map()
  #failIn = 0

  constructor(account, payer) {
    this.#account = account
    this.#payer = payer
    this.#record('create_account', { asset: null, amount: '100', memo: null })
  }

  /** The nth request from now fails once, as a real one does. */
  failRequest(n) {
    this.#failIn = n
  }

  payment({ asset, amount, memo }) {
    this.#record('payment', { asset, amount, memo })
  }

  /** A SAC `transfer`, here with no memo: on /payments, but with no top-level amount. */
  sacTransfer({ asset, amount }) {
    this.#record('invoke_host_function', { asset, amount, memo: null })
  }

  /** A claimable balance being claimed: the money arrives, and /payments never says so. */
  claim({ asset, amount }) {
    this.#record('claim_claimable_balance', { asset, amount, memo: null })
  }

  #record(type, { asset, amount, memo }) {
    const ledger = ++this.#ledger
    const id = ((BigInt(ledger) << 32n) | 4097n).toString()
    const fields = asset === null ? { asset_type: 'native' } : { asset_type: 'credit_alphanum4', asset_code: asset.code, asset_issuer: asset.issuer }
    const created_at = new Date().toISOString()
    const transaction = {
      hash: ledger.toString(16).padStart(64, '0'),
      paging_token: (BigInt(id) - 1n).toString(),
      ledger,
      created_at,
      successful: true,
      source_account: this.#payer,
      fee_account: this.#payer,
      fee_charged: '100',
      memo_type: memo === null ? 'none' : 'text',
      ...(memo === null ? {} : { memo }),
    }
    const common = { id, paging_token: id, type, source_account: this.#payer, transaction_hash: transaction.hash, created_at, transaction }
    const shapes = {
      create_account: { account: this.#account, funder: this.#payer, starting_balance: amount },
      payment: { from: this.#payer, to: this.#account, amount, ...fields },
      invoke_host_function: { asset_balance_changes: [{ ...fields, type: 'transfer', from: this.#payer, to: this.#account, amount }] },
      claim_claimable_balance: { balance_id: transaction.hash, claimant: this.#account },
    }
    this.#operations.push({ ...common, ...shapes[type] })
    const effect = (order, kind, rest) => ({ id: `${id}-${order}`, paging_token: `${id}-${order}`, account: this.#account, type: kind, created_at, ...rest })
    this.#effects.push(
      type === 'create_account' ? effect(1, 'account_created', { starting_balance: amount }) : effect(1, 'account_credited', { ...fields, amount }),
    )
    const key = asset === null ? 'native' : `${asset.code}:${asset.issuer}`
    this.#balances.set(key, { raw: (this.#balances.get(key)?.raw ?? 0n) + toRaw(amount), ledger, fields })
  }

  fetch = async (input) => {
    const url = new URL(String(input))
    if (this.#failIn > 0 && --this.#failIn === 0) return json({ type: 'https://stellar.org/horizon-errors/server_error', status: 503, title: 'Service Unavailable' }, 503)
    const q = url.searchParams
    const page = (records) => {
      const cursor = q.get('cursor')
      const rank = (token) => {
        const [op, order] = token.split('-')
        return [BigInt(op), order === undefined ? Number.MAX_SAFE_INTEGER : Number(order)]
      }
      const after = (a, b) => {
        const [x, y] = [rank(a), rank(b)]
        return x[0] > y[0] || (x[0] === y[0] && x[1] > y[1])
      }
      const rows = q.get('order') === 'desc' ? [...records].reverse() : records
      const from = cursor ? rows.filter((r) => (q.get('order') === 'desc' ? after(cursor, r.paging_token) : after(r.paging_token, cursor))) : rows
      return json({ _embedded: { records: from.slice(0, Number(q.get('limit') ?? 10)) } })
    }
    const path = url.pathname
    if (path.endsWith('/payments')) return page(this.#operations.filter((o) => PAYMENT_TYPES.has(o.type)).map(({ transaction: _, ...o }) => o))
    if (path.endsWith('/effects')) return page(this.#effects)
    if (path.endsWith('/operations')) return page(this.#operations)
    if (path.endsWith('/transactions')) return page(this.#operations.map((o) => o.transaction))
    let m
    if ((m = path.match(/^\/transactions\/(\w+)$/))) return json(this.#operations.find((o) => o.transaction.hash === m[1]).transaction)
    if ((m = path.match(/^\/operations\/(\d+)$/))) return json(this.#operations.find((o) => o.id === m[1]))
    if (path === `/accounts/${this.#account}`) {
      const balances = [...this.#balances.values()].map((b) => ({
        balance: fromRaw(b.raw),
        ...b.fields,
        ...(b.fields.asset_type === 'native' ? {} : { last_modified_ledger: b.ledger }),
      }))
      return json({ id: this.#account, last_modified_ledger: this.#balances.get('native').ledger, balances }, 200, { 'latest-ledger': String(this.#ledger) })
    }
    return json({ status: 404 }, 404)
  }
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })

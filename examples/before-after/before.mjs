// A careful hand-rolled payment watcher: the kind of code nostro replaces.
//
// This is deliberately not a strawman. It keeps its cursor, adds up partial
// payments and finds the invoice from the memo. Each thing it gets wrong
// could be fixed; the point of the comparison is how many there are.

export function createWatcher({ fetch, horizon, account, invoices }) {
  const paid = new Map(invoices.map((i) => [i.reference, 0]))
  let cursor = ''

  const get = async (path) => {
    const res = await fetch(`${horizon}${path}`)
    if (!res.ok) throw new Error(`Horizon answered ${res.status}`)
    return res.json()
  }

  async function poll() {
    const page = await get(`/accounts/${account}/payments?order=asc&limit=200&cursor=${cursor}`)
    const records = page._embedded.records
    for (const op of records) {
      if (op.type !== 'payment') continue
      const tx = await get(`/transactions/${op.transaction_hash}`)
      const invoice = invoices.find((i) => i.reference === tx.memo)
      if (invoice === undefined || op.asset_code !== invoice.code) continue
      paid.set(invoice.reference, paid.get(invoice.reference) + parseFloat(op.amount))
    }
    if (records.length > 0) cursor = records.at(-1).paging_token
  }

  return {
    // On a timer, in real life. A failed poll is retried, as it would be next tick.
    async catchUp() {
      try {
        await poll()
      } catch {
        await poll()
      }
    },
    report(reference) {
      const invoice = invoices.find((i) => i.reference === reference)
      return { paid: paid.get(reference) >= parseFloat(invoice.owed), flagged: false }
    },
  }
}

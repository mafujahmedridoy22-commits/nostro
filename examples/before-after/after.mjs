// The same job with nostro. MemoryStore stands in for nostro-store-postgres
// or nostro-store-sqlite here, so that this runs with nothing installed.
import {
  HorizonBalanceSource,
  HorizonClient,
  HorizonEffectsSource,
  HorizonFeesSource,
  MemoryStore,
  Money,
  asset,
  decideException,
  doctor,
  reconcile,
  sync,
} from 'nostro'

export async function createNostro({ fetch, horizon, account, invoices }) {
  const tenantId = 'acme'
  const network = 'testnet'
  const store = new MemoryStore()
  // No retries, so that a failed request reaches sync() rather than being absorbed by the client.
  const client = new HorizonClient({ url: horizon, fetch, retries: 0 })
  const sources = [new HorizonEffectsSource({ client, network }), new HorizonFeesSource({ client, network })]

  for (const { reference, owed, code, issuer } of invoices) {
    await store.transaction((tx) =>
      tx.insertExpectation({ tenantId, reference, account, amount: Money.parse(owed, asset(code, issuer)) }),
    )
  }

  return {
    store,
    async catchUp() {
      for (const source of sources) {
        // sync() commits each batch with its cursor, so running it again after a failure is always safe.
        for (;;) {
          const { accounts } = await sync({ store, source, tenantId, accounts: [account] })
          if (accounts[0].caughtUp && accounts[0].error === null) break
        }
      }
      while ((await reconcile({ store, tenantId })).processed > 0);
    },
    async report(reference) {
      const invoice = await store.getExpectationByReference(tenantId, reference)
      const open = []
      for (const x of await store.listExceptions({ tenantId, status: 'open' })) {
        const movement = await store.getMovement(tenantId, x.movementId)
        const about =
          x.expectationId === invoice.id ||
          movement.memo?.value === reference ||
          x.evidence?.candidates?.some((c) => c.reference === reference)
        if (about) open.push(x)
      }
      return { paid: invoice.status === 'settled', flagged: open.length > 0, status: invoice.status, codes: open.map((x) => x.code), exceptions: open }
    },
    // What a person does about one.
    decide: (exceptionId, decision) => decideException({ store, tenantId, exceptionId, decision }),
    // The check nothing hand-rolled has: do the books add up to what the chain says?
    check: () =>
      doctor({
        store,
        tenantId,
        attest: { balances: new HorizonBalanceSource({ client, network }), sources, accounts: [account] },
      }),
  }
}

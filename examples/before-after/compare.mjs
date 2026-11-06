// Run a careful hand-rolled watcher and nostro over the same payments, and
// compare what each concludes. `node compare.mjs`; exits 1 if nostro gets
// anything wrong, so this cannot quietly go out of date.
import { createNostro } from './after.mjs'
import { createWatcher } from './before.mjs'
import { SimulatedHorizon } from './horizon.mjs'

const ACCOUNT = `G${'A'.repeat(55)}`
const PAYER = `G${'B'.repeat(55)}`
const USDC = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' }
const LOOKALIKE = { code: 'USDC', issuer: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW' }

// `paid`: is it truly paid in full? `flagged`: is there something a person needs to look at?
const CASES = [
  { reference: 'INV-1', owed: '25', paid: true, flagged: false, what: 'Paid in full' },
  { reference: 'INV-2', owed: '40', paid: false, flagged: true, what: 'Paid in a lookalike USDC, from another issuer' },
  { reference: 'INV-3', owed: '11', paid: false, flagged: true, what: 'Paid through a SAC transfer, with no memo' },
  { reference: 'INV-4', owed: '30', paid: false, flagged: true, what: 'Paid by a claimable balance being claimed' },
  { reference: 'INV-5', owed: '50', paid: true, flagged: false, what: 'Paid in two parts, 20 and 30' },
  { reference: 'INV-6', owed: '0.8', paid: true, flagged: false, what: 'Paid in two parts, 0.1 and 0.7' },
  { reference: 'INV-7', owed: '15', paid: true, flagged: true, what: 'Overpaid: 20 sent, 15 owed' },
  { reference: 'INV-8', owed: '5', paid: true, flagged: true, what: 'Paid twice' },
  { reference: 'INV-9', owed: '21', paid: false, flagged: false, what: 'Half paid, during a failed request' },
  { reference: 'INV-10', owed: '3', paid: true, flagged: false, what: 'Paid in full, during a failed request' },
]
const invoices = CASES.map(({ reference, owed }) => ({ reference, owed, ...USDC }))

const steps = [
  (h) => {
    h.payment({ asset: USDC, amount: '25', memo: 'INV-1' })
    h.payment({ asset: LOOKALIKE, amount: '40', memo: 'INV-2' })
    h.sacTransfer({ asset: USDC, amount: '11' })
    h.claim({ asset: USDC, amount: '30' })
    h.payment({ asset: USDC, amount: '20', memo: 'INV-5' })
    h.payment({ asset: USDC, amount: '30', memo: 'INV-5' })
    h.payment({ asset: USDC, amount: '0.1', memo: 'INV-6' })
    h.payment({ asset: USDC, amount: '0.7', memo: 'INV-6' })
    h.payment({ asset: USDC, amount: '20', memo: 'INV-7' })
    h.payment({ asset: USDC, amount: '5', memo: 'INV-8' })
    h.payment({ asset: USDC, amount: '5', memo: 'INV-8' })
  },
  (h, failAt) => {
    // One request of this round fails: a blip, and a retry on the next tick.
    h.payment({ asset: USDC, amount: '10.5', memo: 'INV-9' })
    h.payment({ asset: USDC, amount: '3', memo: 'INV-10' })
    h.failRequest(failAt)
  },
]

async function run(create, failAt) {
  const h = new SimulatedHorizon(ACCOUNT, PAYER)
  const it = await create({ fetch: h.fetch, horizon: h.url, account: ACCOUNT, invoices })
  for (const step of steps) {
    step(h, failAt)
    await it.catchUp()
  }
  return it
}

// The third request is the one that hurts the watcher: after it has counted one payment, before it
// has saved its cursor. The summary below tries every position, so this is not the only result shown.
const watcher = await run(createWatcher, 3)
const nostro = await run(createNostro, 3)

const describeIt = ({ paid, flagged, status, codes }) =>
  `${status ?? (paid ? 'paid' : 'not paid')}${flagged ? `, flagged ${codes.join(', ')}` : ''}`
const right = (c, r) => c.paid === r.paid && c.flagged === r.flagged

const rows = [['INVOICE', 'WHAT HAPPENED', 'HAND-ROLLED', 'NOSTRO']]
const score = { watcher: 0, nostro: 0 }
for (const c of CASES) {
  const [before, after] = [watcher.report(c.reference), await nostro.report(c.reference)]
  score.watcher += right(c, before) ? 1 : 0
  score.nostro += right(c, after) ? 1 : 0
  rows.push([
    c.reference,
    c.what,
    `${right(c, before) ? 'ok   ' : 'WRONG'} ${describeIt(before)}`,
    `${right(c, after) ? 'ok   ' : 'WRONG'} ${describeIt(after)}`,
  ])
}
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
for (const r of rows) console.log(r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd())

console.log(`\nHand-rolled: ${score.watcher} of ${CASES.length} right. nostro: ${score.nostro} of ${CASES.length}.`)

// The same comparison with the failure at each request of that round, in turn.
const POSITIONS = [1, 2, 3, 4, 5, 6]
const scores = { watcher: [], nostro: [] }
for (const failAt of POSITIONS) {
  const [w, n] = [await run(createWatcher, failAt), await run(createNostro, failAt)]
  const count = async (it) => {
    let ok = 0
    for (const c of CASES) if (right(c, await it.report(c.reference))) ok += 1
    return ok
  }
  scores.watcher.push(await count(w))
  scores.nostro.push(await count(n))
}
console.log(`With the failure at each of the first ${POSITIONS.length} requests instead: hand-rolled ${scores.watcher.join(', ')}; nostro ${scores.nostro.join(', ')}.`)

const report = await nostro.check()
const checks = report.balances.map((b) => `${b.asset === 'native' ? 'XLM' : b.asset.slice(0, 9)}: ${b.status}`)
console.log(`\nnostro against the chain, as of the ledger each balance last changed in: ${checks.join(', ')}.`)
console.log(`Invariants: ${report.ok ? 'all hold' : 'BROKEN'}. The hand-rolled watcher has nothing to compare with.`)

// The two it could not settle alone wait for a person, who now says what they were.
const inv3 = await nostro.report('INV-3')
const decided = await nostro.decide(inv3.exceptions[0].id, {
  action: 'apply',
  allocations: [{ reference: 'INV-3' }],
  note: 'the customer confirmed the transfer',
})
const after3 = await nostro.report('INV-3')
console.log(`\nA person applies the SAC transfer to INV-3: it is now ${after3.status}, with a ${decided.journalEntry.kind} entry in the journal.`)

const everyPosition = scores.nostro.every((n) => n === CASES.length)
process.exit(score.nostro === CASES.length && everyPosition && report.ok && after3.status === 'settled' ? 0 : 1)

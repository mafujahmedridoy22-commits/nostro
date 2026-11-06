import type { DoctorOptions, DoctorReport, Finding } from '@nostro-labs/nostro'
import { HorizonBalanceSource, doctor as runDoctor } from '@nostro-labs/nostro'
import { COMMON, NETWORK, UsageError, accounts, flag, integer, network, positionals, strings, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, NETWORK_HELP, horizonClient, movementSources, withStore } from '../command.js'
import { assetLabel, when } from '../format.js'
import { json, table, write } from '../io.js'

function where(f: Finding): string {
  if (f.movementId !== null) return `movement ${f.movementId}`
  if (f.entryId !== null) return `entry ${f.entryId}`
  if (f.account !== null) return `${f.account}${f.asset === null ? '' : ` ${assetLabel(f.asset)}`}`
  return f.asset === null ? '' : assetLabel(f.asset)
}

function reportJson(r: DoctorReport) {
  return {
    ok: r.ok,
    findings: r.findings,
    movements: r.movements,
    journal: {
      entries: r.journal.entries,
      totals: r.journal.totals.map((t) => ({ asset: t.asset, debits: t.debits.toString(), credits: t.credits.toString() })),
    },
    balances:
      r.balances === null
        ? null
        : r.balances.map((c) => ({ ...c, chain: c.chain.toString(), recorded: c.recorded.toString() })),
  }
}

function summary(r: DoctorReport, attested: boolean): string {
  const { total, byDisposition, oldestPending } = r.movements
  const decided = Object.entries(byDisposition)
    .filter(([d, n]) => d !== 'pending' && n > 0)
    .map(([d, n]) => `${d} ${n}`)
  const pending = byDisposition.pending
  const balanced = r.journal.totals.every((t) => t.debits.equals(t.credits))
  const assets = r.journal.totals.length
  const lines = [
    ['movements', `${total}${decided.length === 0 ? '' : ` (${decided.join(', ')})`}`],
    ['pending', pending === 0 ? 'none' : `${pending}, the oldest from ${when(oldestPending)} UTC; run "nostro reconcile"`],
    [
      'journal',
      `${r.journal.entries} entries` +
        (assets === 0 ? '' : balanced ? `, debits equal credits in every asset (${assets})` : ', debits and credits differ'),
    ],
    ['balances', attested ? `checked against the chain for ${new Set(r.balances!.map((c) => c.account)).size} account(s)` : 'not checked; run with --attest'],
  ]
  return table(lines)
}

export const doctor: Command = {
  name: 'doctor',
  summary: 'Check the books against the invariants, and optionally against the chain',
  usage: '[--attest --account <G...>] [options]',
  help: `Checks every movement's disposition (I1) and every journal entry (I3). With --attest it also
compares each account's recorded movements with the balance Horizon reports, per asset, as of the
ledger that balance last changed in (I2); that catches the sources up first, recording any new
movements as sync would. Exits 1 if any invariant does not hold. Warnings, such as a decision not
posted to the journal yet, are listed but do not fail the check.

It reads every record in the tenant, so run it as a batch job, not per request. It is safe to run
while sync and reconcile are running.

Options:
  --attest            Also check balances against the chain, for each --account
${NETWORK_HELP}
  --attempts <n>      Comparisons made before a balance mismatch is reported (default 3, about
                      a ledger apart)
${COMMON_HELP}`,
  options: { ...COMMON, ...NETWORK, attest: { type: 'boolean' }, attempts: { type: 'string' } },
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const attest = flag(args, 'attest')
    if (!attest && strings(args, 'account').length > 0) {
      throw new UsageError('--account is for --attest; without it no balance would be checked.')
    }
    const attempts = integer(args, 'attempts', 3, 1, 100)

    let checks: DoctorOptions['attest']
    if (attest) {
      const net = network(args, io)
      const client = horizonClient(net, io)
      checks = {
        balances: new HorizonBalanceSource({ client, network: net.name }),
        sources: movementSources(client, net),
        accounts: accounts(args, io),
        attempts,
      }
    }
    const report = await withStore(args, io, (store) =>
      runDoctor({ store, tenantId, ...(checks === undefined ? {} : { attest: checks }) }),
    )

    if (flag(args, 'json')) {
      await write(io.stdout, json(reportJson(report)))
      return report.ok ? 0 : 1
    }

    let out = summary(report, attest)
    if (report.balances !== null && report.balances.length > 0) {
      out += `\n${table([
        ['ACCOUNT', 'ASSET', 'CHAIN', 'RECORDED', 'AT LEDGER', 'RESULT'],
        ...report.balances.map((c) => [
          c.account,
          assetLabel(c.asset),
          c.chain.toString(),
          c.recorded.toString(),
          c.ledger === null ? '' : String(c.ledger),
          c.status === 'issuer' ? 'issuer: not attested' : c.status,
        ]),
      ])}`
    }
    if (report.findings.length > 0) {
      out += `\n${table([
        ['SEVERITY', 'INVARIANT', 'CODE', 'WHERE', 'DETAIL'],
        ...report.findings.map((f) => [f.severity, f.invariant, f.code, where(f), f.detail]),
      ])}`
    }
    if (report.findings.some((f) => f.code === 'journal_stale')) {
      out += 'Run "nostro post" to post the decisions the journal does not reflect yet.\n'
    }
    const errors = report.findings.filter((f) => f.severity === 'error').length
    const warnings = report.findings.length - errors
    const held = attest ? 'I1, I2 and I3 hold' : 'I1 and I3 hold; I2 was not checked (run with --attest)'
    out += report.ok
      ? `\nOK: ${held}${warnings === 0 ? '' : `, with ${warnings} warning(s)`}.\n`
      : `\nFAILED: ${errors} error(s)${warnings === 0 ? '' : ` and ${warnings} warning(s)`}. What each means and what to do: https://github.com/nostro-labs/nostro/blob/main/docs/invariants.md\n`
    await write(io.stdout, out)
    return report.ok ? 0 : 1
  },
}

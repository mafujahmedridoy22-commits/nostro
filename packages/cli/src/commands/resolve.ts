import type { ExceptionDecision } from '@nostro-labs/nostro'
import { ConstraintError, NotFoundError, PrecisionError, ValidationError, decideException, resolutionJson } from '@nostro-labs/nostro'
import type { Args } from '../args.js'
import { COMMON, CliError, UsageError, flag, positionals, string, strings, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { assetLabel } from '../format.js'
import { clean, json, write } from '../io.js'

const AMOUNT = /^[0-9]+(\.[0-9]+)?$/

/** `INV-1042` or `INV-1042=2.5`. A reference may itself contain `=`; only a number after the last one is an amount. */
function allocation(spec: string): { reference: string; amount?: string } {
  const at = spec.lastIndexOf('=')
  const amount = spec.slice(at + 1)
  return at > 0 && AMOUNT.test(amount) ? { reference: spec.slice(0, at), amount } : { reference: spec }
}

function decision(args: Args): ExceptionDecision {
  const apply = strings(args, 'apply')
  const ignore = flag(args, 'ignore')
  const close = flag(args, 'close')
  if ((apply.length > 0 ? 1 : 0) + (ignore ? 1 : 0) + (close ? 1 : 0) !== 1) {
    throw new UsageError('Say what to do: one of --apply <reference[=amount]>, --ignore or --close.')
  }
  if (flag(args, 'dismiss') && !close) throw new UsageError('--dismiss only applies with --close.')
  const note = string(args, 'note')
  if (note === undefined || note.trim() === '') throw new UsageError('--note is required: say why, for whoever reads this later.')
  if (ignore) return { action: 'ignore', note }
  if (close) return { action: 'close', status: flag(args, 'dismiss') ? 'dismissed' : 'resolved', note }
  return { action: 'apply', allocations: apply.map(allocation), note }
}

export const resolve: Command = {
  name: 'resolve',
  summary: 'Decide an exception: apply its payment to invoices, ignore it, or close it',
  usage: '<exception-id> (--apply <reference[=amount]>... | --ignore | --close) --note <why> [options]',
  help: `Answers what "nostro exceptions" asks. The movement, its exceptions and the journal change
together, in one transaction, and the journal adjustment leaves cash untouched.

Whatever an application leaves over stays open, under an exception for exactly that amount. The rules
hold for a person too: a lookalike asset, another account's invoice, too much or a cancelled invoice
is refused. An invoice past its expiry can be paid. A movement already decided cannot be changed.

Options:
  --apply <ref[=n]>   This payment was for this invoice; with =amount, for that much of it. Without
                      one: what is left of the payment and still owing. Repeat to split a payment
  --ignore            This is not something to reconcile. What was allocated stays allocated
  --close             The exception is dealt with. Refused if an undecided movement depends on it
  --dismiss           With --close: dismissed, rather than resolved
  --note <why>        Required. Kept with what this closes
${COMMON_HELP}`,
  options: {
    ...COMMON,
    apply: { type: 'string', multiple: true },
    ignore: { type: 'boolean' },
    close: { type: 'boolean' },
    dismiss: { type: 'boolean' },
    note: { type: 'string' },
  },
  async run(args, io) {
    const [exceptionId] = positionals(args, 1)
    if (exceptionId === undefined) throw new UsageError('Give the exception id, from "nostro exceptions".')
    const tenantId = tenant(args, io)
    const what = decision(args)

    const report = await withStore(args, io, async (store) => {
      try {
        return await decideException({ store, tenantId, exceptionId, decision: what })
      } catch (err) {
        if (err instanceof NotFoundError) throw new CliError(`No ${err.entity} ${err.id}.`)
        if (err instanceof ConstraintError) throw new CliError(err.message)
        if (err instanceof ValidationError || err instanceof PrecisionError) throw new UsageError(err.message)
        throw err
      }
    })

    if (flag(args, 'json')) {
      await write(io.stdout, json(resolutionJson(report)))
      return 0
    }
    let out = ''
    if (what.action === 'apply') {
      report.allocations.forEach((a, i) => {
        out += `Applied ${a.amount.toString()} ${assetLabel(a.amount.asset)} to ${clean(what.allocations[i]!.reference)}.\n`
      })
    }
    if (report.movement !== null && what.action !== 'close') out += `Movement ${report.movement.id} is now ${report.movement.disposition}.\n`
    for (const x of report.closed) out += `Exception ${x.id} (${x.code}) is ${x.status}.\n`
    if (report.opened !== null) {
      out += `Still open: ${report.opened.code} for ${report.opened.amount!.toString()} ${assetLabel(report.opened.amount!.asset)} (exception ${report.opened.id}).\n`
    }
    if (report.journalEntry !== null) out += `Posted a ${report.journalEntry.kind} entry to the journal.\n`
    await write(io.stdout, out)
    return 0
  },
}

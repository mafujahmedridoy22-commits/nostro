import type { AssetId, Memo, NewExpectation } from '@nostro-labs/nostro'
import { ConstraintError, Money, NATIVE, ValidationError, isAccountId, parseAsset } from '@nostro-labs/nostro'
import type { Args } from '../args.js'
import { COMMON, CliError, UsageError, date, flag, positionals, string, strings, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { expectationWithPaid, money } from '../format.js'
import { clean, json, write } from '../io.js'

const UINT64 = /^\d{1,20}$/
const UINT64_MAX = (1n << 64n) - 1n

function uint64(args: Args, name: string): bigint | undefined {
  const raw = string(args, name)
  if (raw === undefined) return undefined
  if (!UINT64.test(raw) || BigInt(raw) > UINT64_MAX) throw new UsageError(`--${name} must be a whole number below 2^64.`)
  return BigInt(raw)
}

function assetOf(raw: string): AssetId {
  if (raw === 'native' || raw.toUpperCase() === 'XLM') return NATIVE
  try {
    return parseAsset(raw)
  } catch {
    throw new UsageError(`--asset must be native (or XLM) or CODE:ISSUER, not ${JSON.stringify(raw)}.`)
  }
}

function memoOf(args: Args): Memo | null {
  const text = string(args, 'memo-text')
  const id = uint64(args, 'memo-id')
  if (text !== undefined && id !== undefined) throw new UsageError('Give --memo-text or --memo-id, not both.')
  if (id !== undefined) return { type: 'id', value: id }
  if (text === undefined) return null
  // What the payer is asked to send has to fit in a transaction.
  if (text === '' || Buffer.byteLength(text, 'utf8') > 28) {
    throw new UsageError('--memo-text must be 1 to 28 bytes, the most a Stellar text memo holds.')
  }
  return { type: 'text', value: text }
}

function metadataOf(args: Args): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of strings(args, 'meta')) {
    const at = pair.indexOf('=')
    if (at < 1) throw new UsageError(`--meta must be key=value, not ${JSON.stringify(pair)}.`)
    out[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return out
}

export const expect: Command = {
  name: 'expect',
  summary: 'Record a payment you are owed, or one you will make',
  usage: '<reference> --account <G...> --amount <amount> [options]',
  help: `Records an expectation for reconcile to match payments against. <reference> is yours (an
invoice number, say) and must be unique within the tenant; a payment whose text memo matches it,
normalised, settles it. A muxed id or a memo id is matched exactly and is the stronger signal.

Options:
  --account <G...>    The account the money arrives at (or leaves from, with --debit)
  --amount <amount>   The amount, e.g. 25 or 25.5000000; never rounded
  --asset <asset>     native (or XLM, the default) or CODE:ISSUER
  --debit             Money you will pay out, rather than money you are owed
  --muxed-id <n>      The muxed (M...) id you gave the payer for this
  --memo-text <text>  The text memo you asked the payer to send, if not the reference
  --memo-id <n>       The id memo you asked the payer to send
  --payer <G...>      An account known to pay this; corroborates, never settles alone. Repeatable
  --due <date>        When it is due
  --expires <date>    After this a payment no longer settles it
  --meta <key=value>  Kept with it, for you. Repeatable
${COMMON_HELP}

Dates are 2026-10-31 (midnight UTC) or an instant with its offset, 2026-10-31T17:00:00+01:00.`,
  options: {
    ...COMMON,
    account: { type: 'string' },
    amount: { type: 'string' },
    asset: { type: 'string' },
    debit: { type: 'boolean' },
    'muxed-id': { type: 'string' },
    'memo-text': { type: 'string' },
    'memo-id': { type: 'string' },
    payer: { type: 'string', multiple: true },
    due: { type: 'string' },
    expires: { type: 'string' },
    meta: { type: 'string', multiple: true },
  },
  async run(args, io) {
    const [reference] = positionals(args, 1)
    if (reference === undefined || reference.trim() === '') throw new UsageError('Give the reference, e.g. nostro expect INV-1042 ...')
    const account = string(args, 'account')
    if (account === undefined || !isAccountId(account)) throw new UsageError('--account must be the G... account it is paid to.')
    const raw = string(args, 'amount')
    if (raw === undefined) throw new UsageError('--amount is required.')
    const asset = assetOf(string(args, 'asset') ?? 'native')
    let amount: Money
    try {
      amount = Money.parse(raw, asset)
    } catch (err) {
      throw new UsageError(`--amount: ${(err as Error).message}`)
    }
    for (const payer of strings(args, 'payer')) {
      if (!isAccountId(payer)) throw new UsageError(`--payer ${JSON.stringify(payer)} is not a G... account id.`)
    }

    const expectation: NewExpectation = {
      tenantId: tenant(args, io),
      reference,
      account,
      direction: flag(args, 'debit') ? 'debit' : 'credit',
      amount,
      muxedId: uint64(args, 'muxed-id') ?? null,
      memo: memoOf(args),
      payers: strings(args, 'payer'),
      dueAt: date(args, 'due') ?? null,
      expiresAt: date(args, 'expires') ?? null,
      metadata: metadataOf(args),
    }
    const recorded = await withStore(args, io, (store) =>
      store.transaction(async (tx) => {
        try {
          return await tx.insertExpectation(expectation)
        } catch (err) {
          if (err instanceof ValidationError) throw new UsageError(err.message)
          if (err instanceof ConstraintError && err.constraint === 'expectation_reference_unique') {
            throw new CliError(`${reference} is already recorded in this tenant; references are unique.`)
          }
          throw err
        }
      }),
    )

    if (flag(args, 'json')) {
      await write(io.stdout, json(expectationWithPaid(recorded, Money.zero(recorded.amount.asset, recorded.amount.decimals))))
    } else {
      const way = recorded.direction === 'credit' ? 'owed to' : 'to pay from'
      await write(io.stdout, `Recorded ${clean(recorded.reference)}: ${money(recorded.amount)} ${way} ${recorded.account}.\n`)
    }
    return 0
  },
}

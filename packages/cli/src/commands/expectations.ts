import type { ExpectationStatus } from '@nostro-labs/nostro'
import { isAccountId, sumAmounts } from '@nostro-labs/nostro'
import { COMMON, UsageError, flag, integer, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { assetLabel, expectationWithPaid, when } from '../format.js'
import { json, table, write } from '../io.js'

const STATUSES: readonly ExpectationStatus[] = ['open', 'partially_paid', 'settled', 'cancelled']

export const expectations: Command = {
  name: 'expectations',
  summary: 'List what you are owed, and how much of it has been paid',
  usage: '[options]',
  help: `Lists expectations, oldest first, with what has been allocated to each so far.

Options:
  --status <s,...>    open, partially_paid, settled and/or cancelled (default: all)
  --account <G...>    Only this account's
  --limit <n>         At most this many (default 100)
${COMMON_HELP}`,
  options: { ...COMMON, status: { type: 'string' }, account: { type: 'string' }, limit: { type: 'string' } },
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const limit = integer(args, 'limit', 100, 1, 10_000)
    const status = string(args, 'status')?.split(',') as ExpectationStatus[] | undefined
    for (const s of status ?? []) {
      if (!STATUSES.includes(s)) throw new UsageError(`--status takes ${STATUSES.join(', ')}; not ${JSON.stringify(s)}.`)
    }
    const account = string(args, 'account')
    if (account !== undefined && !isAccountId(account)) throw new UsageError('--account must be a G... account id.')

    const rows = await withStore(args, io, async (store) => {
      const list = await store.listExpectations({
        tenantId,
        limit,
        ...(status === undefined ? {} : { status }),
        ...(account === undefined ? {} : { account }),
      })
      const out = []
      for (const e of list) {
        const allocations = await store.listAllocations({ tenantId, expectationId: e.id })
        out.push({ e, paid: sumAmounts(allocations.map((a) => a.amount), e.amount) })
      }
      return out
    })

    if (flag(args, 'json')) {
      await write(io.stdout, json(rows.map(({ e, paid }) => expectationWithPaid(e, paid))))
      return 0
    }
    if (rows.length === 0) {
      await write(io.stdout, 'No expectations.\n')
      return 0
    }
    await write(
      io.stdout,
      table([
        ['REFERENCE', 'STATUS', 'AMOUNT', 'PAID', 'ASSET', 'DUE', 'ACCOUNT'],
        ...rows.map(({ e, paid }) => [
          e.reference,
          e.direction === 'debit' ? `${e.status} (debit)` : e.status,
          e.amount.toString(),
          paid.toString(),
          assetLabel(e.amount.asset),
          when(e.dueAt).slice(0, 10),
          e.account,
        ]),
      ]),
    )
    return 0
  },
}

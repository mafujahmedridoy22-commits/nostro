import type { ExceptionCode, ExceptionStatus } from 'nostro'
import { EXCEPTION_CODES, exceptionJson } from 'nostro'
import { COMMON, UsageError, flag, integer, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { assetLabel, when } from '../format.js'
import { json, table, write } from '../io.js'

const STATUSES = ['open', 'resolved', 'dismissed', 'all'] as const

export const exceptions: Command = {
  name: 'exceptions',
  summary: 'List what needs a person: payments nostro would not decide alone',
  usage: '[options]',
  help: `Lists exceptions, oldest first: payments that matched nothing, matched more than one thing,
overpaid, arrived in a lookalike asset, and so on. Each one says why, and --json includes the
evidence (per-candidate signals and scores) behind the decision. Answer one with "nostro resolve".

Options:
  --status <s>        open (the default), resolved, dismissed or all
  --code <CODE>       Only this reason, e.g. AMBIGUOUS_MATCH
  --limit <n>         At most this many (default 100)
${COMMON_HELP}`,
  options: { ...COMMON, status: { type: 'string' }, code: { type: 'string' }, limit: { type: 'string' } },
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const limit = integer(args, 'limit', 100, 1, 10_000)
    const status = string(args, 'status') ?? 'open'
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new UsageError(`--status takes ${STATUSES.join(', ')}; not ${JSON.stringify(status)}.`)
    }
    const code = string(args, 'code')
    if (code !== undefined && !(EXCEPTION_CODES as readonly string[]).includes(code)) {
      throw new UsageError(`--code takes one of ${EXCEPTION_CODES.join(', ')}; not ${JSON.stringify(code)}.`)
    }

    const list = await withStore(args, io, (store) =>
      store.listExceptions({
        tenantId,
        limit,
        ...(status === 'all' ? {} : { status: status as ExceptionStatus }),
        ...(code === undefined ? {} : { code: code as ExceptionCode }),
      }),
    )

    if (flag(args, 'json')) {
      await write(io.stdout, json(list.map(exceptionJson)))
      return 0
    }
    if (list.length === 0) {
      await write(io.stdout, status === 'open' ? 'No open exceptions.\n' : 'No exceptions.\n')
      return 0
    }
    await write(
      io.stdout,
      table([
        ['OPENED (UTC)', 'CODE', 'STATUS', 'AMOUNT', 'ID', 'DETAIL'],
        ...list.map((x) => [
          when(x.openedAt),
          x.code,
          x.status,
          x.amount === null ? '' : `${x.amount.toString()} ${assetLabel(x.amount.asset)}`,
          x.id,
          x.detail,
        ]),
      ]),
    )
    return 0
  },
}

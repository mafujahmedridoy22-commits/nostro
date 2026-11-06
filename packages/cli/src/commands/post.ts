import type { JournalEntryKind } from '@nostro-labs/nostro'
import { postJournal } from '@nostro-labs/nostro'
import { COMMON, flag, positionals, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { clean, json, write } from '../io.js'

export const post: Command = {
  name: 'post',
  summary: 'Post to the journal any decision it does not reflect yet',
  usage: '[options]',
  help: `Goes through every decided movement and posts whatever its journal entries are missing: an
initial entry for one decided before it had a journal, or an adjustment for one whose allocations
or exceptions changed since. "nostro reconcile" posts as it decides, so this is for decisions made
some other way, and is what doctor's journal_stale warning asks for. Posting is idempotent: run it
again and it posts nothing.

Options:
${COMMON_HELP}`,
  options: COMMON,
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const posted: Record<JournalEntryKind, number> = { initial: 0, reclass: 0, correction: 0 }
    const errors = new Map<string, string>()
    let examined = 0
    await withStore(args, io, async (store) => {
      for (let afterSeq: number | undefined; ; ) {
        const report = await postJournal({ store, tenantId, ...(afterSeq === undefined ? {} : { afterSeq }) })
        examined += report.examined
        for (const kind of Object.keys(posted) as JournalEntryKind[]) posted[kind] += report.posted[kind]
        for (const { movementId, error } of report.errors) errors.set(movementId, error.message)
        if (report.lastSeq === null) return
        afterSeq = report.lastSeq
      }
    })

    const failed = errors.size > 0
    if (flag(args, 'json')) {
      await write(io.stdout, json({ examined, posted, errors: [...errors].map(([movementId, error]) => ({ movementId, error })) }))
      return failed ? 1 : 0
    }
    const total = posted.initial + posted.reclass + posted.correction
    await write(
      io.stdout,
      total === 0
        ? `The journal reflects every decision (${examined} movement(s) examined).\n`
        : `Posted ${total} entr${total === 1 ? 'y' : 'ies'} (${posted.initial} initial, ${posted.reclass} reclass, ` +
            `${posted.correction} correction) over ${examined} movement(s).\n`,
    )
    for (const [movementId, error] of errors) {
      await write(io.stderr, `Failed on movement ${movementId}: ${clean(error)}\n`)
    }
    return failed ? 1 : 0
  },
}

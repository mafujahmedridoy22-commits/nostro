import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolve } from 'node:path'
import { journalCsvRows } from '@nostro-labs/nostro'
import { COMMON, CliError, UsageError, date, flag, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { withStore } from '../command.js'
import { write } from '../io.js'

// The output is CSV whatever happens, so --json does not apply.
const { json: _json, ...options } = COMMON

export const exportJournal: Command = {
  name: 'export',
  summary: 'Write the journal as CSV, one row per line',
  usage: '[--from <date>] [--to <date>] [--output <file>] [options]',
  help: `Writes every journal entry effective in the range as CSV (RFC 4180, CRLF line endings): one
row per line, with exact amounts in the debit or credit column, and the movement, transaction,
expectation and exception each line came from. Cells a spreadsheet would read as a formula are
prefixed with '. Payer-written memo text is never written. To stdout, unless --output is given.

Options:
  --from <date>       Entries effective on or after this
  --to <date>         Entries effective before this
  --output <file>     Write to this file; it must not exist, unless --force
  --force             Overwrite --output if it exists
  --db <path|url>     SQLite file, or a postgres:// URL (env NOSTRO_DB; default ./nostro.db)
  --tenant <id>       Whose records to use (env NOSTRO_TENANT; default "default")
  -h, --help          Show this help

Dates are 2026-10-31 (midnight UTC) or an instant with its offset, 2026-10-31T17:00:00+01:00.`,
  options: { ...options, from: { type: 'string' }, to: { type: 'string' }, output: { type: 'string' }, force: { type: 'boolean' } },
  async run(args, io) {
    positionals(args, 0)
    const tenantId = tenant(args, io)
    const from = date(args, 'from')
    const to = date(args, 'to')
    if (from !== undefined && to !== undefined && from >= to) throw new UsageError('--from must be before --to.')
    const output = string(args, 'output')
    if (output === undefined && flag(args, 'force')) throw new UsageError('--force only applies with --output.')

    return withStore(args, io, async (store) => {
      const rows = journalCsvRows({ store, tenantId, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) })
      if (output === undefined) {
        for await (const row of rows) await write(io.stdout, row)
        return 0
      }

      const path = resolve(io.cwd, output)
      const file = createWriteStream(path, { flags: flag(args, 'force') ? 'w' : 'wx' })
      try {
        await once(file, 'open')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`${path} exists; pass --force to overwrite it.`)
        throw err
      }
      let lines = -1 // the header
      async function* counted() {
        for await (const row of rows) {
          lines += 1
          yield row
        }
      }
      try {
        // pipeline() waits for drain, and destroys the file on an error at either end.
        await pipeline(Readable.from(counted()), file)
      } catch (err) {
        // Half a ledger is worse than none: leave no partial file behind.
        await rm(path, { force: true })
        throw err
      }
      await write(io.stdout, `Wrote ${lines} journal line(s) to ${path}.\n`)
      return 0
    })
  },
}

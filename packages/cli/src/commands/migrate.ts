import { COMMON, database, flag, positionals } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP } from '../command.js'
import { json, write } from '../io.js'
import { openStore } from '../store.js'

export const migrate: Command = {
  name: 'migrate',
  summary: 'Create the database, or bring its schema up to date',
  usage: '[options]',
  help: `Creates the database if it does not exist and applies any migrations it is missing. Safe to
run again, and from several processes at once. No other command changes the schema.

Options:
${COMMON_HELP}`,
  options: COMMON,
  async run(args, io) {
    positionals(args, 0)
    const opened = await openStore(database(args, io), io, { create: true })
    try {
      const before = await opened.store.schemaVersion()
      if (before.current > before.latest) {
        await write(
          io.stderr,
          `${opened.label} is at schema version ${before.current}, newer than this nostro understands ` +
            `(${before.latest}). Upgrade @nostro-labs/cli; nothing was changed.\n`,
        )
        return 1
      }
      await opened.store.migrate()
      const after = await opened.store.schemaVersion()
      if (flag(args, 'json')) {
        await write(io.stdout, json({ database: opened.label, from: before.current, to: after.current }))
      } else if (before.current === after.current) {
        await write(io.stdout, `${opened.label} is up to date (schema version ${after.current}).\n`)
      } else {
        await write(io.stdout, `Migrated ${opened.label} from schema version ${before.current} to ${after.current}.\n`)
      }
      return 0
    } finally {
      await opened.store.close()
    }
  },
}

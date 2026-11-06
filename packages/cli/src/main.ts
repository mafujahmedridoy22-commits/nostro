/**
 * `nostro <command> [options]`. Exit status: 0 when the command did what was
 * asked and found nothing wrong, 1 when it could not or found a problem, 2
 * when the command line itself was wrong.
 */
import { readFileSync } from 'node:fs'
import { CliError, UsageError, parse } from './args.js'
import type { Command } from './command.js'
import { doctor } from './commands/doctor.js'
import { exceptions } from './commands/exceptions.js'
import { expect } from './commands/expect.js'
import { expectations } from './commands/expectations.js'
import { exportJournal } from './commands/export.js'
import { migrate } from './commands/migrate.js'
import { post } from './commands/post.js'
import { reconcile } from './commands/reconcile.js'
import { resolve } from './commands/resolve.js'
import { serve } from './commands/serve.js'
import { sync } from './commands/sync.js'
import type { Io } from './io.js'
import { clean, write } from './io.js'

export const COMMANDS: readonly Command[] = [
  migrate,
  sync,
  expect,
  expectations,
  reconcile,
  exceptions,
  resolve,
  post,
  doctor,
  exportJournal,
  serve,
]

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return pkg.version
}

function overview(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length))
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)
  return `nostro: payment reconciliation and ledger-to-accounting for Stellar

Usage: nostro <command> [options]

Commands:
${lines.join('\n')}

Run "nostro <command> --help" for a command's options. Every command reads its database from
--db or NOSTRO_DB (a SQLite file, or a postgres:// URL; default ./nostro.db).

nostro never signs a transaction and never needs a secret key.
`
}

const helpFor = (c: Command) => `Usage: nostro ${c.name} ${c.usage}\n\n${c.summary}.\n\n${c.help}\n`

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [name, ...rest] = argv
  try {
    if (name === undefined) {
      await write(io.stderr, overview())
      return 2
    }
    if (name === '--help' || name === '-h' || (name === 'help' && rest.length === 0)) {
      await write(io.stdout, overview())
      return 0
    }
    if (name === 'help') {
      const topic = COMMANDS.find((c) => c.name === rest[0])
      if (topic === undefined) throw new UsageError(`Unknown command ${JSON.stringify(rest[0])}.`)
      await write(io.stdout, helpFor(topic))
      return 0
    }
    if (name === '--version' || name === '-v') {
      await write(io.stdout, `${version()}\n`)
      return 0
    }
    const command = COMMANDS.find((c) => c.name === name)
    if (command === undefined) throw new UsageError(`Unknown command ${JSON.stringify(name)}.`)
    const args = parse(rest, command.options)
    if (args.values.help === true) {
      await write(io.stdout, helpFor(command))
      return 0
    }
    return await command.run(args, io)
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    // A message may span lines; anything else that could drive the terminal is escaped.
    const lines = (text: string) => text.split('\n').map(clean).join('\n')
    const message = lines(error.message)
    if (error instanceof UsageError) {
      const hint = COMMANDS.some((c) => c.name === name) ? `nostro ${name} --help` : 'nostro --help'
      await write(io.stderr, `nostro: ${message}\nRun "${hint}" for usage.\n`)
      return 2
    }
    const detail = io.env.NOSTRO_DEBUG !== undefined && !(error instanceof CliError) ? error.stack : undefined
    await write(io.stderr, `nostro: ${message}\n${detail === undefined ? '' : `${lines(detail)}\n`}`)
    return 1
  }
}

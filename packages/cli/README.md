# nostro-cli

The command line for [nostro](https://github.com/nostro-labs/nostro): ingest a Stellar account's
history from Horizon and reconcile it, from a shell or a cron job, against a SQLite file or
PostgreSQL.

```sh
npm install -g nostro-cli
```

```sh
nostro migrate                                       # create ./nostro.db
nostro sync --account G...                           # ingest every effect and fee Horizon keeps
nostro expect INV-1042 --account G... --amount 25    # record what you are owed
nostro reconcile                                     # decide every pending movement, and post it
nostro exceptions                                    # what needs a person, and why
nostro resolve <id> --apply INV-1042 --note "..."    # that payment was for this invoice
nostro doctor --attest --account G...                # check the books, and the balances on chain
nostro export --output journal.csv                   # the journal, a row per line
```

| Command | What it does |
|---|---|
| `migrate` | Creates the database, or applies the migrations it is missing. The only command that changes the schema; every other one refuses a database that is not exactly at the version it expects. |
| `sync` | Ingests effects and fees for each `--account`, until caught up (or one round with `--once`). |
| `expect` | Records an expectation: a reference, an account, an amount, and optionally a muxed id, a memo, payers, due and expiry dates. Never rounds an amount. |
| `expectations` | Lists expectations with what has been allocated to each. |
| `reconcile` | Matches pending movements against expectations and posts each decision to the journal. |
| `exceptions` | Lists what reconcile would not decide alone, with the reason (and, in `--json`, the evidence). |
| `resolve` | Answers an exception: `--apply <reference[=amount]>` (this payment was for that invoice), `--ignore` (not something to reconcile) or `--close`, with a required `--note`. Moves the movement, its exceptions and the journal together. |
| `post` | Posts to the journal any decision it does not reflect yet, such as one made outside `reconcile`. Idempotent. |
| `doctor` | Checks invariants I1 and I3 over every record, and with `--attest` I2: each account's recorded movements against its on-chain balance in every asset. Exits 1 if any does not hold. |
| `export` | Writes the journal as CSV (RFC 4180), with a date range; to stdout, or to `--output`, which it will not overwrite without `--force` and never leaves half-written. |
| `serve` | Runs the HTTP API ([nostro-server](../server/README.md)). With `--account`s to watch, syncs and reconciles them every `--interval` seconds; with `--webhook-url`, delivers each decision there, signed ([docs/webhooks.md](../../docs/webhooks.md)). Stops cleanly on Ctrl-C or SIGTERM. |

`serve` reads API keys as `tenant:key` pairs from `NOSTRO_API_KEYS` (comma-separated) or
`--keys-file` (one per line), never from the command line, where `ps` would show them. It listens on
127.0.0.1:8080 unless told otherwise (`--host`, `--port`, or `NOSTRO_HOST`, `NOSTRO_PORT`). The
worker syncs one tenant's accounts (`--tenant`); the API serves every tenant that has a key.

Every command takes `--db` (a SQLite file, `sqlite:<path>`, or a `postgres://` URL; default
`./nostro.db`) and `--tenant` (default `default`), and all but `export` take `--json`. `nostro <command> --help` lists the
rest. Options can also come from the environment:

| Variable | Option |
|---|---|
| `NOSTRO_DB` | `--db` |
| `NOSTRO_TENANT` | `--tenant` |
| `NOSTRO_ACCOUNTS` | `--account`, comma or space separated |
| `NOSTRO_NETWORK` | `--network` (`testnet`, the default, or `public`) |
| `NOSTRO_HORIZON_URL` | `--horizon` |
| `NOSTRO_PG_SCHEMA` | the PostgreSQL schema to use (default `nostro`) |
| `NOSTRO_API_KEYS` | `serve`: `tenant:key` pairs, comma separated |
| `NOSTRO_WEBHOOK_URL` | `serve`: `--webhook-url` |
| `NOSTRO_WEBHOOK_SECRET` | `serve`: the webhook signing secret; never a flag |
| `NOSTRO_PORT`, `NOSTRO_HOST` | `serve`: `--port`, `--host` |

Exit status is 0 on success, 1 when the command failed or found a problem, and 2 when the command
line was wrong. A password in a `postgres://` URL is never printed. Text that came from a payment,
such as a memo, is printed with control characters escaped, so it cannot rewrite your terminal.

nostro never signs a transaction and never needs a secret key.

**Status:** 0.1.0, early: tested, and run against real testnet accounts, but the API may change before 1.0.

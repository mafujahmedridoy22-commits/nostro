# Horizon fixtures

Real Horizon responses, used by the normaliser tests so they run against what Horizon actually
returns rather than what we assume it returns.

Each file under `pubnet/` holds one operation (fetched with `?join=transactions`) and all of its
effects, with `_links` removed and nothing else changed. `sources` lists the exact URLs and
`capturedAt` the time of capture. `transactions-for-fees.json` holds three transaction records: a
normal one, a fee-bump, and a failed fee-bump, which still pays its fee.

These are public ledger records. Scenarios that could not be found live in reasonable time
(clawback, a CAP-73 account-creating SAC transfer, a pool trade from an offer) are built in the
tests by editing one of these records, and the tests say so.

# Before and after

A careful hand-rolled payment watcher and nostro, run over the same payments, comparing what each
concludes. The feed is simulated, so this runs anywhere, in the shape of real Horizon responses.

```sh
npm install
node compare.mjs
```

From a checkout of this repository, `pnpm install && pnpm build` at the root instead of `npm install`.

- [before.mjs](./before.mjs) is the watcher: it polls `/payments`, keeps its cursor, finds the invoice
  from the memo, adds up partial payments and checks the asset code. It is meant to be good code of
  its kind, not a strawman.
- [after.mjs](./after.mjs) is the same job with nostro.
- [compare.mjs](./compare.mjs) defines the ten cases and scores both. An answer is right when it is
  correct about whether the invoice is paid *and* about whether a person needs to look at something.

The table shows a failed request in the worst place for the watcher: after it has counted a payment
and before it has saved its cursor, so the retry counts it again. Most positions do no harm, which is
why this kind of bug survives testing. The line below the table gives both scores with the failure at
each position in turn.

Every wrong answer from the watcher could be fixed. Handling lookalike assets, floats, SAC transfers,
claims, retries and duplicates, and then checking the result against the chain, is the code nostro
already is.

nostro does not settle everything by itself. A payment that quotes nothing is flagged with the invoice
it most likely belongs to, and a person decides. What it never does is lose one.

import type { MatchStrategy } from '../types.js'

/**
 * Score 0.95. The movement's `MEMO_HASH` equals the hash the expectation
 * asked for.
 *
 * A hash is the fallback identifier for a reference too long for a text
 * memo, and it is exact: stored values are already validated lowercase hex,
 * so there is nothing to normalise and no way to misread a formatting
 * variant. It carries the same confidence as a memo id because both are
 * exact identifiers the payer sends; no strategy is ever a guarantee, which
 * is why duplicate and settled checks run after matching.
 */
export const memoHashStrategy: MatchStrategy = {
  name: 'memo_hash',
  family: 'identifier',
  evaluate(movement, { expectation }) {
    if (movement.memo?.type !== 'hash') return null
    const hash = movement.memo.value
    const asked = expectation.memo?.type === 'hash' && expectation.memo.value === hash
    if (!asked) return null
    return {
      strategy: 'memo_hash',
      family: 'identifier',
      score: 0.95,
      reason: `memo hash ${hash} matches the requested memo hash of ${expectation.reference}`,
    }
  },
}

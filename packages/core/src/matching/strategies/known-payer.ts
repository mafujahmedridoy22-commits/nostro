import type { MatchStrategy } from '../types.js'

/**
 * Score 0.40 when the movement's counterparty is one of the expectation's
 * known payers.
 *
 * Corroborating evidence only: 0.40 sits below the engine's 0.70 threshold,
 * so it never settles on its own, but it lifts a unique-amount match over it.
 * False-positive risk: a registered payer can send money for another
 * obligation, or share an account with someone who owes nothing here, so the
 * amount still has to corroborate.
 */
export const knownPayerStrategy: MatchStrategy = {
  name: 'known_payer',
  family: 'payer',
  evaluate(movement, { expectation }) {
    if (movement.counterparty === null) return null
    if (!expectation.payers.includes(movement.counterparty)) return null
    return {
      strategy: 'known_payer',
      family: 'payer',
      score: 0.4,
      reason: `${movement.counterparty} is a known payer for ${expectation.reference}`,
    }
  },
}

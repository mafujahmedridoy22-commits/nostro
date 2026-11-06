/**
 * Properties of the pure parts: exact money, reference normalisation,
 * webhook signatures. The store-level properties are in nostro-testkit.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Money, NATIVE, normalizeReference, signWebhook, verifyWebhook } from '../src/index.js'

const raw = fc.bigInt({ min: -(1n << 127n), max: 1n << 127n })
const decimals = fc.integer({ min: 0, max: 38 })

describe('Money', () => {
  it('parses back exactly what it prints, at any size and scale', () => {
    fc.assert(
      fc.property(raw, decimals, (n, d) => {
        const m = Money.fromRaw(n, NATIVE, d)
        const back = Money.parse(m.toString(), NATIVE, d)
        expect(back.raw).toBe(n)
        expect(back.toString()).toBe(m.toString())
      }),
    )
  })

  it('adds and subtracts without losing anything', () => {
    fc.assert(
      fc.property(raw, raw, raw, (a, b, c) => {
        const [x, y, z] = [a, b, c].map((n) => Money.fromRaw(n, NATIVE))
        expect(x!.add(y!).subtract(y!).equals(x!)).toBe(true)
        expect(x!.add(y!).equals(y!.add(x!))).toBe(true)
        expect(x!.add(y!).add(z!).equals(x!.add(y!.add(z!)))).toBe(true)
        expect(x!.add(x!.negate()).isZero()).toBe(true)
        expect(x!.compare(y!)).toBe(a < b ? -1 : a > b ? 1 : 0)
      }),
    )
  })

  it('refuses to round: one digit too many is an error, never a smaller number', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1n << 80n }), fc.integer({ min: 1, max: 9 }), (n, last) => {
        const printed = Money.fromRaw(n, NATIVE).toString()
        expect(() => Money.parse(`${printed}${last}`, NATIVE)).toThrow(/refusing to round/)
      }),
    )
  })
})

describe('normalizeReference', () => {
  const anyText = fc.string({ unit: 'binary', maxLength: 40 })
  /** Text built from the parts the normaliser treats specially, which random text rarely contains. */
  const spelled = fc
    .array(
      fc.constantFrom('INV', 'inv', 'INVOICE', 'Invoice', 'REF', 'ref', 'NO', 'no.', '#', '-', '_', '.', '/', ':', ' ', '​', ' ', '\t', '0', '1', '42', 'A', 'x', 'INVENTORY', 'NOTE', 'ＩＮＶ', '１'),
      { maxLength: 8 },
    )
    .map((parts) => parts.join(''))
  const text = fc.oneof(anyText, spelled)

  it('is stable: normalising twice changes nothing', () => {
    fc.assert(
      fc.property(text, (s) => {
        expect(normalizeReference(normalizeReference(s))).toBe(normalizeReference(s))
      }),
    )
  })

  it('does not care how a person typed the reference around it', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9]{1,8}[A-Z0-9]{0,4}$/),
        fc.constantFrom('', 'INV', 'inv-', 'INV ', 'Invoice ', 'invoice #', 'REF ', 'ref:', 'No. ', '#', 'Invoice No. ', 'REF #', '- INV ', ' #INV-'),
        fc.constantFrom('', ' ', '​', '.', '-'),
        (id, prefix, tail) => {
          expect(normalizeReference(`${prefix}${id}${tail}`)).toBe(normalizeReference(id))
        },
      ),
    )
  })

  it('keeps what makes references different: leading zeros, and words that only begin like a prefix', () => {
    expect(normalizeReference('INV-00123')).not.toBe(normalizeReference('INV-123'))
    expect(normalizeReference('INVENTORY-1')).toBe('INVENTORY1')
    expect(normalizeReference('NOTE-1')).toBe('NOTE1')
    expect(normalizeReference('REFUND-1')).toBe('REFUND1')
  })
})

describe('webhook signatures', () => {
  const secret = fc.string({ minLength: 32, maxLength: 64 })
  const body = fc.string({ unit: 'binary', maxLength: 200 })
  const t = 1_790_000_000
  const now = () => new Date(t * 1000)

  it('verifies what was signed, whatever the body', () => {
    fc.assert(
      fc.property(secret, body, (s, b) => {
        expect(verifyWebhook({ secret: s, header: signWebhook(s, b, t), body: b, now })).toBe(true)
      }),
    )
  })

  it('refuses any change to the body, the secret or the timestamp', () => {
    fc.assert(
      fc.property(secret, secret, body, body, fc.integer({ min: 1, max: 200 }), (s, other, b, changed, skew) => {
        const header = signWebhook(s, b, t)
        fc.pre(s !== other && b !== changed)
        expect(verifyWebhook({ secret: s, header, body: changed, now })).toBe(false)
        expect(verifyWebhook({ secret: other, header, body: b, now })).toBe(false)
        // A signature is for its timestamp: moving t in the header breaks it, even inside the tolerance.
        expect(verifyWebhook({ secret: s, header: header.replace(`t=${t}`, `t=${t + skew}`), body: b, now })).toBe(false)
      }),
    )
  })

  it('never throws on a hostile header', () => {
    fc.assert(
      fc.property(secret, fc.string({ maxLength: 120 }), (s, header) => {
        expect(verifyWebhook({ secret: s, header, body: '{}', now })).toBe(false)
      }),
    )
  })
})

/**
 * Payment reference normalisation.
 *
 * Text memos are typed by people into wallets, so the same invoice arrives as
 * `INV-00123`, `inv #00123`, `Invoice 00123` or `ＩＮＶ００１２３`. This maps
 * all of those to one canonical form, `00123`, and the same function is
 * applied to the expectation's reference, so they compare equal.
 *
 * Steps: NFKC (full-width and compatibility forms) → drop zero-width and
 * control characters → upper-case → drop leading separators and prefixes
 * (`INVOICE`, `INV`, `REF`, `NO`, `#`) → drop separators (space - _ . / # :).
 * The result is stable: normalising it again changes nothing.
 *
 * Deliberately conservative: leading zeros are kept (`00123` is not `123`),
 * and nothing is stripped from the middle of a reference.
 */

const INVISIBLE = /[​-‍⁠﻿\p{Cc}]/gu
const LEADING = /^[\s\-_./#:]+/
const PREFIX = /^(?:INVOICE|INV|REF|NO|#)(?=[\s\-_./#:]|\d|$)[\s\-_./#:]*/
const SEPARATORS = /[\s\-_./#:]+/g

function once(text: string): string {
  let s = text.normalize('NFKC').replace(INVISIBLE, '').toUpperCase().trim()
  // Prefixes can stack ("Invoice No. 123", "REF #123"), and can follow a stray separator ("- INV 123").
  for (let previous = ''; previous !== s; ) {
    previous = s
    s = s.replace(LEADING, '').replace(PREFIX, '')
  }
  return s.replace(SEPARATORS, '')
}

export function normalizeReference(text: string): string {
  // Dropping separators can expose a prefix ("I-NV 5"), and upper-casing can
  // leave text NFKC would change, so repeat until nothing does. The text is
  // whatever a payer sent, so the repeats are bounded.
  let s = text
  for (let i = 0; i < 8; i++) {
    const next = once(s)
    if (next === s) break
    s = next
  }
  return s
}

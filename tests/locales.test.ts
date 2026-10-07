/**
 * Locale dictionary hygiene.
 *
 * The `wslWorkspace` namespace is registered from both dictionaries at once, so a key that exists in
 * only one of them renders as a bare key (or an untranslated string) in the other language. These
 * two checks are about the dictionary as a dictionary.
 *
 * **What used to be here, and where it went.** This file also asked whether the help panel matched
 * the build — whether every registered tool was named, whether the "what's new" heading carried the
 * package version, whether any sentence still described `bash` as PTY-backed. Those are not
 * dictionary questions and they were never asked about *content* here: the checks compared the two
 * languages to each other, so a panel that was internally consistent and externally false passed,
 * and `bash 由 PTY 承载` shipped for a whole release that had replaced that shell.
 *
 * They now live in `tests/parity/claims.mjs`, next to the rest of the panel-versus-build claims and
 * running under one shared derivation kernel (`tests/parity/derive.mjs`) instead of reading the
 * sources twice. Keeping a second copy here would have meant two places to update and two places to
 * disagree — the exact shape this gate family exists to remove.
 *
 * Run with `node --test --experimental-strip-types tests/locales.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { en, zh } from '../src/client/locales.ts'

test('zh and en expose exactly the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('no dictionary value is blank', () => {
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(value.trim() !== '', `zh ${key} is blank`)
  }
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim() !== '', `en ${key} is blank`)
  }
})

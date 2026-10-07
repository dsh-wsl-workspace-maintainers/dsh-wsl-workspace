/**
 * The parity gate that runs in `test:unit`: every claim that must hold today.
 *
 * `tests/parity/claims.mjs` holds the claims and their reasons; this file only runs them. The
 * declared reds live there too but are not run here — `test:unit` is required to be green in CI,
 * and a claim the product has not been changed to satisfy would make that impossible. They are
 * checked by `scripts/run-docs-claims.mjs`, which knows how to account for a red that is owed.
 *
 * Each claim is one `test`, so a failure names the claim rather than a line number inside a loop.
 *
 * Run with `node --test --experimental-strip-types tests/parity-claims.test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GREEN_CLAIMS } from './parity/claims.mjs'

test('the registry has claims, so a green run means something', () => {
  assert.ok(GREEN_CLAIMS.length >= 8,
    `read ${GREEN_CLAIMS.length} green claim(s). An empty or near-empty registry reports the same `
    + 'green as a registry whose claims all hold, which is the failure mode this whole file exists '
    + 'to avoid.')
})

for (const claim of GREEN_CLAIMS) {
  test(claim.id, async () => {
    const { ok, detail } = await claim.run()
    assert.ok(ok, detail)
  })
}

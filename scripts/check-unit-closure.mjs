// The pure-node bucket must load with nothing but this package's own dependencies.
//
// Why this exists: `@deepseek-ai/*` are declared as **optional peerDependencies**, so `npm ci` on the
// `lint-build` job does not install them. A test that imported `src/host/wsl-bash-tool.ts` for one
// constant dragged `@deepseek-ai/schemastery` into the bucket, and the cloud frame read
// `Cannot find package '@deepseek-ai/schemastery'` for two test files (frames at `ed08a5b` and
// `f108379`). The bucket's file list is the contract this script checks: it walks what those files
// import, transitively, and names any host package found on the way.
//
// Usage: node scripts/check-unit-closure.mjs [--self-test]
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const here = dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8').replace(/^﻿/, ''))
const installed = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])

/** Resolve one relative specifier to the file Node would load, trying the extensions it would try. */
function resolveLocal(from, specifier) {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`]) {
    try {
      readFileSync(candidate)
      return candidate
    } catch { /* try the next spelling */ }
  }
  return undefined
}

/**
 * Every bare (non-relative, non-node:) specifier a module graph imports.
 * @param entry - an absolute path to the file to start from.
 * @param seen - internal: the files already visited, to survive cycles.
 * @returns `{ package, from }` for each external import, deduplicated.
 */
export function externalImports(entry, seen = new Set(), found = []) {
  if (seen.has(entry)) return found
  seen.add(entry)
  let source
  try {
    source = readFileSync(entry, 'utf8')
  } catch {
    return found
  }
  const pattern = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2]
    if (specifier === undefined || specifier.startsWith('node:') || specifier.startsWith('.')) continue
    if (!specifier.startsWith('@') && !specifier.includes('/')) {
      if (!specifier.startsWith('@deepseek-ai/') && !installed.has(specifier)) found.push({ package: specifier, from: entry })
      continue
    }
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier
    if (name.startsWith('@deepseek-ai/') || name.startsWith('@cordisjs/')) found.push({ package: name, from: entry })
    else if (!installed.has(name)) found.push({ package: name, from: entry })
  }
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"](\.[^'"]+)['"]/g)) {
    const next = resolveLocal(entry, match[1])
    if (next !== undefined) externalImports(next, seen, found)
  }
  return found
}

const SELF_TEST = process.argv.includes('--self-test')

if (SELF_TEST) {
  // A positive control: the rule has to bite on a file that really does import a host package, or a
  // green here would mean nothing. `src/host/wsl-bash-tool.ts` is that file, and it is the one the
  // bucket is not allowed to reach.
  const offender = resolve(root, 'src/host/wsl-bash-tool.ts')
  const found = externalImports(offender)
  assert.ok(found.some(entry => entry.package === '@deepseek-ai/schemastery'),
    `the walker must find schemastery where it is imported; found ${JSON.stringify(found)}`)
  assert.ok(externalImports(resolve(root, 'src/shared/wsl-stdin.ts')).length === 0,
    'the shared stdin module must stay host-free — that is the whole reason it exists')
  console.log('check-unit-closure: self-test OK — the rule bites on the file that has the import')
  process.exit(0)
}

const script = pkg.scripts['test:unit']
const bucketFiles = script.split(/\s+/).filter(argument => (argument.endsWith('.ts') || argument.endsWith('.mjs')) && !argument.startsWith('node'))

const offenders = []
for (const file of bucketFiles) {
  if (file.startsWith('node') || file.startsWith('--')) continue
  for (const entry of externalImports(resolve(root, file))) offenders.push(entry)
}

if (offenders.length > 0) {
  console.error(`check-unit-closure: RED — the pure-node bucket (${bucketFiles.length} files, npm ci installs only this package's own dependencies) reaches a package it cannot install:`)
  for (const entry of offenders) console.error(`  ${entry.package} imported from ${entry.from.replace(root + '/', '')}`)
  console.error('instead: keep the symbol the test needs in a module under src/shared with no host import (see src/shared/wsl-stdin.ts), or move the test into `test:node`, which runs after ci/install-pinned.mjs.')
  process.exit(1)
}
console.log(`check-unit-closure: OK — ${bucketFiles.length} bucket files, no host package on any path they import`)

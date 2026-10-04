/**
 * Host half of dsh-wsl-workspace. Three responsibilities:
 *
 * 1. Publish a `wsl-<mode>` variant for every healthy roster preset, so the
 *    WSL execution world — `shell-wsl` + `fs-wsl` behind one entry-local
 *    realm, with `tool-bash`/`tool-fs` consumers — composes with ANY mode
 *    instead of being a mode itself. The channel follows the release:
 *    `0.1.7-alpha.1+` stopped scanning any user preset root and builds its roster
 *    from declarative `@deepseek-ai/dsh-agent-preset` rows, so there a variant
 *    is a *declaration registered through `ctx.agentPresets`* — and only that
 *    path rewrites the absolute provider specifiers below into `file:` URLs,
 *    because a registered preset's entry tree does not translate them the way
 *    the boot-time Include does; earlier releases still get a variant directory
 *    under `<dshHome>/.agent-presets/`, whose legacy standalone `wsl` directory
 *    and stale variants are removed on boot.
 *
 * 2. Serve the browser dialog's data route (`/wsl-workspace/api`):
 *    distribution discovery, one-level directory listing, path checks, and
 *    the per-workspace username store — all over the 9P UNC share.
 *    Loopback-only, matching the sensitivity of the privileged configuration
 *    surface.
 *
 * 3. Contribute the per-session `DSH_WSL_DISTRO` managed-env fact so the WSL
 *    shell executor can resolve a plain Linux `workdir` to the calling
 *    session's distribution.
 * @module dsh-wsl-workspace
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, isAbsolute, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { joinUnc, mntToWindowsPath, normalizeLinuxPath, isAbsoluteLinuxPath, isValidWslUsername, parseWslUnc } from './shared/paths.ts'
import { canonicalWslUnc, getWindowsWorkspace, getWorkspaceUsername, listWorkspaceKeys, registerWindowsWorkspace, setWorkspaceUsername } from './shared/wsl-credentials.ts'
import { defaultDistro, listDistros } from './shared/wsl.ts'
import { isElectronHost, resolveRelayNode } from './shared/relay-node.ts'
import { isWslVariantId, transformPresetForWsl, unquoteScalar, variantIdFor } from './host/variants.ts'
import { WslSkillsProvider, type WslSkillsRegistryFace } from './host/wsl-skills.ts'

/** The HTTP route this plugin serves (a relative, same-origin path). */
export const DEFAULT_ROUTE = '/wsl-workspace/api'

/**
 * Bilingual display labels for the shipped source modes, matching the app's
 * own built-in copy in each language — note the `code` preset is "PTC 模式"
 * in the Chinese copy but "Code mode" in English. The DSH picker localizes
 * only the four built-in ids itself; `wsl-*` variant ids render the
 * preset.yml text verbatim, so the plugin writes one bilingual string so
 * both locales can identify each variant. Custom presets keep their own
 * name.
 *
 * This table is consulted before anything the release publishes, so every id
 * the mode has ever carried needs an entry. `code` was the id up to
 * `0.1.0-rc.8` and `ptc` is the id from `0.1.1` on; without the `ptc` entry the
 * lookup returned undefined and the variant fell through to the release's own
 * display name — which `0.1.7` does not publish at all, leaving the mode named
 * `WSL · ptc` with the generic description `WSL execution world for ptc: …`.
 */
const MODE_DISPLAY_LABELS: Readonly<Record<string, { en: string; zh: string }>> = {
  standard: { en: 'Standard mode', zh: '标准模式' },
  code: { en: 'Code mode', zh: 'PTC 模式' },
  ptc: { en: 'PTC mode', zh: 'PTC 模式' },
  minimal: { en: 'Minimal mode', zh: '极简模式' },
  cordis: { en: 'Creator mode', zh: '创造模式' },
}

/**
 * Quote a value as a single-line YAML single-quoted scalar. Plain scalars
 * cannot contain `: ` (colon + space), which plain English sentences do —
 * written unquoted they make the whole preset.yml unparsable, dropping the
 * name, description and order together.
 */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** The variant name for one shipped mode (bilingual) or a custom preset. */
function variantName(presetId: string, sourceName: string): string {
  const labels = MODE_DISPLAY_LABELS[presetId]
  return labels === undefined ? `WSL · ${sourceName}` : `WSL · ${labels.en}（${labels.zh}）`
}

/** The variant description for one shipped mode (bilingual) or a custom preset. */
function variantDescription(presetId: string): string {
  const labels = MODE_DISPLAY_LABELS[presetId]
  const display = labels === undefined ? presetId : `${labels.en}（${labels.zh}）`
  return `WSL execution world for ${display}: bash and file tools run inside the WSL distribution.`
}

/** Plugin config. */
export interface Config {
  /** The route under which the dialog data API is served. */
  route?: string
}

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** The `webServer.register` route contract this plugin consumes. */
interface WebServerRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

interface WebServerService {
  register(route: WebServerRoute): () => void
}

/** The `ctx.shellEnv` registry face this plugin consumes (optional service). */
interface ShellEnvService {
  register(contributor: {
    name: string
    variables: Readonly<Record<string, { description: string }>>
    resolve(execution: {
      agent?: { session: { header: { cwd?: string } } }
    }): Readonly<Partial<Record<string, string>>>
  }): () => void
}

/** One directory entry the dialog lists. */
interface WslDirEntryWire {
  name: string
  kind: 'directory' | 'file' | 'other'
}

/** One directory level plus its breadcrumb ancestry. */
interface WslDirListingWire {
  path: string
  parent: string | null
  entries: WslDirEntryWire[]
}

/** The wire envelope every method answers with. */
type Envelope<T> = { ok: true; value: T } | { ok: false; error: string }

const MAX_BODY_BYTES = 1024 * 1024

/** Valid WSL distribution names: one path-safe segment (no separators, no dot-dirs). */
const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/

/** The loopback hostnames the data route answers to (DNS-rebinding fence). */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** True when a socket address is loopback (any IPv4/IPv6 spelling). */
function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** The hostname part of a `Host` header value (port and IPv6 brackets stripped). */
function hostNameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end >= 0 ? host.slice(1, end) : host
  }
  return host.split(':')[0] ?? ''
}

/** True when the request's `Host` header names a loopback host. */
function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOSTNAMES.has(hostNameOf(host).toLowerCase())
}

/**
 * Validate a wire-supplied distribution name before it becomes a UNC segment:
 * an attacker-controlled segment containing separators or `..` would escape
 * the `\\wsl.localhost\` share structure into arbitrary UNC paths.
 * @param value - the raw wire value.
 * @returns the validated distro name.
 */
function requireDistro(value: unknown): string {
  if (typeof value !== 'string' || !DISTRO_PATTERN.test(value) || value === '.' || value === '..') {
    throw new Error('distro must be a valid WSL distribution name')
  }
  return value
}

/** Human text for an unknown rejection. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Write one JSON envelope. */
function json(res: ServerResponse, status: number, body: Envelope<unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/** Collect and parse the request body, bounded. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Normalize a Linux path for the wire (rejecting non-absolute input). */
function requireLinuxPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsoluteLinuxPath(value)) {
    throw new Error(`${label} must be an absolute Linux path`)
  }
  return normalizeLinuxPath(value)
}

/** Validate a wire-supplied workspace path and return its canonical UNC form. */
function requireWslUnc(value: unknown): string {
  if (typeof value !== 'string') throw new Error('path must be a string')
  const canonical = canonicalWslUnc(value)
  if (canonical === null) throw new Error('path must be a WSL UNC workspace path')
  return canonical
}

/**
 * Resolve one directory listing for the dialog. The 9P share (`\\wsl.localhost\…`)
 * serves only the ext4 volume: `/mnt/<drive>` (drvfs) reads return Access
 * denied, so drvfs paths are read through their Windows drive spelling and
 * `/mnt` itself is synthesized from the drives present on the host.
 */
function listWslDir(distro: string, linuxPath: string): WslDirListingWire {
  if (linuxPath === '/mnt') {
    const entries: WslDirEntryWire[] = []
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i)
      try {
        const info = statSync(`${letter}:\\`)
        if (info.isDirectory()) entries.push({ name: letter.toLowerCase(), kind: 'directory' })
      } catch {
        // Absent drive: skip.
      }
    }
    return { path: '/mnt', parent: '/', entries }
  }
  const winPath = mntToWindowsPath(linuxPath)
  const readPath = winPath !== null ? winPath : joinUnc(distro, linuxPath)
  const dirents = readdirSync(readPath, { withFileTypes: true })
  const entries: WslDirEntryWire[] = dirents
    .slice(0, 1000)
    .map((dirent): WslDirEntryWire => {
      const kind: WslDirEntryWire['kind'] = dirent.isDirectory()
        ? 'directory'
        : dirent.isFile() ? 'file' : 'other'
      return { name: dirent.name, kind }
    })
    .sort((a, b) => {
      if (a.kind === 'directory' && b.kind !== 'directory') return -1
      if (a.kind !== 'directory' && b.kind === 'directory') return 1
      return a.name.localeCompare(b.name)
    })
  const parent = linuxPath === '/' ? null : linuxPath.split('/').slice(0, -1).join('/') || '/'
  return { path: linuxPath, parent, entries }
}

/** Cached self-description for the dialog's help panel. */
let selfDescription: { version: string; releases: { id: string; status: string }[] } | undefined

/**
 * Read this plugin's own `package.json` for the dialog's help panel: the
 * published version and the declared `dsh.compatibility.dshReleases` matrix.
 * A plugin directory that cannot be read reports empty values rather than
 * failing the dialog, and the result is cached for the process lifetime.
 * @returns the self-description served by the `describe` method.
 */
function describeSelf(): { version: string; releases: { id: string; status: string }[] } {
  if (selfDescription !== undefined) return selfDescription
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as {
      version?: unknown
      dsh?: { compatibility?: { dshReleases?: Record<string, unknown> } }
    }
    selfDescription = {
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      releases: Object.entries(parsed.dsh?.compatibility?.dshReleases ?? {})
        .map(([id, status]) => ({ id, status: String(status) })),
    }
  } catch {
    selfDescription = { version: 'unknown', releases: [] }
  }
  return selfDescription
}

/** Route one method dispatch. */
async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'listDistros': {
      const distros = await listDistros()
      const fallback = await defaultDistro()
      if (fallback !== undefined && distros.includes(fallback)) {
        return [fallback, ...distros.filter(name => name !== fallback)]
      }
      return distros
    }
    case 'listDir': {
      const distro = requireDistro(params.distro)
      const path = requireLinuxPath(params.path, 'path')
      return listWslDir(distro, path)
    }
    case 'check': {
      const distro = requireDistro(params.distro)
      const path = requireLinuxPath(params.path, 'path')
      // drvfs paths (Access denied over 9P) are checked through their drive spelling.
      const winPath = mntToWindowsPath(path)
      const readPath = winPath !== null ? winPath : joinUnc(distro, path)
      try {
        const info = statSync(readPath)
        return { exists: true, isDirectory: info.isDirectory() }
      } catch {
        return { exists: false, isDirectory: false }
      }
    }
    case 'registerWindows': {
      // A `/mnt/<drive>` workspace registers under its Windows drive path
      // (the registry realpath/stats it, and 9P cannot serve drvfs) with the
      // distro stored for the per-session env contributor.
      const distro = requireDistro(params.distro)
      const linuxPath = requireLinuxPath(params.linuxPath, 'path')
      const winPath = mntToWindowsPath(linuxPath)
      if (winPath === null) throw new Error('registerWindows requires a /mnt/<drive> Linux path')
      const username = typeof params.username === 'string' ? params.username : undefined
      registerWindowsWorkspace(winPath, distro, username)
      return null
    }
    case 'listWorkspaces': {
      // Every registered WSL workspace key (UNC and Windows drive spellings):
      // the client uses the drive keys to recognize `/mnt` workspaces.
      return listWorkspaceKeys()
    }
    case 'describe': {
      // The dialog's help panel reports what this build declares, so the
      // compatibility list can never drift from package.json.
      return describeSelf()
    }
    case 'setUser': {
      const path = requireWslUnc(params.path)
      const username = params.username
      if (username === undefined || username === '') {
        setWorkspaceUsername(path, undefined)
      } else {
        if (typeof username !== 'string' || !isValidWslUsername(username)) {
          throw new Error('username must match the Linux username pattern [A-Za-z_][A-Za-z0-9_.-]*')
        }
        setWorkspaceUsername(path, username)
      }
      return null
    }
    default:
      throw new Error(`unknown method "${method}"`)
  }
}

/** One roster entry as the `ctx.agentPresets` face reports it. */
interface AgentPresetRosterEntry {
  id: string
  name?: string
  description?: string
  /** Roster position; `list()` sorts by it. */
  order?: number
  broken?: string
  /** Legacy (≤ 0.1.6-alpha.2) only: the source preset's directory. */
  path?: string
}

/** One preset's declared composition, as the declaration channel reports it. */
interface AgentPresetDocument {
  agentPreset: string
  /** The declared child plugin list as entry-list YAML, `!!js` expressions included. */
  content: string
  name?: string
  description?: string
}

/** A declaration this plugin publishes; mirrors the Host's `PresetDefinition`. */
interface PresetDeclaration {
  id: string
  name?: string
  description?: string
  order?: number
  plugins: readonly unknown[]
}

/**
 * The `ctx.agentPresets` roster face this plugin consumes (optional service).
 *
 * Two generations sit behind this one shape, so both are probed by capability
 * rather than by version:
 *
 *  - `0.1.0-rc.7 … 0.1.6-alpha.2`: `list()` reports each preset's directory in
 *    `path`, and `read(id)` returns the composition text. A variant is a
 *    *directory* under the roster's scanned user root (`$DSH_HOME/.agent-presets/`).
 *  - `0.1.7-alpha.1+`: `read()` is renamed `readDocument()` and returns a document
 *    instead of a bare string, `AgentPreset.path` is gone, and **nothing scans
 *    the user root any more** — the roster is built from declarative
 *    `@deepseek-ai/dsh-agent-preset` rows carried by bundle patches. A variant
 *    is therefore a declaration row published through `register()`.
 */
interface AgentPresetsService {
  list(): Promise<AgentPresetRosterEntry[]>
  /** Legacy (≤ 0.1.6-alpha.2): the source composition text. */
  read?(id: string): Promise<string>
  /** 0.1.7-alpha.1+: the declared composition beside its published metadata. */
  readDocument?(id: string): Promise<AgentPresetDocument>
  /** 0.1.7-alpha.1+: publish a declaration; the returned disposer retires it. */
  register?(definition: PresetDeclaration): Promise<() => Promise<void>>
}

/**
 * Read one preset's declared composition across both roster generations.
 * @param agentPresets - the roster face.
 * @param preset - the roster entry to read.
 * @returns the composition text, plus the display name when the face publishes it.
 */
async function readPresetComposition(
  agentPresets: AgentPresetsService,
  preset: AgentPresetRosterEntry,
): Promise<{ content: string; name?: string }> {
  if (typeof agentPresets.readDocument === 'function') {
    const document = await agentPresets.readDocument(preset.id)
    return document.name === undefined
      ? { content: document.content }
      : { content: document.content, name: document.name }
  }
  if (typeof agentPresets.read === 'function') return { content: await agentPresets.read(preset.id) }
  throw new Error(
    `agentPresets: this DSH release exposes neither readDocument() nor read() (preset "${preset.id}")`,
  )
}

/** The half of the YAML engine this plugin needs, as js-yaml publishes it. */
interface YamlNamespace {
  load?(source: string, options: { schema: unknown }): unknown
  Type?: new (tag: string, options: {
    kind: string
    resolve: (data: unknown) => boolean
    construct: (data: unknown) => unknown
  }) => unknown
  JSON_SCHEMA?: { extend?: (type: unknown) => unknown }
  default?: YamlNamespace
}

/**
 * Name the copy of a bare specifier this file is standing on.
 *
 * Issue #47 was invisible for as long as it existed because the failure it produced
 * named nothing: `state.schema.lookupSequenceTag is not a function` says neither
 * which package, nor which version, nor from where. Every dialect failure below
 * therefore carries this line, and it is measured rather than asserted — a hoisted
 * wrong major, a nested copy that was never installed, and a bundler that inlined a
 * different release all answer differently here.
 * @param specifier - the bare specifier the loader was asked for.
 * @returns `name version at path`, or why it could not be said.
 */
function describeResolvedCopy(specifier: string): string {
  const resolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve
  if (typeof resolve !== 'function') return `${specifier} (this runtime exposes no resolver)`
  try {
    let dir = dirname(fileURLToPath(resolve.call(import.meta, specifier)))
    for (let depth = 0; depth < 8; depth += 1) {
      const manifestPath = join(dir, 'package.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string }
        if (manifest.name === specifier) return `${specifier} ${manifest.version ?? 'version-unknown'} at ${dir}`
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return `${specifier} resolved to ${dir}, above which no manifest names it`
  } catch (error) {
    return `${specifier} did not resolve (${messageOf(error)})`
  }
}

/**
 * Build the entry-list dialect from the engine namespace that will parse with it.
 *
 * `@deepseek-ai/cordis-plugin-include` exports an `entryListSchema` precisely so
 * config tooling can round-trip this dialect, and this plugin used to borrow it at
 * call time. That borrow cost the plugin its core feature on any host that packages
 * itself as an archive: a bare `import()` walks the filesystem upward, and an
 * archive-backed host's tree is not on it (issue #47). Only the load half of that
 * schema is ever used here — `predicate` and `represent` serve a dump path this
 * plugin does not take — so the dialect is ~six lines, and building it from the same
 * namespace that supplies `load()` is what makes it impossible for the schema and
 * the engine to come from different majors.
 * @param ns - the js-yaml namespace the same call parses with.
 * @returns the schema, or undefined when this copy cannot express the dialect.
 */
function entryListSchemaFrom(ns: YamlNamespace): unknown | undefined {
  const Type = ns.Type ?? ns.default?.Type
  const JsonSchema = ns.JSON_SCHEMA ?? ns.default?.JSON_SCHEMA
  if (typeof Type !== 'function' || JsonSchema?.extend === undefined) return undefined
  const jsExpr = new Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data: unknown) => typeof data === 'string',
    construct: (data: unknown) => ({ __jsExpr: data }),
  })
  return JsonSchema.extend(jsExpr)
}

/**
 * Parse one transformed composition back into declaration rows.
 *
 * The composition is the entry-list YAML dialect, whose `!!js` scalars are
 * expression nodes the Loader evaluates when the row activates; parsing the text
 * back is what lets the (text-level) WSL transform keep working now that a variant
 * is a declaration row instead of a directory of YAML.
 *
 * The engine is still resolved at call time rather than at module load: a release
 * that ever loses it must fail the variants and not refuse to load the whole plugin.
 * What it no longer borrows is the dialect, so the only thing to be reachable is one
 * package this plugin now declares for itself.
 * @param content - the variant composition text.
 * @returns the declaration's plugin rows.
 */
async function parseVariantComposition(content: string): Promise<unknown[]> {
  const specifier = 'js-yaml'
  const ns = await import(specifier) as YamlNamespace
  const load = ns.load ?? ns.default?.load
  if (typeof load !== 'function') throw new Error(`${specifier}: no load() export (${describeResolvedCopy(specifier)})`)
  const schema = entryListSchemaFrom(ns)
  if (schema === undefined) {
    throw new Error(`${specifier}: this copy cannot express the entry-list dialect, which needs the 4.x Type / `
      + `JSON_SCHEMA.extend API (${describeResolvedCopy(specifier)})`)
  }
  // Probe the dialect before anything depends on it. An engine that loads plain
  // scalars but rejects a schema built by its own sibling API fails INSIDE load()
  // with an internal message no reader can act on (measured with two real releases:
  // a 4.x-built schema passed to a 5.x load answers `lookupSequenceTag is not a
  // function`), so one six-line document turns that into a named, located failure.
  const probe = load('- id: probe\n  disabled: !!js true\n', { schema }) as unknown
  const first = Array.isArray(probe) ? probe[0] as { disabled?: { __jsExpr?: unknown } } : undefined
  if (first?.disabled?.__jsExpr !== 'true') {
    throw new Error(`${specifier}: the entry-list dialect did not round-trip (${describeResolvedCopy(specifier)})`)
  }
  const rows = load(content, { schema })
  if (!Array.isArray(rows)) throw new Error('the transformed composition did not parse as an entry list')
  return toImportableSpecifiers(rows)
}

/**
 * Rewrite every absolute local module specifier as a `file:` URL.
 *
 * The generated world names THIS package's built providers (`shell.js`,
 * `fs.js`, …) by absolute path. That is what the directory mechanism needed:
 * those rows sat in an Include-backed tree, and the boot-time Include
 * translates an absolute path into a `file:` URL before importing it. A preset
 * mounted from a *declaration* is loaded by the registry's own entry tree,
 * which has no such translation — handing it `C:/…/lib/shell.js` leaves those
 * rows without a fiber, the audit reports them "never started", and the whole
 * variant is refused. Rewriting the specifier is therefore part of adapting to
 * the declaration mechanism, not a change to what the variant mounts.
 *
 * Only `name` is touched: config values (the relay path handed to the PTY
 * backend, the interpreter path in `shellPath`) must stay native filesystem
 * paths. Group rows carry their children in a `config` array, so those are
 * walked too.
 * @param rows - the parsed declaration rows.
 * @returns the same rows with their module specifiers made importable.
 */
function toImportableSpecifiers(rows: unknown[]): unknown[] {
  const rewrite = (row: unknown): unknown => {
    if (row === null || typeof row !== 'object') return row
    const entry = row as { name?: unknown; config?: unknown }
    if (typeof entry.name === 'string' && isAbsolute(entry.name)) {
      entry.name = pathToFileURL(entry.name).href
    }
    if (Array.isArray(entry.config)) entry.config = entry.config.map(rewrite)
    return row
  }
  return rows.map(rewrite)
}

/**
 * Publish a fully staged preset directory while preserving the last complete
 * variant if publication fails. Stable sibling names also let the next boot
 * recover an interrupted old-to-backup rename before doing new work.
 */
function publishVariant(staging: string, dest: string): void {
  const previous = `${dest}.previous`
  if (!existsSync(dest) && existsSync(previous)) renameSync(previous, dest)
  if (existsSync(previous)) rmSync(previous, { recursive: true, force: true })
  if (existsSync(dest)) renameSync(dest, previous)
  try {
    renameSync(staging, dest)
  } catch (error) {
    if (!existsSync(dest) && existsSync(previous)) renameSync(previous, dest)
    throw error
  }
  rmSync(previous, { recursive: true, force: true })
}

/**
 * Whether a host's terminal stack can allocate a PTY process *on this platform*.
 *
 * The world's `bash` is the host's persistent-shell stack, and on Windows that
 * stack needs a platform process inspector. `@deepseek-ai/dsh-subprocess-local`
 * only grew one in `0.1.0-rc.8`: in `0.1.0-rc.7` `spawnTerminal` throws
 * `subprocess-local: terminal inspection is unsupported on platform win32`
 * before the process is started, so *every* persistent shell fails there — a
 * real session shows the model getting that error for each `bash` call while
 * grep/glob (which never touch the PTY) keep working. The host itself ships the
 * same gap: that release's Minimal preset mounts `persistent-bash` with no
 * `disabled:` guard for Windows.
 *
 * The probe asks the substrate the question directly instead of pattern-matching
 * a version: `spawnTerminal` builds its inspector before `node-pty` starts the
 * program, so handing it a program that cannot exist reaches that check and
 * nothing else — no process is created either way, and the failure message says
 * which half failed. A release that can build the inspector reports an ordinary
 * spawn failure instead, which is the "supported" answer.
 * @param ctx - plugin context; the `subprocess` service is looked up with `get`
 *   and waited for briefly, because the world is generated during profile boot.
 * @returns true when the persistent shell may be mounted.
 */
async function supportsPersistentShell(ctx: Context): Promise<boolean> {
  // POSIX hosts have an inspector on every declared release, and a WSL world is
  // Windows-only anyway.
  if (process.platform !== 'win32') return true
  const subprocess = await waitForSubprocess(ctx)
  if (subprocess?.spawnTerminal === undefined) return true
  try {
    const handle = await subprocess.spawnTerminal({
      argv: ['dsh-wsl-workspace-pty-probe-does-not-exist'],
      cwd: process.cwd(),
      rows: 24,
      cols: 80,
      graceMs: 1_000,
    })
    // Unexpectedly alive: this host starts a PTY for a missing program, so the
    // terminal stack works. Take the probe process down again.
    await handle?.terminate?.()
    return true
  } catch (error) {
    return !isTerminalInspectionUnsupported(error)
  }
}

/**
 * Whether one spawn failure is the missing-platform-inspector error.
 * @param error - the rejection from `spawnTerminal`.
 * @returns true when the host cannot inspect terminal processes here.
 */
export function isTerminalInspectionUnsupported(error: unknown): boolean {
  return /terminal inspection is unsupported on platform/i.test(messageOf(error))
}

/** The `subprocess` service face the probe needs. */
interface SubprocessProbeFace {
  spawnTerminal(spec: {
    argv: readonly string[]
    cwd: string
    rows: number
    cols: number
    graceMs: number
  }): Promise<{ terminate?: () => Promise<void> | void } | undefined>
}

/**
 * Look up the `subprocess` service, giving profile boot a moment to publish it.
 *
 * Bounded: the world is generated in a fire-and-forget effect, so this wait never
 * blocks profile boot, and the service is normally already published by the base
 * bundles the web app mounts before this plugin's own injection resolves. An
 * absent service is answered as "supported" by the caller, which is the
 * behaviour this plugin shipped before the probe existed.
 * @param ctx - plugin context.
 * @returns the service, or undefined when this deployment has none yet.
 */
async function waitForSubprocess(ctx: Context): Promise<SubprocessProbeFace | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const service = ctx.get('subprocess') as unknown as SubprocessProbeFace | undefined
    if (service !== undefined) return service
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return undefined
}

/** Materialize one WSL variant per healthy source preset. */
async function materializeVariants(
  agentPresets: AgentPresetsService,
  dshHome: string,
  paths: { shell: string; fs: string; relay: string; node: string; sandbox: string; search: string; jobs: string },
  persistentShell: boolean,
  track: (dispose: unknown) => void,
): Promise<void> {
  const presets = await agentPresets.list()
  const userRoot = join(dshHome, '.agent-presets')
  const generated = new Set<string>()
  // A broken roster entry is not this generator's to interpret, and a `wsl-*` entry
  // is one of its own outputs.
  const sources = presets.filter(preset => preset.broken === undefined && !isWslVariantId(preset.id))
  let produced = 0
  // A variant that failed this boot keeps whatever its PREVIOUS boot published.
  // Sweeping it would turn a partial failure into a total loss, which is the one
  // contract `tests/host-materialize.mjs` pins for the directory channel: when the
  // source directory vanishes mid-update, the complete variant beside it must stay.
  // Before #47 this held by accident — the abort skipped the sweep entirely.
  const retained = new Set<string>()
  for (const preset of sources) {
    const variantId = variantIdFor(preset.id)
    try {
      await materializeOne(agentPresets, preset, userRoot, paths, persistentShell, track, generated)
      produced += 1
    } catch (error) {
      // Until #47 a single failing source aborted this loop: on a real profile that
      // could not parse one composition, the roster ended with no variant at all AND
      // with the sweep below unrun, so the leftovers the report read as the symptom
      // outlived the generation. A failure is one variant's now, reported with its
      // own cause.
      retained.add(variantId)
      console.error(`dsh-wsl-workspace: WSL variant ${variantId} was not published — ${messageOf(error)}`)
    }
  }
  // The outcome is on the log, not only the route being alive. A healthy frame says
  // it without a trouble-word, because the compatibility gate greps this plugin's
  // own boot lines for one; `n/n` is what that gate counts.
  console.log(retained.size === 0
    ? `dsh-wsl-workspace: WSL preset variants: ${produced}/${sources.length} registered`
    : `dsh-wsl-workspace: WSL preset variants: ${produced}/${sources.length} registered, ${retained.size} not`)
  // Clean up the retired directory mechanism. `generated` holds the
  // directories the directory path wrote on THIS boot; from 0.1.7-alpha.1 on it is
  // always empty, because a variant is a declaration row and the roster no
  // longer scans this root at all — so every `wsl*` entry left here (the legacy
  // standalone `wsl` mode included) is inert leftover, and a `wsl-<mode>/`
  // beside a registered `wsl-<mode>` declaration would only mislead. An absent
  // root (a fresh install that never used the old mechanism) is not a failure.
  if (existsSync(userRoot)) {
    for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!/^wsl(-[a-z0-9-]+)?$/.test(entry.name)) continue
      if (generated.has(entry.name) || retained.has(entry.name)) continue
      rmSync(join(userRoot, entry.name), { recursive: true, force: true })
    }
  }
}

/**
 * Turn one healthy roster entry into its WSL variant, on whichever channel this
 * release publishes.
 * @param agentPresets - the roster face.
 * @param preset - the source entry to copy and amend.
 * @param userRoot - `<dshHome>/.agent-presets`, the retired directory root the
 *                   directory channel still publishes into.
 * @param paths - this installation's built provider files.
 * @param persistentShell - whether the world may mount the host PTY stack.
 * @param track - hand a registration's disposer to the effect that owns it.
 * @param generated - collects the directories this boot wrote, so the sweep can
 *                   tell them from leftovers.
 */
async function materializeOne(
  agentPresets: AgentPresetsService,
  preset: AgentPresetRosterEntry,
  userRoot: string,
  paths: { shell: string; fs: string; relay: string; node: string; sandbox: string; search: string; jobs: string },
  persistentShell: boolean,
  track: (dispose: unknown) => void,
  generated: Set<string>,
): Promise<void> {
  const variantId = variantIdFor(preset.id)
  const composition = await readPresetComposition(agentPresets, preset)
  const transformed = transformPresetForWsl(composition.content, paths.shell, paths.fs, persistentShell ? {
    relayPath: paths.relay,
    nodePath: paths.node,
    sandboxPath: paths.sandbox,
  } : undefined, paths.search, paths.jobs)
  // 0.1.7-alpha.1+ publishes a variant as a declaration row (the composition is
  // already the exact entry-list dialect the declaration wants, so the only
  // conversion is YAML back to rows); earlier releases still discover one as
  // a directory under the roster's scanned user root.
  if (typeof agentPresets.register === 'function') {
    const plugins = await parseVariantComposition(transformed)
    // A shipped mode keeps its bilingual label; a custom preset keeps the
    // display name it published, falling back to its id.
    const declaration: PresetDeclaration = {
      id: variantId,
      name: variantName(preset.id, composition.name ?? preset.name ?? preset.id),
      description: variantDescription(preset.id),
      ...(preset.order === undefined ? {} : { order: preset.order }),
      plugins,
    }
    track(await agentPresets.register(declaration))
    return
  }
  if (preset.path === undefined) {
    throw new Error(`agentPresets: roster entry "${preset.id}" carries no path on this release`)
  }
  const dir = join(userRoot, variantId)
  const staging = `${dir}.staging`
  rmSync(staging, { recursive: true, force: true })
  // A preset directory is an opaque, self-contained plugin unit. Mirror it
  // without interpreting local code or asset names, then overwrite only the
  // two files owned by this generator.
  cpSync(dirname(preset.path), staging, { recursive: true, force: true })
  writeFileSync(join(staging, 'agent.cordis.yml'), transformed, 'utf8')
  const labels = MODE_DISPLAY_LABELS[preset.id]
  let name = variantName(preset.id, preset.id)
  let orderLine = ''
  try {
    const meta = readFileSync(join(dirname(preset.path), 'preset.yml'), 'utf8')
    if (labels === undefined) {
      // Custom presets keep their own display name; shipped modes use the
      // bilingual labels above so both locales can identify the variant.
      const match = /^name:\s*(.+)$/m.exec(meta)
      if (match?.[1] !== undefined && match[1].trim() !== '') {
        // The scalar is copied out of the source's YAML as written, so a
        // quoted `name: 'Data mode'` would otherwise reach the picker with
        // its quotes doubled into the variant's own scalar.
        name = variantName(preset.id, unquoteScalar(match[1].trim()))
      }
    }
    // Inherit the source's declared order so the WSL variants line up with
    // the local modes in the roster (standard, PTC, minimal, cordis).
    const orderMatch = /^order:\s*(\d+)\s*$/m.exec(meta)
    if (orderMatch?.[1] !== undefined) orderLine = `order: ${orderMatch[1]}\n`
  } catch {
    // Absent or unreadable display metadata falls back to the id-based name.
  }
  writeFileSync(
    join(staging, 'preset.yml'),
    `name: ${yamlScalar(name)}\n`
    + orderLine
    + `description: ${yamlScalar(variantDescription(preset.id))}\n`,
    'utf8',
  )
  publishVariant(staging, dir)
  generated.add(variantId)
}

/** Function-plugin plugin contract. */
export const name = 'dsh-wsl-workspace'

/** Required services. */
export const inject = ['webServer']

/** Validated plugin config (schemastery applied the defaults). */
export const Config: z<Config> = z.object({
  route: z.string().default(DEFAULT_ROUTE),
})

/**
 * Apply the host half: materialize a `wsl-<mode>` variant for every healthy
 * roster preset, register the data route, and
 * contribute the per-session `DSH_WSL_DISTRO` managed-env fact so the WSL
 * shell executor can resolve a plain Linux `workdir` to the calling
 * session's distribution.
 * @param ctx - the host plugin context.
 * @param config - the validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const shellPath = join(packageRoot, 'lib', 'shell.js').replace(/\\/g, '/')
  const fsPath = join(packageRoot, 'lib', 'fs.js').replace(/\\/g, '/')
  // The persistent shell runs the host PTY backend on the relay, which starts
  // `wsl.exe … bash` under that PTY: two paths the generated preset must carry.
  const relayPath = join(packageRoot, 'lib', 'wsl-relay.js').replace(/\\/g, '/')
  const sandboxPath = join(packageRoot, 'lib', 'wsl-sandbox.js').replace(/\\/g, '/')
  // The in-distribution `grep`/`glob` twin that replaces the host search suite.
  const searchPath = join(packageRoot, 'lib', 'wsl-search.js').replace(/\\/g, '/')
  // The persistent shell has no `run_in_background` of its own; this is the
  // producer that gives the world's `job_*` tools something to track.
  const jobsPath = join(packageRoot, 'lib', 'wsl-jobs.js').replace(/\\/g, '/')

  const agentPresets = ctx.get('agentPresets') as unknown as AgentPresetsService | undefined
  if (agentPresets !== undefined) {
    ctx.effect(() => {
      // On 0.1.7-alpha.1+ the variants are declaration rows in Host state rather
      // than files, so the effect owns their disposers: a plugin unload or hot
      // reload retires them instead of leaving orphans the next apply could not
      // replace (`Duplicate agent preset: wsl-<mode>`).
      let stopped = false
      const disposers: (() => Promise<void>)[] = []
      const track = (dispose: unknown): void => {
        if (typeof dispose !== 'function') return
        const retire = dispose as () => Promise<void>
        if (stopped) {
          void Promise.resolve(retire()).catch(() => {})
          return
        }
        disposers.push(retire)
      }
      void (async () => {
        const persistentShell = await supportsPersistentShell(ctx)
        // The PTY backend starts `shellPath` with `shellArgs`, so the relay's
        // interpreter is this plugin's one choice in that stack. It has to be a
        // real node: on DSH Desktop `process.execPath` is the Electron
        // executable, and an Electron binary under a ConPTY writes nothing at
        // all — which is the "PTY shell exited during startup" failure of
        // issue #40. See `src/shared/relay-node.ts`.
        const relay = persistentShell ? await resolveRelayNode() : undefined
        if (relay !== undefined && isElectronHost()) {
          const detail = relay.rejected.length === 0 ? '' : ` (rejected: ${relay.rejected.join('; ')})`
          if (relay.fallback) {
            console.warn(`dsh-wsl-workspace: persistent shell: ${relay.source}${detail}`)
          } else {
            console.log(`dsh-wsl-workspace: persistent shell: relay interpreter is ${relay.path} — ${relay.source}${detail}`)
          }
        }
        await materializeVariants(agentPresets, dshHome, {
          shell: shellPath,
          fs: fsPath,
          relay: relayPath,
          node: (relay?.path ?? process.execPath).replace(/\\/g, '/'),
          sandbox: sandboxPath,
          search: searchPath,
          jobs: jobsPath,
        }, persistentShell, track)
      })().catch((error) => {
        // Variant generation is best-effort over a live roster: a missing or
        // unreadable source preset must not take the whole plugin down, but
        // the failure is surfaced loudly rather than hidden.
        console.error(`dsh-wsl-workspace: WSL preset-variant generation failed: ${messageOf(error)}`)
      })
      return () => {
        stopped = true
        for (const retire of disposers.splice(0, disposers.length)) {
          void Promise.resolve(retire()).catch(() => {})
        }
      }
    }, 'dsh-wsl-workspace: WSL preset variants')
  }

  const skills = ctx.get('skills') as unknown as WslSkillsRegistryFace | undefined
  if (skills !== undefined && typeof skills.registerProvider === 'function') {
    // The shipped skill-filesystem provider scans only the session cwd's
    // project root, so WSL workspaces whose `.dsh/skills` live in nested
    // projects would show an empty skill catalog. This provider mirrors the
    // host's project discovery for WSL UNC workspaces, bounded to the
    // workspace root (issue #10). The method check keeps a host whose
    // `skills` service exists with a different shape from breaking plugin
    // load; the provider is an enhancement, never a load-time requirement.
    ctx.effect(() => skills.registerProvider(
      control => new WslSkillsProvider(control),
    ), 'dsh-wsl-workspace: WSL workspace skills provider')
  }

  const shellEnv = ctx.get('shellEnv') as unknown as ShellEnvService | undefined
  if (shellEnv !== undefined) {
    ctx.effect(() => shellEnv.register({
      name: 'wsl-workspace-distro',
      variables: {
        DSH_WSL_DISTRO: {
          description: 'The WSL distribution of the calling session workspace, when the session cwd is a WSL UNC path.',
        },
        DSH_WSL_USER: {
          description: 'The Linux user of the calling session workspace, when the workspace has one configured.',
        },
      },
      resolve(execution) {
        const cwd = execution.agent?.session.header.cwd
        const unc = cwd === undefined ? null : parseWslUnc(cwd)
        if (unc !== null) {
          const username = getWorkspaceUsername(joinUnc(unc.distro, unc.linuxPath))
          return username === undefined || username === ''
            ? { DSH_WSL_DISTRO: unc.distro }
            : { DSH_WSL_DISTRO: unc.distro, DSH_WSL_USER: username }
        }
        // A Windows-drive cwd belongs to a `/mnt/<drive>` WSL workspace (9P
        // cannot serve drvfs, so those register under their drive path): the
        // stored distro drives `wsl.exe -d` for bash.
        if (cwd !== undefined && /^[A-Za-z]:[\\/]/.test(cwd)) {
          const entry = getWindowsWorkspace(cwd)
          if (entry !== undefined && entry.distro !== undefined && entry.distro !== '') {
            return entry.username === undefined || entry.username === ''
              ? { DSH_WSL_DISTRO: entry.distro }
              : { DSH_WSL_DISTRO: entry.distro, DSH_WSL_USER: entry.username }
          }
        }
        return {}
      },
    }), 'dsh-wsl-workspace: per-session distro env fact')
  }

  const webServer = ctx.get('webServer') as unknown as WebServerService
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: resolved.route,
    handler: async (req, res) => {
      if (!isLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readBody(req)
      } catch (error) {
        json(res, 400, { ok: false, error: messageOf(error) })
        return
      }
      const method = typeof body.method === 'string' ? body.method : ''
      const params = body.params === undefined ? {} : body.params
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        json(res, 400, { ok: false, error: 'params must be an object' })
        return
      }
      try {
        const value = await dispatch(method, params as Record<string, unknown>)
        json(res, 200, { ok: true, value })
      } catch (error) {
        json(res, 200, { ok: false, error: messageOf(error) })
      }
    },
  }), 'dsh-wsl-workspace: dialog data route')
}

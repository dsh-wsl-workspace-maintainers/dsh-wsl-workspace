/**
 * WSL preset-variant generator. For every healthy source preset the roster
 * supplies, a `wsl-<id>` variant is materialized under the roster's user
 * root: the source composition with its shell/filesystem world replaced by
 * the WSL providers, so any mode (standard, minimal, code, cordis, user
 * presets) can run on top of a WSL execution world. The execution world is
 * therefore orthogonal to the mode instead of a mode itself.
 *
 * The transformation is text-level on the top-level rows of the composition
 * (the shape all shipped presets share), with surgical edits for the known
 * special groups; unknown shapes are kept verbatim where possible.
 * @module dsh-wsl-workspace/host/variants
 */

import { createRequire } from 'node:module'

/** Top-level rows that name the execution world and are replaced by the variant's own. */
const WORLD_ROWS = new Set(['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'str-replace-editor', 'tool-str-replace-editor', 'wsl-world', 'filesystem', 'persistent-shell', 'persistent-bash', 'bash-wsl', 'persistent-pwsh', 'terminal-bash', 'terminal-pwsh', 'custom-bash', 'bootstrap-filesystem'])

/** Execution-world rows that register the model-facing editor tool. */
const EDITOR_ROWS = new Set(['str-replace-editor', 'tool-str-replace-editor'])

/**
 * The package the copied delegation row mounts.
 *
 * A shipped preset carries rows naming `@deepseek-ai/dsh-tool-subagent` (inside a delegation
 * group on 0.2.x), and this generator used to keep them verbatim like every other
 * non-world row — which is how a Desktop host came to hold one live `tool-subagent` composition
 * per preset. Upstream's own registration gate is missing (deepseek-ai/deepseek-harness
 * discussion #6751): without `belongsToComposition` on the `agent/created` install path, six
 * live compositions — the three shipped presets plus this generator's three variants — make
 * every new session fail with `tool "subagent" is already registered in this scope` (issue
 * #60). While the host family lacks the gate ({@link hostLacksSubagentGate}) the variant drops
 * the copied row, so this generator adds no second composition and sessions keep working; a
 * variant without the row has no `subagent`/`list_subagent_models` tools, which is a missing
 * feature where the alternative was a missing session.
 */
const SUBAGENT_DELEGATION_PACKAGE = '@deepseek-ai/dsh-tool-subagent'

/** The row ids this generator mounts inside its own world group. */
const WSL_WORLD_PROVIDER_IDS = ['shell-wsl', 'fs-wsl']

/**
 * The row id of the world's own image read.
 *
 * A preset copied from a generated variant carries it *inside* the `wsl-world` group, so
 * {@link isWslWorldGroup} retires the copied group wholesale and this generator re-emits exactly
 * one image row; the id is named here because the row it mounts is the answer to issue #54 (see
 * {@link wslWorldGroup}).
 */
const IMAGE_ROW_ID = 'read-image-wsl'

/**
 * How long the door's terminal backend may see no output before it returns control
 * without having recognised a prompt — the host's `idleSilenceMs`, default 3000.
 *
 * The number comes from a measurement, not from taste (2026-10-06, real ConPTY, real
 * distribution, a local measurement report): a send whose prompt the backend
 * recognises settles in 75–136 ms, while every send whose prompt it does not recognise
 * costs the full default — 3.0–3.6 s, measured across seven sends — which is what a
 * whole keyboard conversation would be made of. The recognition path is what a caller
 * gets whenever the previous prompt's tail arrived intact; this knob only bounds the
 * fallback, so lowering it trades the host default's patience for the agent's. 1200 ms
 * stays ~9x above the measured recognition cost and ~2.5x below the default, and the
 * one case it cuts short — a program that is quiet *and* still working — is exactly
 * what the send's own note reports as unresolved instead of claiming a prompt.
 */
const TERMINAL_QUIET_MS = 1_200

/**
 * Whether a top-level row is this generator's own WSL world group.
 *
 * A preset copied from a generated variant (a user renaming `wsl-standard` to
 * their own mode, say) carries the group under whatever id the copy kept, so
 * the mounted provider ids identify it even when the row id changed. Without
 * that check the variant would carry two world groups and the loader refuses
 * the whole preset with `duplicate loader entry id: wsl-world`.
 * @param block - the row's lines.
 * @returns true when the row mounts this generator's WSL providers.
 */
function isWslWorldGroup(block: readonly string[]): boolean {
  const text = block.join('\n')
  return WSL_WORLD_PROVIDER_IDS.some((id) => new RegExp(`^\\s+- id: ${id}$`, 'm').test(text))
}

/**
 * The persistent-shell rows: the host's own PTY registry and its config-driven
 * backend, told to run this plugin's relay (so the shell is a WSL one), plus
 * the persistent tool that consumes them.
 *
 * Two shapes matter here. The registry is an agent-owned service — the shipped
 * `persistent-shell` group keeps it in its own `terminals` realm for that
 * reason — so this is a nested group of the world rather than three flat rows.
 * And the persistent tool registers the tool name **`bash`**, exactly like the
 * one-shot `dsh-tool-bash` row it replaces: both cannot be mounted (the tools
 * registry rejects the duplicate and the whole preset fails to load), which is
 * also why DSH's own Minimal mode describes itself as "a single-tool agent with
 * a persistent shell". So a world with the relay paths swaps the shell tool
 * instead of adding one, and a world without them keeps the one-shot row.
 *
 * The session tier mounts the same registry and backend for a different
 * consumer: the keyboard door (`wsl_terminal`), which is the only thing in this
 * world that drives a PTY. It must NOT mount the host's persistent tool — that
 * tool's completion check is what issue #51 is about, and it would collide with
 * the session `bash` row over the `bash` name.
 */
function persistentShellRows(
  relayPath: string,
  nodePath: string,
  bashPath: string,
  terminalToolPath: string,
  mode: 'session' | 'pty',
): string[] {
  if (mode === 'session') {
    // The pipe-driven shell: one row, no PTY, no terminal readiness contract. It registers the
    // same `bash` name, so it still takes the one-shot row's place.
    return [
      '    # Persistent shell: this plugin drives one long-lived `bash` over',
      '    # pipes and ends each command with a record carrying its own nonce,',
      '    # so completion is an event rather than a match against a terminal the',
      '    # shell is allowed to repaint (issue #51 point 3: three calls hung',
      '    # 303.8 s in a real Desktop session before the host wiped the shell).',
      '    - id: bash-wsl',
      `      name: '${bashPath.replace(/'/g, "''")}'`,
      '      config:',
      '        timeoutMs: 120000',
      '        bootTimeoutMs: 20000',
      // The door needs the host's PTY stack, but not the host's persistent tool:
      // the same registry + backend pair as the tier above, consumed by this
      // plugin's `wsl_terminal` instead of by a tool that ends a command by
      // matching text on a screen the shell may repaint.
      '    # The keyboard door: the host terminal registry and its backend, pointed',
      '    # at this plugin\'s relay, so an interactive `wsl_terminal` session is a',
      '    # real `wsl.exe … bash -i` under a real PTY. Mounted beside the pipe',
      '    # shell, not instead of it: the pipe carries every byte and is the',
      '    # default; this is only for what a pipe cannot answer (a password, a',
      '    # fingerprint, a REPL, a TUI).',
      '    - id: terminal-door',
      '      name: cordis:group',
      '      group: true',
      '      isolate:',
      '        terminals: true',
      '      config:',
      '        - id: pty',
      "          name: '@deepseek-ai/dsh-terminal'",
      '        - id: terminal-wsl',
      "          name: '@deepseek-ai/dsh-terminal-bash'",
      '          config:',
      '            backendType: wsl',
      '            shellDialect: bash',
      `            shellPath: '${nodePath.replace(/'/g, "''")}'`,
      '            shellArgs:',
      `              - '${relayPath.replace(/'/g, "''")}'`,
      `            idleSilenceMs: ${TERMINAL_QUIET_MS}`,
      '        - id: terminal-door-tool',
      `          name: '${terminalToolPath.replace(/'/g, "''")}'`,
      '          config:',
      `            quietMs: ${TERMINAL_QUIET_MS}`,
    ]
  }
  return [
    '    # Persistent shell: the host PTY registry and its backend, running',
    '    # this plugin\'s relay, which hands the PTY to `wsl.exe … bash`',
    '    # (distribution and user come from the session). It registers the',
    '    # `bash` tool, so it takes the place of the one-shot row above.',
    '    - id: persistent-shell',
    '      name: cordis:group',
    '      group: true',
    '      isolate:',
    '        terminals: true',
    '      config:',
    '        - id: pty',
    "          name: '@deepseek-ai/dsh-terminal'",
    '        - id: terminal-wsl',
    "          name: '@deepseek-ai/dsh-terminal-bash'",
    '          config:',
    '            backendType: wsl',
    '            shellDialect: bash',
    `            shellPath: '${nodePath.replace(/'/g, "''")}'`,
    '            shellArgs:',
    `              - '${relayPath.replace(/'/g, "''")}'`,
    '        - id: persistent-bash',
    "          name: '@deepseek-ai/dsh-tool-bash-persistent'",
    '          config:',
    '            backendType: wsl',
    ...SHELL_DESCRIPTION_ROWS,
  ]
}

/**
 * The persistent tool's model-facing description, replacing the host default.
 *
 * The host tool's default says only that state persists, and its own Minimal
 * preset goes further in the wrong direction by suggesting `sleep 10 &`. Both
 * facts a WSL session needs are missing, and both were learned the hard way:
 *
 *  - The shell is one process for the whole Agent, so a `cd` in one call decides
 *    where the *next* call starts. A model that read the one-shot tool's contract
 *    ("each call runs in a fresh shell — pass `workdir` instead of using `cd`")
 *    will be surprised, and a probe left in `/tmp` makes every later relative path
 *    resolve somewhere it never named.
 *  - The host wraps each command as `eval -- $'…'`. A trailing `&` therefore
 *    backgrounds the *whole* wrapped command: the tool's completion marker is
 *    printed before the work runs, so the call reports no output and exit code 0
 *    while the real output arrives later and can land inside the next call's
 *    output window. `( … ) &` on its own line keeps the `&` on the subshell and
 *    leaves the wrapper's sequencing intact.
 *
 * `description` is a supported key on every declared release (its `Config` schema
 * carries it from 0.1.0-rc.7 on), so the override is version-safe.
 */
const SHELL_DESCRIPTION_ROWS = [
  '            description: |-',
  '              Run commands in a persistent bash shell inside this WSL distribution. State, including',
  '              the current directory and exported environment variables, persists across calls: use',
  '              absolute paths or an explicit `cd` at the start of a command instead of relying on where',
  '              the previous call left the shell. The shell runs as the workspace\'s Linux user; Windows',
  '              files are reachable as /mnt/<drive>, and no toolchain install is required.',
  '              * This tool takes `command` only. It has no `run_in_background` parameter, and passing',
  '              one is ignored - use the `bash_background` tool when the mode provides it, or background',
  '              a subshell as below.',
  '              * To leave work running without a tracked job, put it in a subshell with the `&` on its',
  '              own line: `( long-job > log 2>&1 ) &`. Then poll the log file in a later call.',
  '              * Never end a `&&` chain with `&`. That backgrounds the whole command, so the call',
  '              returns immediately with no output and exit code 0, and the real output arrives later,',
  '              possibly inside the next call\'s output.',
  '              * Avoid commands that wait for stdin: an interactive foreground child can run until the',
  '              command timeout, and a timeout resets the shell and discards its state.',
]

/** The injected WSL world group: providers + the bash/fs consumers, entry-local. */
function wslWorldGroup(
  shellPath: string,
  fsPath: string,
  includeEditor: boolean,
  persistent?: { relayPath: string; nodePath: string; sandboxPath: string; bashPath: string; terminalTool: string; mode: 'session' | 'pty' },
  searchPath?: string,
  jobsPath?: string,
  sawJobs = false,
  imagePath?: string,
): string {
  return [
    '# ── WSL execution world (dsh-wsl-workspace variant) ─────────────────────',
    '# The shell and fs services are provided entry-locally (the isolate',
    '# realm); host services (tools registry, shell-env, jobs) fall through.',
    '- id: wsl-world',
    "  name: cordis:group",
    '  group: true',
    '  isolate:',
    '    shell: true', // portability-allow: a YAML fragment for a plugin's own `isolate:` block, not a spawn option
    '    fs: true',
    // The Windows confinement runner cannot describe a Linux path, so the
    // world owns the capability (see the sandbox row below) whenever it mounts
    // a shell that would otherwise call it.
    ...(persistent === undefined ? [] : ['    sandbox: true']),
    '  config:',
    `    - id: shell-wsl`,
    `      name: '${shellPath.replace(/'/g, "''")}'`,
    '    - id: fs-wsl',
    `      name: '${fsPath.replace(/'/g, "''")}'`,
    ...(persistent === undefined
      ? []
      : [
          '    - id: sandbox-wsl',
          `      name: '${persistent.sandboxPath.replace(/'/g, "''")}'`,
        ]),
    // The shell tool comes from the persistent-shell group when this world has
    // one (same `bash` name, so only one of the two may be mounted).
    ...(persistent === undefined
      ? ['    - id: tool-bash', "      name: '@deepseek-ai/dsh-tool-bash'"]
      : []),
    '    - id: tool-fs',
    "      name: '@deepseek-ai/dsh-tool-fs'",
    // #105: `dsh-tool-fs` registers `read_image` unless `readImage` is turned off, and from 0.2.1 the
    // tool layer no longer lets two rows claim one name — the variant simply refuses to mount. The
    // world's own realm-safe row below is the one that stays, so the host's is switched off here.
    '      config:',
    '        readImage: false',
    // The world's answer for `read_image`, mounted beside the row whose registration of it cannot
    // reach this realm. See `src/host/wsl-image-tool.ts` for what it takes over and why the
    // isolation above stays.
    ...(imagePath === undefined
      ? []
      : [
          `    - id: ${IMAGE_ROW_ID}`,
          `      name: '${imagePath.replace(/'/g, "''")}'`,
        ]),
    // `grep`/`glob` run inside the distribution, not through the host suite's
    // Windows ripgrep: same tool names, same model-facing contract, Linux paths
    // and Linux symlinks. Older editor builds pass no cwd, so the provider
    // inherits it from the current tool execution.
    ...(searchPath === undefined
      ? []
      : [
          '    - id: search-wsl',
          `      name: '${searchPath.replace(/'/g, "''")}'`,
        ]),
    // The world's `bash` is the host's *persistent* tool, whose schema declares
    // only `command`: nothing here can start a tracked background job, so the
    // host's `job_*` tools would always answer "no background jobs" and a
    // `run_in_background` argument would be silently ignored. This row restores
    // the producer — but only for a source that also mounts the `job_*` control
    // tools, because a producer without a reader hands out ids nothing can use
    // (Minimal mode mounts neither). A world that keeps the one-shot bash row
    // needs no producer either: that tool carries `run_in_background` itself.
    ...(jobsPath === undefined || persistent === undefined || !sawJobs
      ? []
      : [
          '    - id: jobs-wsl',
          `      name: '${jobsPath.replace(/'/g, "''")}'`,
        ]),
    // The editor resolves through this entry-local WSL fs.
    // Anchored-family presets require this name during bootstrap.
    ...(includeEditor
      ? [
          '    - id: str-replace-editor',
          "      name: '@deepseek-ai/dsh-tool-str-replace-editor'",
          '      config:',
          '        maxOutputChars: 16000',
        ]
      : []),
    ...(persistent === undefined ? [] : persistentShellRows(persistent.relayPath, persistent.nodePath, persistent.bashPath, persistent.terminalTool, persistent.mode)),
    '',
  ].join('\n')
}

/**
 * The sentence appended to a standard-like persona when the variant runs in WSL.
 *
 * It carries no `{{…}}` group on purpose. A persona is a template, and
 * `dsh-system-prompt` resolves every group against the variables registered for
 * that assembly, throwing `unknown prompt variable` before any model request
 * when one is missing. DSH 0.2.x registers only `provider` and `model` — the
 * working directory moved to the working-directory service, which supplies the
 * path as literal user context — so a `{{cwd}}` here killed every `wsl-*`
 * session at turn 1 step 1 (issue #87). The path is still the model's to learn;
 * it just arrives from the service that owns it, not from a template group this
 * plugin would have to keep in sync with someone else's registry.
 */
const PERSONA_APPEND = ' Your working directory is inside a WSL (Windows Subsystem for Linux) distribution: the bash tool and the file read/write/edit tools use Linux paths, and the Windows filesystem is reachable as /mnt/<drive> for file migration.'

/** The upstream local-skill provider row, whose watcher cannot watch a UNC share. */
const SKILL_FILESYSTEM_ROW = 'skill-filesystem'

/**
 * Turn the local skill provider's watcher off inside a WSL variant.
 *
 * `@deepseek-ai/dsh-skill-filesystem` reports an INCOMPLETE observation when
 * its watcher fails to start, and `dsh-tool-skill` withholds the whole catalog
 * while a snapshot is incomplete. chokidar cannot watch
 * `\\wsl.localhost\<distro>\...`, so in a WSL session the model never sees the
 * catalog at all - `skill` still loads one by name, but nothing tells the model
 * which skills exist. With the watcher off the discovery completes (the
 * plugin's own provider rescans the share on demand, and the next session gets
 * a fresh catalog); the price is no live refresh inside one running session,
 * which never worked on this substrate anyway.
 * @param block - the row's lines.
 * @returns the row's lines with `watch: false` merged into its config.
 */
function disableSkillWatch(block: readonly string[]): string[] {
  const lines = [...block]
  // An explicit `watch:` from the author wins.
  if (lines.some(line => /^\s*watch:/.test(line))) return lines
  const configIndex = lines.findIndex(line => /^\s*config:\s*$/.test(line))
  if (configIndex >= 0) {
    const childIndent = `${/^(\s*)/.exec(lines[configIndex] ?? '')?.[1] ?? '  '}  `
    lines.splice(configIndex + 1, 0, `${childIndent}watch: false`)
    return lines
  }
  const rowIndent = /^(\s*)/.exec(lines[0] ?? '')?.[1] ?? ''
  // Insert before the row block's trailing blank line, not after it.
  let insertAt = lines.length
  while (insertAt > 0 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1
  lines.splice(insertAt, 0, `${rowIndent}  config:`, `${rowIndent}    watch: false`)
  return lines
}

/**
 * The top-level rows of one composition, as (startLine, endLineExclusive) spans.
 *
 * A row starts at any column-0 sequence item, not only `- id: `: a row written
 * `- name: …` with its `id:` further down is still its own row, and must not be
 * folded into the row before it. Column 0 is unambiguous — any block scalar or
 * continuation line inside a row is indented deeper than the row's own keys.
 */
function topLevelSpans(lines: readonly string[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  let start = -1
  for (let index = 0; index < lines.length; index++) {
    if (/^-(?: |$)/.test(lines[index] ?? '')) {
      if (start >= 0) spans.push({ start, end: index })
      start = index
    }
  }
  if (start >= 0) spans.push({ start, end: lines.length })
  return spans
}

/** One `id:` scalar: plain (up to a comment), single- or double-quoted. */
const ID_SCALAR = String.raw`('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s#'"][^#]*?)\s*(?:#.*)?$`

/**
 * The row id of a top-level span, or undefined when the row names none.
 * The id is read from the item line (`- id: x`) or, failing that, from the row's
 * own key level (`  id: x`, exactly two spaces), quoted or not.
 */
function spanId(lines: readonly string[], span: { start: number; end: number }): string | undefined {
  const head = new RegExp(`^- id: ${ID_SCALAR}`).exec(lines[span.start] ?? '')
  if (head !== null) return unquoteScalar(head[1] ?? '')
  const own = new RegExp(`^  id: ${ID_SCALAR}`)
  for (let index = span.start + 1; index < span.end; index++) {
    const match = own.exec(lines[index] ?? '')
    if (match !== null) return unquoteScalar(match[1] ?? '')
  }
  return undefined
}

/** Persona config scalars that carry model-facing text, in append preference order. */
const PERSONA_TARGET_FIELDS = ['suffix', 'text', 'prefix'] as const

/** One persona config scalar: where it sits, and whether it is a block header. */
interface PersonaTarget {
  /** Line index of the scalar inside the persona block. */
  index: number
  /** Field name: `suffix`, `text` or `prefix`. */
  field: string
  /** Indentation of the scalar's own line. */
  indent: number
  /** Block header (`>-`, `|-`, …) when the scalar is folded/literal, else ''. */
  header: string
  /** Unquoted inline value when the scalar is inline, else ''. */
  inline: string
}

/** Strip one layer of YAML quoting so a value can move into a block scalar. */
export function unquoteScalar(value: string): string {
  const single = /^'(.*)'$/s.exec(value)
  if (single !== null) return (single[1] ?? '').replace(/''/g, "'")
  const double = /^"(.*)"$/s.exec(value)
  return double !== null ? (double[1] ?? '') : value
}

/**
 * Locate the persona scalar this transform amends.
 *
 * DSH moved the model-facing prompt text across releases: `text` up to
 * v0.1.2-rc.1, and `prefix` + `suffix` from v0.1.3-alpha.2 on. `suffix` wins
 * when both exist because it carries the working-directory sentence, so the
 * appended note lands exactly where the legacy `text` block put it; `prefix`
 * is the last resort for a composition that has neither. A known field with an
 * empty value is not amendable.
 * @param block - the persona row's lines.
 * @returns the target scalar, or undefined when the row carries none.
 */
function personaTarget(block: readonly string[]): PersonaTarget | undefined {
  for (const field of PERSONA_TARGET_FIELDS) {
    for (let index = 0; index < block.length; index += 1) {
      const match = new RegExp(`^(\\s*)${field}:\\s*(.*)$`).exec(block[index] ?? '')
      if (match === null) continue
      const indent = match[1]?.length ?? 0
      const rest = (match[2] ?? '').trim()
      if (rest === '' || /^[|>][+-]?$/.test(rest)) {
        return { index, field, indent, header: rest, inline: '' }
      }
      return { index, field, indent, header: '', inline: unquoteScalar(rest) }
    }
  }
  return undefined
}

/**
 * Index of the last line belonging to the block scalar whose header is at
 * `headerIndex`. A non-blank line at or above the header's indentation is the
 * next sibling key and ends the scalar — without that stop a persona carrying
 * both `suffix` and `prefix` blocks would take the note in the wrong one.
 * @param block - the persona row's lines.
 * @param headerIndex - index of the `field: >-` header line.
 * @param indent - the header's own indentation.
 * @returns the last content line's index, or -1 when the scalar is empty.
 */
function lastBlockLine(block: readonly string[], headerIndex: number, indent: number): number {
  let last = -1
  for (let index = headerIndex + 1; index < block.length; index += 1) {
    const line = block[index] ?? ''
    if (line.trim() === '') continue
    const lineIndent = /^(\s*)/.exec(line)?.[1]?.length ?? 0
    if (lineIndent <= indent) break
    last = index
  }
  return last
}

/** Whether a top-level span is a `persona` row this transform may amend. */
function appendablePersona(lines: readonly string[], span: { start: number; end: number }): boolean {
  const block = lines.slice(span.start, span.end)
  // `complete: true` asks the persona plugin for no runtime context at all.
  if (block.join('\n').includes('complete: true')) return false
  const target = personaTarget(block)
  if (target === undefined) return false
  return target.header === ''
    ? target.inline !== ''
    : lastBlockLine(block, target.index, target.indent) >= 0
}

/**
 * Append the WSL sentence to a persona row's model-facing scalar, in place.
 *
 * A block scalar takes the sentence as a sibling line, which is what the
 * legacy `text: >-` form always did. An inline scalar cannot: it is folded into
 * a block scalar first, so the sentence joins it the same way (and the model
 * sees the same text it saw before v0.1.3-alpha.2).
 * @param lines - the whole composition's lines.
 * @param span - the persona row's span.
 * @returns the persona row's lines, amended when a target was found.
 */
function appendPersona(lines: readonly string[], span: { start: number; end: number }): string[] {
  const block = [...lines.slice(span.start, span.end)]
  const target = personaTarget(block)
  if (target === undefined) return block
  const pad = ' '.repeat(target.indent)
  if (target.header !== '') {
    const last = lastBlockLine(block, target.index, target.indent)
    if (last < 0) return block
    const textIndent = /^(\s*)/.exec(block[last] ?? '')?.[1] ?? `${pad}  `
    block.splice(last + 1, 0, `${textIndent}${PERSONA_APPEND}`)
    return block
  }
  const child = `${pad}  `
  block.splice(
    target.index,
    1,
    `${pad}${target.field}: >-`,
    `${child}${target.inline}`,
    `${child}${PERSONA_APPEND.trim()}`,
  )
  return block
}

interface CompositionEntry {
  id?: unknown
  name?: unknown
  config?: unknown
}

/** The load/dump API of the package's own js-yaml 4.x dependency that this module uses. */
interface EntryYamlEngine {
  load(source: string, options: { schema: unknown }): unknown
  dump(value: unknown, options: { schema: unknown; noRefs: boolean; lineWidth: number }): string
  JSON_SCHEMA: { extend(type: unknown): unknown }
  Type: new (tag: string, options: {
    kind: 'scalar'
    resolve(data: unknown): boolean
    construct(data: unknown): unknown
    instanceOf: abstract new (...args: never[]) => unknown
    represent(data: unknown): string
  }) => unknown
}

/** A host `!!js` scalar, carried as data: never evaluated here, written back as the same tag. */
class JsExpression {
  readonly __jsExpr: string
  constructor(source: string) { this.__jsExpr = source }
}

/** A parse/dump pair speaking the host entry-list dialect (JSON schema plus `!!js`). */
interface EntryYaml {
  load(source: string): unknown
  dump(rows: unknown): string
}

let entryYaml: EntryYaml | undefined

/**
 * The entry-list dialect, built once. Loading stays lazy: importing the plugin alone must not
 * require a materialized dependency tree. Resolve relative to this plugin, not a sibling's YAML major.
 */
function entryYamlEngine(): EntryYaml {
  if (entryYaml !== undefined) return entryYaml
  const require = createRequire(import.meta.url)
  const enginePath = require.resolve('js-yaml')
  const { version } = require('js-yaml/package.json') as { version: string }
  const where = (error: unknown): Error =>
    new Error(`js-yaml ${version} at ${enginePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  let yaml: EntryYamlEngine
  let schema: unknown
  try {
    yaml = require('js-yaml') as EntryYamlEngine
    if (typeof yaml.load !== 'function' || typeof yaml.dump !== 'function' || typeof yaml.Type !== 'function' || typeof yaml.JSON_SCHEMA?.extend !== 'function') {
      throw new Error('this copy cannot express the entry-list dialect (requires the 4.x Type/JSON_SCHEMA.extend API)')
    }
    // Match the host's !!js dialect as data. No expression is evaluated here.
    schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: data => typeof data === 'string',
      construct: data => new JsExpression(String(data)),
      instanceOf: JsExpression,
      represent: data => (data as JsExpression).__jsExpr,
    }))
  } catch (error) {
    throw where(error)
  }
  entryYaml = {
    load(source) {
      try { return yaml.load(source, { schema }) } catch (error) { throw where(error) }
    },
    dump(rows) {
      try { return yaml.dump(rows, { schema, noRefs: true, lineWidth: -1 }) } catch (error) { throw where(error) }
    },
  }
  return entryYaml
}

/** The parsed entry list of a composition (an empty document is an empty list). */
function entryRows(source: string): unknown[] {
  const rows = entryYamlEngine().load(source)
  if (rows === undefined || rows === null) return []
  if (!Array.isArray(rows)) throw new Error('source composition did not parse as an entry list')
  return rows
}

/** Whether actual entry nodes mount delegation, never arbitrary config/text data. */
function mountsSubagentDelegation(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) return false
  seen.add(value)
  const entry = value as CompositionEntry
  if (entry.name === SUBAGENT_DELEGATION_PACKAGE) return true
  return entry.name === 'cordis:group' && Array.isArray(entry.config)
    && entry.config.some(member => mountsSubagentDelegation(member, seen))
}

/**
 * Parse once to decide which top-level text spans must go, without reserializing.
 * Block scalars, multiline quotes and ordinary config.name values are data, not
 * mounts. Parsing the whole document also preserves cross-entry anchors/aliases.
 * The caller drops a carrying group whole: its workflow/control siblings require
 * the delegation provider's `subagents` service (issue #132).
 */
function delegationRowIds(rows: readonly unknown[]): Set<string> {
  const dropped = new Set<string>()
  const seenIds = new Set<string>()
  for (const value of rows) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as CompositionEntry
    if (typeof entry.id !== 'string' || seenIds.has(entry.id)) continue
    seenIds.add(entry.id)
    if (mountsSubagentDelegation(entry)) dropped.add(entry.id)
  }
  return dropped
}

/**
 * Why a generated variant is not safe to mount, or undefined when it is: it must parse (a dropped
 * span can take an anchor a kept row still aliases), and no row may still mount delegation (a row
 * the text-level spans could not attribute to its parsed id is otherwise copied through, which is
 * the #60/#132 double registration this drop exists to prevent).
 */
function unsafeVariant(text: string): string | undefined {
  let rows: unknown[]
  try {
    rows = entryRows(text)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return rows.some(row => mountsSubagentDelegation(row)) ? `a row still mounts ${SUBAGENT_DELEGATION_PACKAGE}` : undefined
}

/**
 * The source re-emitted from its parsed rows without the delegation rows: the fallback when the
 * text-level drop is unsafe. Aliases are expanded in place (`noRefs`), so nothing can dangle, and
 * every row comes out in the plain `- key: value` shape the span reader handles. Comments and
 * formatting are lost, which is why this is only the fallback.
 */
function sourceWithoutDelegation(rows: readonly unknown[], dropped: ReadonlySet<string>): string {
  const seenIds = new Set<string>()
  const kept = rows.filter((value) => {
    if (value === null || typeof value !== 'object') return true
    const id = (value as CompositionEntry).id
    // A row with no usable id cannot be loaded by id, but a mount is still a mount.
    if (typeof id !== 'string') return !mountsSubagentDelegation(value)
    // Same first-occurrence rule as the text path: a later duplicate is dropped.
    if (seenIds.has(id)) return false
    seenIds.add(id)
    return !dropped.has(id)
  })
  return kept.length === 0 ? '' : entryYamlEngine().dump(kept)
}

/**
 * Transform one source preset composition into its WSL variant: drop the
 * execution-world rows, keep everything else verbatim, and append the WSL
 * world group. A row id that appears twice in the source is kept once, and a
 * world group the source already carries (a preset copied from a generated
 * variant) is replaced rather than duplicated, so the variant always mounts
 * exactly one world pointing at this installation's providers.
 *
 * The source's own persistent-shell group is not re-added as such: it registers
 * the same `bash` tool name as the WSL world's `dsh-tool-bash`, and the tools
 * registry rejects duplicates within one preset layer — the whole variant fails
 * to mount and the session falls back to another preset. Its PTY *backend*, on
 * the other hand, is exactly what a stateful WSL shell needs, and it is
 * config-driven: given the relay in {@link persistentShellRows} it runs
 * `wsl.exe … bash` under the host's PTY, and its tool registers the separate
 * `persistent-bash` name, so the one-shot `bash` above stays as it is.
 * @param source - the source composition text.
 * @param shellPath - absolute path of the plugin's built WSL shell provider.
 * @param fsPath - absolute path of the plugin's built WSL fs provider.
 * @param persistent - the relay, interpreter and sandbox provider a stateful
 *   shell needs; omit to generate a world without the persistent-shell rows.
 * @param searchPath - absolute path of the plugin's built in-distribution
 *   `grep`/`glob` tools; mounted only for a source that had `tool-fs-search`.
 * @param jobsPath - absolute path of the plugin's built background-job producer
 *   for the persistent shell; mounted only alongside that shell.
 * @param imagePath - absolute path of the plugin's built image read, which answers for
 *   `read_image` inside this realm; mounted only when a build is supplied for it.
 * @param options - `dropSubagentDelegation`: drop the source's copied delegation row instead of
 *   keeping it verbatim (issue #60, see {@link SUBAGENT_DELEGATION_PACKAGE}).
 * @returns the variant composition text.
 */
export function transformPresetForWsl(
  source: string,
  shellPath: string,
  fsPath: string,
  persistent?: { relayPath: string; nodePath: string; sandboxPath: string; bashPath: string; terminalTool: string; mode: 'session' | 'pty' },
  searchPath?: string,
  jobsPath?: string,
  imagePath?: string,
  options?: { dropSubagentDelegation?: boolean },
): string {
  const build = (text: string, drop: ReadonlySet<string>): string =>
    transformText(text, drop, shellPath, fsPath, persistent, searchPath, jobsPath, imagePath)
  if (options?.dropSubagentDelegation !== true) return build(source, new Set())
  const rows = entryRows(source)
  const delegationIds = delegationRowIds(rows)
  const verbatim = build(source, delegationIds)
  if (unsafeVariant(verbatim) === undefined) return verbatim
  // The text-level drop left an alias without its anchor, or a delegation row it could not
  // place: rebuild from the parsed rows instead, and refuse outright if even that is unsafe.
  const rebuilt = build(sourceWithoutDelegation(rows, delegationIds), new Set())
  const problem = unsafeVariant(rebuilt)
  if (problem !== undefined) throw new Error(`cannot drop the delegation rows safely: ${problem}`)
  return rebuilt
}

/** The text-level transform behind {@link transformPresetForWsl}, dropping the given row ids. */
function transformText(
  source: string,
  delegationIds: ReadonlySet<string>,
  shellPath: string,
  fsPath: string,
  persistent?: { relayPath: string; nodePath: string; sandboxPath: string; bashPath: string; terminalTool: string; mode: 'session' | 'pty' },
  searchPath?: string,
  jobsPath?: string,
  imagePath?: string,
): string {
  const lines = source.split('\n')
  const spans = topLevelSpans(lines)
  const kept: string[] = []
  const seen = new Set<string>()
  let sawEditor = false
  let sawSearch = false
  let sawJobs = false
  let personaAppended = false
  for (const span of spans) {
    const id = spanId(lines, span)
    if (id === undefined) {
      kept.push(...lines.slice(span.start, span.end))
      continue
    }
    // Two top-level rows with one id are a loader error ("duplicate loader
    // entry id: <id>"), which makes the whole variant unmountable, so the first
    // occurrence wins and a copied later one is dropped.
    if (seen.has(id)) continue
    seen.add(id)
    const block = lines.slice(span.start, span.end)
    if (WORLD_ROWS.has(id) || isWslWorldGroup(block)) {
      if (EDITOR_ROWS.has(id)) sawEditor = true
      if (id === 'tool-fs-search') sawSearch = true
      continue
    }
    if (delegationIds.has(id)) continue
    if (id === SKILL_FILESYSTEM_ROW) {
      kept.push(...disableSkillWatch(block))
      continue
    }
    if (id === 'persona' && !personaAppended && appendablePersona(lines, span)) {
      kept.push(...appendPersona(lines, span))
      personaAppended = true
      continue
    }
    kept.push(...block)
  }
  // An editor mounted inside a source group (a copied variant, say) also means
  // the composition expects one, so the injected world keeps its editor row. The
  // search tools and the background-job producer follow the same rule: a mode
  // without them (minimal) must not gain them, and a mode with them must not lose
  // them. `tool-jobs` is what registers `job_list`/`job_output`/`job_kill`.
  if (source.includes('str-replace-editor')) sawEditor = true
  if (source.includes('tool-fs-search')) sawSearch = true
  if (source.includes('tool-jobs')) sawJobs = true
  const result = [...kept]
  if (result.length > 0 && result[result.length - 1] !== '') result.push('')
  result.push(wslWorldGroup(shellPath, fsPath, sawEditor, persistent, sawSearch ? searchPath : undefined, jobsPath, sawJobs, imagePath))
  return result.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n')
}

/** Whether an id is one of this plugin's own preset directories. */
export function isWslVariantId(id: string): boolean {
  return id === 'wsl' || /^wsl-[a-z0-9-]+$/.test(id)
}

/**
 * Whether the host family still carries the upstream duplicate-registration defect.
 *
 * `@deepseek-ai/dsh-tool-subagent` mounts once per live copy of the delegation row with no
 * `belongsToComposition` gate on the composition path and dedupes by object identity, so each
 * live copy of the delegation row is one more composition, and at six Desktop session creation
 * fails outright (issue #60; deepseek-ai/deepseek-harness discussion #6751). The package does
 * carry `belongsToComposition` on its standing `modelSelectionSettings` install path (verified
 * in the installed tree at 0.2.1-rc.2, and reported unchanged on 0.2.1-rc.5 in issue #132) —
 * but that gate only scopes the `agents.list()` reconcile loop; a composition that mounts the
 * package is still one more ungated registration. While the window head stays in 0.2.x the
 * predicate therefore says the gate is missing. When a fixed release becomes the window head,
 * narrow this predicate: the delegation row comes back, and with it `subagent` delegation
 * inside WSL sessions.
 *
 * An unreadable version leans the same way (fail-closed): a host this plugin cannot name is
 * more likely to lack the gate than to carry it, and the cost asymmetry is a missing
 * `subagent` tool against a missing session.
 * @param version - the host family's release string, when it could be read.
 * @returns true when the generator must not let the copied delegation row through.
 */
export function hostLacksSubagentGate(version: string | undefined): boolean {
  return version === undefined || /^0\.2\./.test(version)
}

/** The variant id for one source preset id. */
export function variantIdFor(sourceId: string): string {
  return `wsl-${sourceId.toLowerCase()}`
}

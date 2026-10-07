/**
 * Browser half of dsh-wsl-workspace. Registers the "Add WSL workspace…"
 * action beside Settings at the sidebar foot (the official
 * `sidebar.footer.action` slot), and keeps every blank session whose
 * workspace is a WSL UNC path composed from the WSL VARIANT of the mode it
 * currently runs (`standard` → `wsl-standard`, PTC → `wsl-code`, …) — so the
 * WSL execution world composes with any mode instead of being a mode itself.
 *
 * The binding is a watching effect rather than a one-shot dialog action so
 * EVERY creation path (this dialog, the workspace row's New Session, the
 * hero picker) converges on the WSL-backed composition automatically.
 *
 * It also translates file references for WSL sessions (issue #49), so a path
 * the model wrote inside the distribution can be previewed; see
 * `./references.ts` and the hook at the end of `apply`.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale) and the
// ui-sidebar SlotMap merge (the 'sidebar.footer.action' entry) into this
// program. Version-dependent services (`remote`, `connection.api`,
// `uiWorkspace`) are read dynamically via ctx.get() so both DSH v0.1.1-rc.2
// and v0.1.2-rc.1+ can load this plugin.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { check as checkApi, describe as describeApi, listDir as listDirApi, listDistros as listDistrosApi, listWorkspaceRecords as listWorkspaceRecordsApi, registerWindows as registerWindowsApi, setWorkspaceUser as setWorkspaceUserApi, type WslWorkspaceRecord } from './api.ts'
import { AddWslWorkspace, type AddWslWorkspaceInjected } from './AddWslWorkspace.tsx'
import { ensureStyles } from './styles.ts'
import { zh, en } from './locales.ts'
import { canonicalWindowsPath, isWslUnc, joinUnc, mntToWindowsPath } from '../shared/paths.ts'
import { distroOfWorkspace, isWslWorkspace, rewriteReferenceAddress, type ReferenceSession } from './references.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

/** The legacy standalone WSL preset id (folded into the mode variants). */
const LEGACY_WSL_PRESET_ID = 'wsl'

/**
 * Minimal sessions-service face. The renderer-host ctx merge types
 * `ctx.sessions` as its own SessionStore; the service the runtime actually
 * registers under that key satisfies this narrower contract, so the cast is
 * the documented boundary for a third-party plugin.
 */
interface WslSessionsFace {
  list: {
    getSnapshot(): {
      ids: string[]
      byId: Record<string, {
        blank: boolean
        cwd?: string
        /** v0.1.1-rc.2 direct field */
        agentPreset?: string
        /** v0.1.2-rc.1+ projection value */
        projectionValues?: Readonly<{ agentPreset?: string | null }>
      }>
    }
    subscribe(fn: () => void): () => void
  }
  /** v0.1.1-rc.2 only — absent in v0.1.2-rc.1+ (projection auto-syncs). */
  noteAgentPreset?(sessionId: string, agentPreset: string): void
}

/** Minimal workspaces-service face (create only; startSession moved out in v0.1.2-rc.1+). */
interface WslWorkspacesFace {
  create(input: { path: string }): Promise<{ workspaceId: string }>
  /** v0.1.1-rc.2 only — removed in v0.1.2-rc.1+. */
  startSession?(workspaceId?: string): void
}

/** v0.1.2-rc.1+ only — replaces `workspaces.startSession`. */
interface WslUiWorkspaceFace {
  startSession(workspaceId?: string): void
}

/** v0.1.2-rc.1+ agentPresets 命名空间服务（经 ctx.get('remote.agentPresets') 动态取，免 inject、无 associate 陷阱）。 */
interface WslAgentPresetsNamespace {
  list(): Promise<{ ok: boolean; value?: { presets: { id: string; broken?: string; isDefault?: boolean }[] }; error?: { message: string } }>
  select(sessionId: string, presetId: string): Promise<{ ok: boolean }>
}

/**
 * Minimal right-Sidebar navigation face — the controller this plugin wraps.
 *
 * The `sidebarRight` service arrives with the right Sidebar itself
 * (DSH 0.1.5-rc.1): the six earlier declared releases ship no right Sidebar, no
 * document preview and no resource model, so there is no reference surface to
 * fix there and the hook must simply not install. Both methods are the
 * controller's published navigation API, unchanged in every release that has it.
 */
interface WslSidebarNavigationFace {
  openResource(address: string, options?: unknown): void
  openResourceIn(sessionId: string, address: string, options?: unknown): void
}

/** 旧版 connection 服务最小接口（v0.1.1-rc.2 及更早），api 属性承载远程调用。 */
interface WslLegacyConnection {
  api?: {
    agentPresets: {
      list(input: Record<string, never>): Promise<{ result: { ok: boolean; value?: { presets: { id: string; broken?: string; isDefault?: boolean }[] }; error?: { message: string } } }>
      select(input: { sessionId: string; agentPreset: string }): Promise<{ result: { ok: boolean } }>
    }
  }
}
/**
 * Mount the sidebar action and the auto-binding effect.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const workspaces = ctx.get('workspaces') as unknown as WslWorkspacesFace
  const sessions = ctx.get('sessions') as unknown as WslSessionsFace
  // Version-dependent services are resolved ON USE - never through `inject`
  // (a release without the service would refuse to mount the plugin at all)
  // and never once at apply time. This plugin applies before the UI domain
  // that publishes `uiWorkspace` registers its service, so a one-shot read
  // caches `undefined` for the whole page life: on v0.1.2-rc.1+ that silently
  // disabled session creation (see resolveSessionStarter).
  const legacyApi = (): WslLegacyConnection['api'] =>
    (ctx.get('connection') as unknown as WslLegacyConnection | undefined)?.api
  const remoteAgentPresets = (): WslAgentPresetsNamespace | undefined =>
    ctx.get('remote.agentPresets') as unknown as WslAgentPresetsNamespace | undefined
  const uiWorkspaceService = (): WslUiWorkspaceFace | undefined =>
    ctx.get('uiWorkspace') as unknown as WslUiWorkspaceFace | undefined
  const hasNoteAgentPreset = typeof sessions.noteAgentPreset === 'function'

  /** Unified agent-preset list: new `remote.agentPresets` namespace (v0.1.2-rc.1+) or legacy `connection.api` (v0.1.1-rc.2). */
  const listAgentPresets = async (): Promise<{ ok: boolean; presets: { id: string; broken?: string; isDefault?: boolean }[]; error?: string }> => {
    const agentPresets = remoteAgentPresets()
    if (agentPresets !== undefined) {
      const r = await agentPresets.list()
      if (!r.ok) return { ok: false, presets: [], error: r.error?.message ?? 'list failed' }
      return { ok: true, presets: r.value?.presets ?? [] }
    }
    const api = legacyApi()
    if (api !== undefined) {
      const r = await api.agentPresets.list({})
      if (!r.result.ok) return { ok: false, presets: [], error: r.result.error?.message ?? 'list failed' }
      return { ok: true, presets: r.result.value?.presets ?? [] }
    }
    return { ok: false, presets: [], error: 'no remote api available' }
  }

  /** Unified agent-preset select: new `agentPresets.select(id, preset)` or legacy `connection.api.select({...})`. */
  const selectAgentPreset = async (sessionId: string, presetId: string): Promise<{ ok: boolean }> => {
    const agentPresets = remoteAgentPresets()
    if (agentPresets !== undefined) {
      return agentPresets.select(sessionId, presetId)
    }
    const api = legacyApi()
    if (api !== undefined) {
      const r = await api.agentPresets.select({ sessionId, agentPreset: presetId })
      return { ok: r.result.ok }
    }
    return { ok: false }
  }

  /**
   * Resolve how this release opens a session for a workspace - v0.1.2-rc.1+
   * exposes `uiWorkspace.startSession`, v0.1.1-rc.2 keeps it on `workspaces`.
   *
   * Resolved BEFORE the workspace is written. A release that offers neither
   * cannot open a session, and a silent fall-through would leave the workspace
   * behind with an empty `sessionIds` while the dialog still reports success;
   * failing here names the missing capability instead.
   * @returns the starter for the service this release actually exposes.
   * @throws Error naming both candidates when neither service is available.
   */
  const resolveSessionStarter = (): (workspaceId: string) => void | Promise<void> => {
    const ui = uiWorkspaceService()
    if (ui !== undefined) return (workspaceId) => { ui.startSession(workspaceId) }
    const legacyStart = workspaces.startSession
    if (typeof legacyStart === 'function') {
      return (workspaceId) => { Reflect.apply(legacyStart, workspaces, [workspaceId]) }
    }
    throw new Error(
      'workspace session API unavailable: this DSH release exposes neither '
      + 'uiWorkspace.startSession nor workspaces.startSession',
    )
  }

  /** Read agent preset — v0.1.2-rc.1+ uses projectionValues; v0.1.1-rc.2 uses direct field. */
  const getAgentPreset = (summary: { agentPreset?: string; projectionValues?: { agentPreset?: string | null } }): string | undefined => {
    if (summary.projectionValues?.agentPreset !== undefined) {
      const v = summary.projectionValues.agentPreset
      return v === null ? undefined : v
    }
    return summary.agentPreset
  }

  /** Note preset change — v0.1.1-rc.2 calls noteAgentPreset; v0.1.2-rc.1+ is auto-synced via projection. */
  const noteAgentPresetCompat = (sessionId: string, presetId: string): void => {
    if (hasNoteAgentPreset && sessions.noteAgentPreset) {
      sessions.noteAgentPreset(sessionId, presetId)
    }
  }

  ensureStyles()

  ctx.effect(
    () => ctx.locale.register('wslWorkspace' as never, { zh, en }),
    'dsh-wsl-workspace: locale dictionaries',
  )

  // The injected translate function reads the live DeepSeek Harness locale,
  // so the dialog copy follows the app language setting automatically.
  const t = ctx.locale.bind('wslWorkspace' as never) as unknown as (key: string, params?: Record<string, unknown>) => string

  // Canonical Windows drive keys of every registered `/mnt/<drive>` workspace
  // (refreshed from the host store; see refreshRoster). A blank session whose
  // cwd is one of these binds to the WSL variant like a UNC-cwd session.
  let wslWindowsPaths = new Set<string>()

  // The distribution behind each of those drive keys. A `/mnt/<drive>` workspace
  // stores it at registration time; a reference that leaves the drive mounts can
  // only be opened through that distribution's UNC share (issue #49).
  let driveDistros = new Map<string, string>()

  const injected = (): AddWslWorkspaceInjected => ({
    t,
    checkPreset: async (): Promise<string | undefined> => {
      let roster
      try {
        roster = await listAgentPresets()
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      if (!roster.ok) return roster.error
      const healthy = roster.presets.find((entry: { id: string; broken?: string }) =>
        entry.id.startsWith('wsl-') && entry.broken === undefined)
      if (healthy === undefined) return t('error.presetMissing')
      return undefined
    },
    listDistros: () => listDistrosApi(),
    // Advisory data for the help panel: a host that cannot answer reports an
    // unavailable description instead of breaking the dialog.
    describe: () => describeApi(),
    listDir: (distro, path) => listDirApi(distro, path),
    check: (distro, path) => checkApi(distro, path),
    createWorkspace: async (linuxPath, username, distro): Promise<string | undefined> => {
      try {
        // Before any write: without a session starter the workspace below
        // would be created and never opened.
        const startSession = resolveSessionStarter()
        const winPath = mntToWindowsPath(linuxPath)
        if (winPath !== null) {
          // `/mnt/<drive>` workspace: the workspace registry realpath/stats
          // the path and 9P cannot serve drvfs mounts, so register under the
          // drive spelling and store distro/username for the session env.
          // The browser binding below recognizes the drive cwd as WSL.
          const view = await workspaces.create({ path: winPath })
          await registerWindowsApi(linuxPath, distro, username)
          const canonical = canonicalWindowsPath(winPath)
          if (canonical !== null) {
            wslWindowsPaths = new Set(wslWindowsPaths).add(canonical)
            driveDistros = new Map(driveDistros).set(canonical, distro)
          }
          await startSession(view.workspaceId)
          return undefined
        }
        const uncPath = joinUnc(distro, linuxPath)
        const view = await workspaces.create({ path: uncPath })
        await setWorkspaceUserApi(uncPath, username)
        await startSession(view.workspaceId)
        return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  })

  ctx.effect(
    () => ctx.slots.inject(
      'sidebar.footer.action',
      () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'wsl-workspace', inject: injected },
        AddWslWorkspace,
      ),
    ),
    'dsh-wsl-workspace: sidebar footer action',
  )

  // Mode-variant binding: a blank session whose workspace is a WSL UNC path
  // is recomposed to the WSL variant of the mode it currently runs — plain
  // 标准 becomes `wsl-standard`, PTC becomes `wsl-code`, and so on — so the
  // WSL execution world composes with ANY mode instead of replacing it. The
  // host refuses non-blank sessions (agent-preset-locked), so the swap is
  // attempted at most a few times per session.
  ctx.effect(() => {
    const inFlight = new Set<string>()
    const attempts = new Map<string, number>()
    const MAX_ATTEMPTS = 3
    // Healthy `wsl-<mode>` variant ids plus the roster's default preset id
    // (what a session with no explicit choice gets). Refreshed periodically
    // so variants generated after this page loaded are picked up.
    let variants = new Set<string>()
    let defaultPreset: string | undefined
    const refreshRoster = (): void => {
      void listAgentPresets().then((result: {
        ok: boolean; presets: { id: string; broken?: string; isDefault?: boolean }[]
      }) => {
        if (!result.ok) return
        variants = new Set(result.presets
          .filter((entry: { id: string; broken?: string }) =>
            entry.broken === undefined && entry.id.startsWith('wsl-'))
          .map((entry: { id: string }) => entry.id))
        defaultPreset = result.presets.find(
          (entry: { id: string; isDefault?: boolean }) => entry.isDefault === true,
        )?.id
        // The roster is an INPUT to binding. It can land after the first pass
        // (and after apply()), and nothing else would re-run that pass: the
        // session store only emits when a session changes, so a blank session
        // that was already there would stay unbound until the user acted.
        maybeBind()
      }).catch(() => {
        // A failed roster read leaves the previous mapping; sessions stay on
        // their current composition until the next refresh.
      })
    }
    refreshRoster()
    const refreshWorkspaces = (): void => {
      void listWorkspaceRecordsApi().then((records: WslWorkspaceRecord[]) => {
        const keys = new Set<string>()
        const distros = new Map<string, string>()
        for (const record of records) {
          const canonical = canonicalWindowsPath(record.path)
          if (canonical === null) continue
          keys.add(canonical)
          if (record.distro !== undefined && record.distro !== '') distros.set(canonical, record.distro)
        }
        wslWindowsPaths = keys
        driveDistros = distros
        // Same late-input rule as the roster: the `/mnt/<drive>` key set
        // decides binding for drive-cwd sessions.
        maybeBind()
      }).catch(() => {
        // A failed store read leaves the previous sets; sessions stay on
        // their current composition until the next refresh.
      })
    }
    refreshWorkspaces()
    const maybeBind = (): void => {
      const state = sessions.list.getSnapshot()
      for (const id of state.ids) {
        const summary = state.byId[id]
        if (summary === undefined || !summary.blank || summary.cwd === undefined) continue
        // A session belongs to the WSL world when its cwd is a WSL UNC path,
        // or a Windows drive path registered as a `/mnt/<drive>` workspace
        // (9P cannot serve drvfs, so those workspaces carry drive cwds).
        const canonical = canonicalWindowsPath(summary.cwd)
        const isWsl = isWslUnc(summary.cwd)
          || (canonical !== null && wslWindowsPaths.has(canonical))
        if (!isWsl) continue
        const current = getAgentPreset(summary)
        if (current !== undefined && current.startsWith('wsl-')) continue
        // Legacy standalone `wsl` (now folded into the variants): remap it to
        // the default mode's variant, since the standalone preset no longer
        // exists in the roster.
        const base = current === LEGACY_WSL_PRESET_ID
          ? (defaultPreset ?? 'standard')
          : (current ?? defaultPreset)
        if (base === undefined || base === LEGACY_WSL_PRESET_ID || base.startsWith('wsl-')) continue
        const target = `wsl-${base.toLowerCase()}`
        if (!variants.has(target)) continue
        if (inFlight.has(id) || (attempts.get(id) ?? 0) >= MAX_ATTEMPTS) continue
        inFlight.add(id)
        void selectAgentPreset(id, target)
          .then((result: { ok: boolean }) => {
            if (result.ok) noteAgentPresetCompat(id, target)
          })
          .catch(() => {
            // A refused or aborted swap (session already produced output,
            // roster churn, reconnect) leaves the session on its current
            // composition; count the attempt so a stuck session stops
            // retrying after MAX_ATTEMPTS.
            attempts.set(id, (attempts.get(id) ?? 0) + 1)
          })
          .finally(() => {
            inFlight.delete(id)
          })
      }
    }
    maybeBind()
    const unsubscribe = sessions.list.subscribe(() => maybeBind())
    // Variants are generated at host boot; a page loaded before that would
    // never see them without a periodic refresh.
    const timer = window.setInterval(refreshRoster, 60_000)
    return () => {
      unsubscribe()
      window.clearInterval(timer)
    }
  }, 'dsh-wsl-workspace: WSL mode-variant binding')

  // File-reference path translation (issue #49).
  //
  // A WSL session's file references carry absolute LINUX paths, and the host
  // resolves such a path with `node:path.resolve(cwd, path)` — where a POSIX
  // absolute path is root-relative, so `/mnt/d/x` lands on the workspace drive
  // (`D:\mnt\d\x`) and an in-distribution path under the cwd share's root.
  // Neither names the file the model meant, so the document pane reports
  // `error.notFound` (or EPERM, for the drvfs mount 9P cannot serve).
  //
  // The host plane offers this plugin no hook: `fs` and the `workspaceFiles`
  // endpoint belong to other plugins, and cordis refuses a second `provide` for
  // a name another fiber owns. The Sidebar's navigation controller is the one
  // entry every reference surface goes through — the conversation's file links,
  // a tool row's line reference and the Files panel's rows alike — so the
  // address is translated there, which fixes both the tab's content and the
  // metadata read under the same address.
  ctx.inject(['sidebarRight'], (scope: ClientContext) => {
    scope.effect(() => {
      const controller = scope.get('sidebarRight') as unknown as WslSidebarNavigationFace | undefined
      const openResource = controller?.openResource
      const openResourceIn = controller?.openResourceIn
      // A release whose controller has a different shape is left untouched: a
      // partial patch would be worse than none. The no-op keeps this effect's
      // return type a disposer on both paths.
      if (controller === undefined || typeof openResource !== 'function' || typeof openResourceIn !== 'function') {
        return () => {}
      }
      const sessionOf = (sessionId: string): ReferenceSession | undefined => {
        const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd
        if (cwd === undefined || cwd === '') return undefined
        if (!isWslWorkspace(cwd, wslWindowsPaths)) return undefined
        return { cwd, distro: distroOfWorkspace(cwd, driveDistros) }
      }
      controller.openResource = (address: string, options?: unknown): void => {
        openResource.call(controller, rewriteReferenceAddress(address, sessionOf), options)
      }
      controller.openResourceIn = (sessionId: string, address: string, options?: unknown): void => {
        openResourceIn.call(controller, sessionId, rewriteReferenceAddress(address, sessionOf), options)
      }
      return () => {
        controller.openResource = openResource
        controller.openResourceIn = openResourceIn
      }
    }, 'dsh-wsl-workspace: file-reference path translation')
  })
}

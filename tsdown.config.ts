import { defineConfig } from 'tsdown'
import { builtinModules } from 'node:module'

/**
 * Standalone build for the dsh-wsl-workspace third-party plugin.
 *
 * Node half: the ESM entries (`lib/index.js` host plugin, `lib/shell.js` and
 * `lib/fs.js` service providers, plus the WSL world's relay, sandbox and search
 * pieces) with every `@deepseek-ai/*` and node builtin
 * external — at runtime they resolve from the harness's own dependency tree.
 * The preset installer references `lib/shell.js`/`lib/fs.js` by absolute path,
 * so those entry file names are load-bearing.
 *
 * Browser half: the closure-factory bundle the client registry serves
 * (`window.__ModuleLoader__.load`), externals restricted to the platform
 * module table exactly as the in-repo `clientBundle` preset does.
 */

const NODE_EXTERNALS = [/^@deepseek-ai\//, /^node:/, ...builtinModules]

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  // Documented exemption: the snapshot-store engine the runtime exposes.
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig([
  {
    name: 'dsh-wsl-workspace',
    entry: {
      index: 'src/index.ts',
      shell: 'src/shell.ts',
      fs: 'src/fs.ts',
      'wsl-relay': 'src/host/wsl-relay.ts',
      'wsl-sandbox': 'src/host/wsl-sandbox.ts',
      'wsl-search': 'src/host/wsl-search.ts',
      'wsl-jobs': 'src/host/wsl-jobs.ts',
      // The preset mounts the session bash tool by absolute path, like the shell and fs entries.
      'wsl-bash-tool': 'src/host/wsl-bash-tool.ts',
      // And the keyboard door beside it: the model-facing shape over the host's PTY registry.
      'wsl-terminal-tool': 'src/host/wsl-terminal-tool.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    deps: { neverBundle: NODE_EXTERNALS },
  },
  {
    name: 'dsh-wsl-workspace/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: { neverBundle: CLIENT_EXTERNALS, alwaysBundle: true },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-wsl-workspace", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])

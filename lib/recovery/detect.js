/**
 * Environment detection for the standalone recovery tool.
 *
 * The offline page runs with no DSH process to ask, so it has to find three
 * things by itself: the DSH home (`profiles/`), the profile to repair, and a
 * `js-yaml` copy to borrow. Each has several legitimate layouts across the
 * desktop app, a source checkout, and a plain CLI install.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

/**
 * Candidate DSH homes, most specific first.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function dshHomeCandidates(env = process.env) {
  const out = []
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) out.push(env.DSH_HOME)
  out.push(join(homedir(), '.dsh'))
  if (typeof env.APPDATA === 'string' && env.APPDATA.length > 0) {
    out.push(join(env.APPDATA, 'dsh'))
    out.push(join(env.APPDATA, 'DeepSeek Harness'))
  }
  if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0) {
    out.push(join(env.LOCALAPPDATA, 'dsh'))
  }
  return out.map((path) => resolve(path))
}

/**
 * First existing DSH home that actually contains a `profiles` directory.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ home: string | null, candidates: string[] }}
 */
export function detectDshHome(env = process.env) {
  const candidates = dshHomeCandidates(env)
  for (const home of candidates) {
    if (existsSync(join(home, 'profiles'))) return { home, candidates }
  }
  // A home that exists but has no profiles/ yet is still the right target.
  for (const home of candidates) {
    if (existsSync(home)) return { home, candidates }
  }
  return { home: null, candidates }
}

/**
 * Extract the profile named on a process command line.
 *
 * Both forms DSH uses are recognised: `--profile <name>` (the CLI launcher) and
 * `--profile=<name>`. Inside a running DSH this is the authoritative source,
 * because the launcher selects the profile in argv long before any plugin is
 * applied.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
export function profileFromArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (typeof token !== 'string') continue
    if (token === '--profile') {
      const next = argv[index + 1]
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return next
      continue
    }
    const prefix = '--profile='
    if (token.startsWith(prefix) && token.length > prefix.length) return token.slice(prefix.length)
  }
  return null
}

/**
 * Profile directories under a DSH home, newest-modified first.
 * @param {string} dshHome
 * @returns {{ name: string, dir: string, mtimeMs: number, hasPackage: boolean }[]}
 */
export function listProfileDirs(dshHome) {
  const root = join(resolve(dshHome), 'profiles')
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    const dir = join(root, entry.name)
    const packageJson = join(dir, 'package.json')
    const hasPackage = existsSync(packageJson)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(hasPackage ? packageJson : dir).mtimeMs
    } catch { /* unreadable profile sorts last */ }
    out.push({ name: entry.name, dir, mtimeMs, hasPackage })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Decide which profile a running DSH is actually using.
 *
 * Order, most authoritative first:
 *   1. `--profile` on the command line — how DSH was actually started, and the
 *      only signal that matches the profile being booted.
 *   2. `DSH_PROFILE` — an explicit override.
 *   3. an explicitly configured name.
 *   4. the most recently modified profile, as a last resort.
 *
 * `--profile` deliberately outranks `DSH_PROFILE`: a real DSH launch was
 * observed setting `DSH_PROFILE=desktop` in the environment while booting
 * `--profile web-enhanced`, so trusting the environment variable first picks the
 * wrong profile on exactly the multi-profile installs this tool needs to serve.
 *
 * Getting this wrong is expensive rather than merely untidy: the guard writes
 * its boot record and rollback points into the profile directory it picks, so
 * choosing the wrong one means silently protecting a profile nobody is using —
 * exactly the failure this tool exists to prevent. Every fallback past step 2
 * therefore reports that it guessed, so the caller can say so out loud.
 *
 * @param {{
 *   dshHome: string,
 *   env?: NodeJS.ProcessEnv,
 *   argv?: string[],
 *   configured?: string | null,
 * }} input
 * @returns {{
 *   name: string,
 *   dir: string,
 *   source: 'argv' | 'env' | 'config' | 'recent' | 'single' | 'default',
 *   confident: boolean,
 *   candidates: { name: string, dir: string, mtimeMs: number, hasPackage: boolean }[],
 * }}
 */
export function detectActiveProfile(input) {
  const env = input.env ?? process.env
  const argv = input.argv ?? process.argv
  const candidates = listProfileDirs(input.dshHome)
  const byName = new Map(candidates.map((entry) => [entry.name, entry]))

  const consider = (name, source) => {
    if (typeof name !== 'string' || name.length === 0) return null
    const found = byName.get(name)
    return {
      name,
      dir: found?.dir ?? join(resolve(input.dshHome), 'profiles', name),
      source,
      confident: true,
      candidates,
    }
  }

  const fromArgv = consider(profileFromArgv(argv), 'argv')
  if (fromArgv !== null) return fromArgv
  const fromEnv = consider(env.DSH_PROFILE, 'env')
  if (fromEnv !== null) return fromEnv
  const fromConfig = consider(input.configured ?? null, 'config')
  if (fromConfig !== null) return fromConfig

  const usable = candidates.filter((entry) => entry.hasPackage)
  const pool = usable.length > 0 ? usable : candidates
  if (pool.length === 0) {
    return {
      name: 'desktop',
      dir: join(resolve(input.dshHome), 'profiles', 'desktop'),
      source: 'default',
      confident: false,
      candidates,
    }
  }
  const newest = pool[0]
  return {
    name: newest.name,
    dir: newest.dir,
    source: pool.length === 1 ? 'single' : 'recent',
    confident: pool.length === 1,
    candidates,
  }
}

/**
 * Candidate locations that may contain a `js-yaml` copy to borrow.
 *
 * The guard ships no dependencies on purpose — a recovery tool that needs an
 * install step is useless in the situation it exists for — so it reuses the
 * host's copy. The DSH application root is discovered by walking up from the
 * running Node executable and by scanning sibling install directories.
 *
 * @param {{ profileDir?: string | null, executable?: string, env?: NodeJS.ProcessEnv, extraRoots?: string[] }} [input]
 * @returns {string[]}
 */
export function yamlHintCandidates(input = {}) {
  const env = input.env ?? process.env
  const hints = []

  /** Any node_modules that must contain js-yaml. */
  const push = (base) => {
    if (typeof base !== 'string' || base.length === 0) return
    const resolved = resolve(base)
    if (!hints.includes(resolved)) hints.push(resolved)
  }

  if (typeof env.DSH_YAML_HINT === 'string') push(env.DSH_YAML_HINT)
  if (typeof input.profileDir === 'string') push(join(input.profileDir, 'node_modules'))
  if (typeof env.DSH_APP_ROOT === 'string') {
    push(join(env.DSH_APP_ROOT, 'resources', 'app.asar.unpacked', 'node_modules'))
  }

  // Walk up from the node executable: a DSH install keeps its payload in
  // `resources/app.asar.unpacked/node_modules` next to the Electron binary.
  const executable = input.executable ?? process.execPath
  let dir = dirname(executable)
  for (let depth = 0; depth < 6 && dir.length > 3; depth += 1) {
    push(join(dir, 'resources', 'app.asar.unpacked', 'node_modules'))
    push(join(dir, 'app.asar.unpacked', 'node_modules'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Sibling DSH installs: the layout on this machine keeps the source checkout
  // and packaged builds side by side.
  const roots = input.extraRoots ?? []
  for (const root of roots) {
    push(join(root, 'node_modules'))
    push(join(root, 'desktop', 'app', 'resources', 'app.asar.unpacked', 'node_modules'))
    push(join(root, 'resources', 'app.asar.unpacked', 'node_modules'))
    try {
      const entries = readdirSync(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        push(join(root, entry.name, 'resources', 'app.asar.unpacked', 'node_modules'))
      }
    } catch { /* unreadable root is not fatal */ }
  }
  for (const extra of input.extraRoots ?? []) push(extra)
  return hints
}

/**
 * Extra roots worth scanning for a DSH install, derived from the drives that
 * hold the DSH home so a scan stays bounded.
 * @param {string} dshHome
 */
export function extraRootsFor(dshHome) {
  const roots = []
  const normalized = resolve(dshHome)
  const drive = normalized.slice(0, 3)
  if (/^[A-Za-z]:[\\/]$/.test(drive)) roots.push(drive)
  roots.push(process.cwd())
  return roots
}

/**
 * Locate a Node executable able to run this tool.
 *
 * Preference: the Node running us, then a DSH-bundled runtime (which exists
 * even when nothing else about DSH works), then `node` from PATH.
 * @param {{ env?: NodeJS.ProcessEnv, extraRoots?: string[] }} [input]
 * @returns {{ command: string, source: string, version: string | null }[]}
 */
export function nodeCandidates(input = {}) {
  const env = input.env ?? process.env
  const out = [{ command: process.execPath, source: 'running process', version: process.versions.node }]
  const names = ['node.exe', 'node']
  const roots = input.extraRoots ?? []
  for (const root of roots) {
    for (const relative of [
      join('resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin'),
      join('resources', 'runtime', 'bin'),
      join('runtime', 'primary-runtime', 'dependencies', 'node', 'bin'),
      join('runtime', 'bin'),
    ]) {
      for (const name of names) {
        const candidate = join(root, relative, name)
        if (!existsSync(candidate)) continue
        try {
          if (!statSync(candidate).isFile()) continue
        } catch {
          continue
        }
        if (!out.some((entry) => entry.command === candidate)) {
          out.push({ command: candidate, source: `DSH install at ${root}`, version: null })
        }
      }
    }
  }
  const pathExt = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const part of (env.PATH ?? '').split(delimiter)) {
    if (part.length === 0) continue
    for (const ext of pathExt) {
      const candidate = join(part, `node${ext}`)
      if (existsSync(candidate) && !out.some((entry) => entry.command === candidate)) {
        out.push({ command: candidate, source: 'PATH', version: null })
      }
    }
  }
  return out
}

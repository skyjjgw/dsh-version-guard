/**
 * Profile description: read a DSH profile and turn it into one flat, UI-ready
 * list of plugin rows plus the composition facts around them (profile bundles,
 * Cordis entries, loader patches).
 *
 * This is the read-only half of the tool: the settings page, the offline
 * recovery page and the CLI all render from exactly these structures, so a
 * plugin can never look "enabled" in one view and "broken" in another.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { readJsonOrNull, readTextOrNull } from './fsx.js'
import { describeDisabled, insertedRowIds, parseCordisYaml } from './yamlio.js'

/** Files a snapshot captures, relative to the profile directory. */
export const COMPOSITION_FILES = [
  'package.json',
  'cordis.patch.yml',
  'pnpm-lock.yaml',
  '.dsh-version-guard/cordis.disabled.json',
  '.dsh-market/state.json',
]

/** Only `package.json` is mandatory: without it there is no profile to read. */
export const REQUIRED_COMPOSITION_FILES = ['package.json']

/** The guard's own directory inside the profile. */
export const GUARD_DIR = '.dsh-version-guard'

/**
 * Absolute paths that define one profile.
 * @param {{ profileDir: string, yamlHints?: string[] }} input
 */
export function profilePaths(input) {
  const profileDir = resolve(input.profileDir)
  return {
    profileDir,
    packageJson: join(profileDir, 'package.json'),
    pnpmLock: join(profileDir, 'pnpm-lock.yaml'),
    pnpmWorkspace: join(profileDir, 'pnpm-workspace.yaml'),
    cordisYml: join(profileDir, 'cordis.yml'),
    cordisPatch: join(profileDir, 'cordis.patch.yml'),
    marketState: join(profileDir, '.dsh-market', 'state.json'),
    guardDir: join(profileDir, GUARD_DIR),
    snapshotsDir: join(profileDir, GUARD_DIR, 'snapshots'),
    bootState: join(profileDir, GUARD_DIR, 'boot.json'),
    disabledList: join(profileDir, GUARD_DIR, 'cordis.disabled.json'),
    lock: join(profileDir, GUARD_DIR, 'guard.lock'),
    yamlHints: [...(input.yamlHints ?? []), join(profileDir, 'noop.js')],
  }
}

/**
 * pnpm records a peer-resolved dependency's version with its peer context
 * appended, e.g. `1.44.0(@deepseek-ai/schemastery@3.18.2)`. That context is not
 * part of the version, and leaving it in makes every such package look like it
 * disagrees with the version installed in `node_modules`.
 * @param {string} raw
 */
function normalizeLockVersion(raw) {
  const text = raw.replace(/^['"]|['"]$/g, '').trim()
  const peer = text.indexOf('(')
  return peer === -1 ? text : text.slice(0, peer)
}

/**
 * Read `pnpm-lock.yaml` importers section with a tolerant line scan: the
 * lockfile is YAML, but only two numbers matter here and a hand-rolled scan
 * cannot be broken by the `!!js`-style extensions elsewhere in the toolchain.
 * @param {string | null} text
 * @returns {Map<string, { specifier: string, version: string }>}
 */
function readLockImporter(text) {
  const out = new Map()
  if (text === null) return out
  const lines = text.split('\n')
  let inRootImporter = false
  let indent = -1
  let current = null
  for (const line of lines) {
    if (/^importers:\s*$/.test(line)) {
      inRootImporter = false
      continue
    }
    const rootMatch = /^\s{2}\.\s*:\s*$/.exec(line)
    if (rootMatch) {
      inRootImporter = true
      indent = -1
      continue
    }
    if (inRootImporter && /^\s{2}\S/.test(line)) {
      // A sibling importer (e.g. `  packages/foo:`) ends the root block.
      inRootImporter = false
      continue
    }
    if (!inRootImporter) continue
    const nameMatch = /^(\s+)(\S.*?):\s*$/.exec(line)
    if (nameMatch) {
      indent = nameMatch[1].length
      current = nameMatch[2].replace(/^['"]|['"]$/g, '')
      out.set(current, { specifier: '', version: '' })
      continue
    }
    if (current === null || line.trim().length === 0) continue
    const specMatch = /^\s+specifier:\s*(.+?)\s*$/.exec(line)
    if (specMatch) {
      const entry = out.get(current)
      if (entry) entry.specifier = specMatch[1].replace(/^['"]|['"]$/g, '')
      continue
    }
    const versionMatch = /^\s+version:\s*(.+?)\s*$/.exec(line)
    if (versionMatch) {
      const entry = out.get(current)
      if (entry) entry.version = normalizeLockVersion(versionMatch[1])
    }
  }
  return out
}

/**
 * Read the installed version of one dependency from `node_modules`.
 * @param {string} profileDir
 * @param {string} name
 * @returns {{ version: string | null, main: string | null, hasMain: boolean, hasPatch: boolean, hasClient: boolean }}
 */
function readInstalled(profileDir, name) {
  const base = join(profileDir, 'node_modules', ...name.split('/'))
  const pkg = readJsonOrNull(join(base, 'package.json'), 'installed/package-invalid')
  if (pkg === null || typeof pkg !== 'object') {
    return { version: null, main: null, hasMain: false, hasPatch: false, hasClient: false }
  }
  const record = /** @type {Record<string, unknown>} */ (pkg)
  const dsh = record.dsh !== null && typeof record.dsh === 'object'
    ? /** @type {Record<string, unknown>} */ (record.dsh)
    : {}
  const bundle = dsh.bundle !== null && typeof dsh.bundle === 'object'
    ? /** @type {Record<string, unknown>} */ (dsh.bundle)
    : {}
  const main = typeof record.main === 'string' ? record.main : null
  return {
    version: typeof record.version === 'string' ? record.version : null,
    main,
    hasMain: main !== null && existsSync(join(base, main)),
    hasPatch: typeof bundle.patch === 'string' && existsSync(join(base, bundle.patch)),
    hasClient: dsh.client !== undefined && dsh.client !== null,
  }
}

/**
 * Load the guard's own disable list: plugin names the user switched off through
 * this tool. Disabling is stored here (not by editing the plugin) so it can be
 * undone even when DSH will not boot.
 * @param {string} path
 * @returns {{ disabled: string[], updatedAt: string | null, entries: Record<string, { at: string, reason: string, version: string | null }> }}
 */
export function loadDisabledList(path) {
  const parsed = readJsonOrNull(path, 'disabled-list/invalid-json')
  if (parsed === null || typeof parsed !== 'object') {
    return { disabled: [], updatedAt: null, entries: {} }
  }
  const record = /** @type {Record<string, unknown>} */ (parsed)
  const disabled = Array.isArray(record.disabled)
    ? record.disabled.filter((name) => typeof name === 'string')
    : []
  const entries = record.entries !== null && typeof record.entries === 'object'
    ? /** @type {Record<string, { at: string, reason: string, version: string | null }>} */ (record.entries)
    : {}
  return {
    disabled,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    entries,
  }
}

/**
 * Read the profile's composition.
 * @param {{ profileDir: string, yamlHints?: string[] }} input
 */
export function describeProfile(input) {
  const paths = profilePaths(input)
  const pkg = readJsonOrNull(paths.packageJson, 'profile/package-invalid')
  if (pkg === null) {
    const error = new Error(`no package.json in ${paths.profileDir}`)
    error.code = 'profile/not-found'
    throw error
  }
  const pkgRecord = /** @type {Record<string, unknown>} */ (pkg)
  const dependencies = pkgRecord.dependencies !== null && typeof pkgRecord.dependencies === 'object'
    ? /** @type {Record<string, string>} */ (pkgRecord.dependencies)
    : {}
  const dsh = pkgRecord.dsh !== null && typeof pkgRecord.dsh === 'object'
    ? /** @type {Record<string, unknown>} */ (pkgRecord.dsh)
    : {}
  const profile = dsh.profile !== null && typeof dsh.profile === 'object'
    ? /** @type {Record<string, unknown>} */ (dsh.profile)
    : {}
  const bundles = Array.isArray(profile.bundles)
    ? profile.bundles.filter((name) => typeof name === 'string')
    : []

  const lockVersions = readLockImporter(readTextOrNull(paths.pnpmLock))
  const disabledList = loadDisabledList(paths.disabledList)

  const cordisYmlText = readTextOrNull(paths.cordisYml)
  const cordisPatchText = readTextOrNull(paths.cordisPatch)
  const yamlHints = paths.yamlHints
  const cordisYml = cordisYmlText === null
    ? { ok: false, error: 'cordis.yml is absent' }
    : parseCordisYaml(cordisYmlText, { yamlHints })
  const cordisPatch = cordisPatchText === null
    ? { ok: true, entries: [] }
    : parseCordisYaml(cordisPatchText, { yamlHints })

  /** @type {Map<string, { id: string, name: string, state: string, expression?: string, reason?: string, inserts: string[] }>} */
  const cordisRows = new Map()
  const collect = (parsed, source) => {
    if (!parsed.ok) return
    for (const entry of parsed.entries) {
      const id = typeof entry.id === 'string' ? entry.id : null
      const name = typeof entry.name === 'string' ? entry.name : ''
      const verdict = describeDisabled(entry, { yamlHints })
      const row = {
        id: id ?? name,
        name,
        state: verdict.state,
        expression: verdict.expression,
        reason: verdict.reason,
        source,
        inserts: insertedRowIds(entry),
      }
      if (id !== null) cordisRows.set(id, row)
      else cordisRows.set(`name:${name}`, row)
    }
  }
  collect(cordisYml, 'cordis.yml')
  collect(cordisPatch, 'cordis.patch.yml')

  // Which package installed each Cordis row id? A package's own bundle patch
  // inserts rows, so the package that names the row owns it.
  /** @type {Map<string, string[]>} */
  const rowsByPackage = new Map()
  for (const [, row] of cordisRows) {
    const owner = row.name.startsWith('@deepseek-ai/')
      ? row.name.split('/').slice(0, 2).join('/')
      : row.name.split('/')[0]
    if (owner.length === 0) continue
    const list = rowsByPackage.get(owner) ?? []
    list.push(row.id)
    rowsByPackage.set(owner, list)
  }

  const profileBundles = new Set(bundles)
  const names = new Set([
    ...Object.keys(dependencies),
    ...bundles,
    ...disabledList.disabled,
  ])

  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const name of [...names].sort()) {
    const requested = dependencies[name] ?? null
    const installed = readInstalled(paths.profileDir, name)
    const lock = lockVersions.get(name) ?? null
    const isOfficial = name.startsWith('@deepseek-ai/')
    const isProfileBundle = profileBundles.has(name)
    const isDisabledByGuard = disabledList.disabled.includes(name)
    const declared = requested !== null
    const present = installed.version !== null
    const cordisRowIds = rowsByPackage.get(name) ?? []
    const cordisRowsForPackage = cordisRowIds
      .map((id) => cordisRows.get(id))
      .filter((row) => row !== undefined)
    const allRowsDisabled = cordisRowsForPackage.length > 0
      && cordisRowsForPackage.every((row) => row.state === 'disabled')
    const anyRowUnknown = cordisRowsForPackage.some((row) => row.state === 'unknown')

    /**
     * A bundle listed in `dsh.profile.bundles` is resolved by the host, not by
     * the profile's `node_modules`: the official `@deepseek-ai/dsh-base` and
     * `-web-app` entries never appear in the profile's dependencies. Only a
     * bundle that leaves the list stops loading.
     */
    const providedByHost = isProfileBundle && !declared

    /**
     * Dependencies that do not come from a registry: `link:`, `file:`,
     * `workspace:`, git URLs and tarball URLs. Their specifier is a location,
     * not a version range, so comparing it to the installed version is
     * meaningless and would report a permanent false mismatch.
     */
    const NON_REGISTRY_SPEC_RE = /^(?:link|file|workspace|portal):|^(?:git\+|https?:)/
    const isLinkedDependency = requested !== null && NON_REGISTRY_SPEC_RE.test(requested)

    /** @type {string[]} */
    const issues = []
    if (declared && !present) issues.push('declared but not installed in node_modules')
    if (present && requested !== null && installed.version !== null && !isLinkedDependency) {
      const wanted = requested.replace(/^[\^~>=<v]*/, '')
      if (wanted.length > 0 && !installed.version.startsWith(wanted) && requested !== installed.version) {
        const isRange = /[\^~><*x]|\|\|/.test(requested)
        if (!isRange) issues.push(`installed ${installed.version} does not match requested ${requested}`)
        else if (lock !== null && lock.version !== installed.version) {
          issues.push(`lockfile pins ${lock.version} but node_modules has ${installed.version}`)
        }
      }
    }
    if (present && !installed.hasMain && !installed.hasPatch && !installed.hasClient) {
      issues.push('package exposes no main, no bundle patch and no client entry')
    }

    /** @type {'enabled' | 'disabled' | 'unknown'} */
    let state = 'enabled'
    /** @type {string} */
    let stateReason = 'loaded'
    if (isDisabledByGuard) {
      state = 'disabled'
      stateReason = 'disabled through dsh-version-guard'
    } else if (declared && !present) {
      state = 'disabled'
      stateReason = 'package is missing from node_modules'
    } else if (!isProfileBundle && !providedByHost) {
      // Not a profile bundle: only a Cordis row keeps it mounted. A row that
      // exists but is switched off means the package is dormant, not broken.
      if (cordisRowsForPackage.length === 0) {
        state = 'disabled'
        stateReason = 'not in dsh.profile.bundles and no Cordis row mounts it'
      } else if (allRowsDisabled) {
        state = 'disabled'
        stateReason = 'every Cordis row for this package is disabled'
      }
    }
    if (state !== 'disabled' && isProfileBundle && allRowsDisabled) {
      state = 'disabled'
      stateReason = 'every Cordis row for this package is disabled'
    }
    if (state !== 'disabled' && anyRowUnknown) {
      state = 'unknown'
      stateReason = 'a Cordis row has a conditional disabled expression that could not be evaluated'
    }

    rows.push({
      name,
      requested,
      installed: installed.version,
      locked: lock === null ? null : lock.version,
      kind: isOfficial ? 'official' : 'community',
      /** True when the specifier points at a local path or URL, not a registry range. */
      linked: isLinkedDependency,
      bundled: isProfileBundle,
      /** True when the host resolves the bundle itself (no profile dependency). */
      providedByHost,
      hasHostEntry: installed.hasMain,
      hasBundlePatch: installed.hasPatch,
      hasClient: installed.hasClient,
      state,
      stateReason,
      disabledByGuard: isDisabledByGuard,
      disabledEntry: disabledList.entries[name] ?? null,
      cordisRows: cordisRowsForPackage,
      issues,
    })
  }

  return {
    paths: {
      profileDir: paths.profileDir,
      packageJson: paths.packageJson,
      cordisYml: paths.cordisYml,
      cordisPatch: paths.cordisPatch,
    },
    files: {
      packageJson: readTextOrNull(paths.packageJson),
      cordisPatch: cordisPatchText,
      pnpmLock: readTextOrNull(paths.pnpmLock),
      marketState: readTextOrNull(paths.marketState),
      disabledList: readTextOrNull(paths.disabledList),
      cordisYml: cordisYmlText,
    },
    profile: {
      bundles,
      patchReload: typeof profile.patchReload === 'string' ? profile.patchReload : null,
      dependencies,
    },
    cordis: {
      ymlOk: cordisYml.ok,
      ymlError: cordisYml.ok ? null : cordisYml.error,
      patchOk: cordisPatch.ok,
      patchError: cordisPatch.ok ? null : cordisPatch.error,
      rowCount: cordisRows.size,
    },
    disabled: disabledList,
    plugins: rows,
    stats: {
      total: rows.length,
      enabled: rows.filter((row) => row.state === 'enabled').length,
      disabled: rows.filter((row) => row.state === 'disabled').length,
      unknown: rows.filter((row) => row.state === 'unknown').length,
      withIssues: rows.filter((row) => /** @type {string[]} */ (row.issues).length > 0).length,
      community: rows.filter((row) => row.kind === 'community').length,
    },
  }
}

/**
 * Profile names that are safe to join onto a DSH home.
 *
 * A profile name arrives from an HTTP query string or a command line, and it is
 * joined onto `<dshHome>/profiles`. Anything containing a separator, a drive
 * letter or a `..` segment would let a caller read and rewrite a profile
 * outside the DSH home, so the shape is validated before any join happens.
 * Mirrors the character set DSH itself accepts for a profile name.
 */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSafeProfileName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  return PROFILE_NAME_RE.test(name)
}

/**
 * Resolve a profile name to an absolute directory inside a DSH home, refusing
 * anything that would escape it.
 * @param {string} dshHome
 * @param {string | null | undefined} name
 * @returns {string | null} `null` when the name is not acceptable.
 */
export function profileDirFor(dshHome, name) {
  const profilesRoot = resolve(join(dshHome, 'profiles'))
  if (name === null || name === undefined || name === '') return profilesRoot
  if (!isSafeProfileName(name)) return null
  const dir = resolve(join(profilesRoot, name))
  // Defence in depth: the validated name cannot escape, but verify the join.
  if (dir !== profilesRoot && !dir.startsWith(profilesRoot + sep)) return null
  return dir
}

/**
 * Enumerate profile directories under a DSH home, newest-modified first.
 * `node_modules` lives beside the profiles and is not one.
 * @param {string} dshHome
 * @returns {{ name: string, dir: string, mtimeMs: number, hasPackage: boolean }[]}
 */
export function listProfiles(dshHome) {
  const root = join(resolve(dshHome), 'profiles')
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()
        && !entry.name.startsWith('.')
        && entry.name !== 'node_modules')
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const dir = join(root, name)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(dir).mtimeMs
    } catch { /* unreadable profile: keep the name, sort last */ }
    out.push({ name, dir, mtimeMs, hasPackage: existsSync(join(dir, 'package.json')) })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

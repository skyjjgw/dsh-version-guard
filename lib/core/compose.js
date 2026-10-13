/**
 * Composition mutations: the writes that change *which plugins load at all*.
 *
 * Every function here is deliberately narrow and validates before it writes.
 * The rule that matters: `dsh.profile.bundles` is the load list, so removing a
 * name from it is what actually stops a plugin from loading. Removing it from
 * `dependencies` as well keeps `pnpm install` from reinstalling it.
 *
 * None of these touch `node_modules`; a caller that needs the installed tree to
 * match `package.json` runs pnpm afterwards (see pnpm.js).
 */

import { join } from 'node:path'
import { readJsonOrNull, stringifyJson, writeFileAtomic } from './fsx.js'
import { describeProfile, profilePaths } from './describe.js'

/**
 * Read and structurally validate a profile's `package.json`.
 * @param {string} profileDir
 * @returns {Record<string, any>}
 */
export function readProfilePackage(profileDir) {  const path = join(profileDir, 'package.json')
  const parsed = readJsonOrNull(path, 'profile/package-invalid')
  if (parsed === null) {
    const error = new Error(`no package.json in ${profileDir}`)
    error.code = 'profile/not-found'
    throw error
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('package.json is not a JSON object')
    error.code = 'profile/package-invalid'
    throw error
  }
  const pkg = /** @type {Record<string, any>} */ (parsed)
  if (pkg.dsh !== undefined && (typeof pkg.dsh !== 'object' || pkg.dsh === null || Array.isArray(pkg.dsh))) {
    const error = new Error('package.json "dsh" field is not an object')
    error.code = 'profile/package-invalid'
    throw error
  }
  if (pkg.dsh?.profile !== undefined
    && (typeof pkg.dsh.profile !== 'object' || pkg.dsh.profile === null || Array.isArray(pkg.dsh.profile))) {
    const error = new Error('package.json "dsh.profile" field is not an object')
    error.code = 'profile/package-invalid'
    throw error
  }
  if (pkg.dsh?.profile?.bundles !== undefined && !Array.isArray(pkg.dsh.profile.bundles)) {
    const error = new Error('package.json "dsh.profile.bundles" is not an array')
    error.code = 'profile/package-invalid'
    throw error
  }
  return pkg
}

/**
 * Apply an edit to a profile's `package.json` atomically.
 * @param {string} profileDir
 * @param {(pkg: Record<string, any>) => { changed: boolean, result?: unknown }} edit
 */
export function editProfilePackage(profileDir, edit) {
  const pkg = readProfilePackage(profileDir)
  const outcome = edit(pkg)
  if (outcome.changed) {
    writeFileAtomic(join(profileDir, 'package.json'), stringifyJson(pkg))
  }
  return outcome
}

/**
 * Remove a package name from `dsh.profile.bundles` and `dependencies`.
 * @param {string} profileDir
 * @param {string} name
 */
export function disablePackage(profileDir, name) {
  return editProfilePackage(profileDir, (pkg) => {
    const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
    const dependencies = pkg.dependencies !== null && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
    const wasBundled = bundles.includes(name)
    const wasDependency = Object.prototype.hasOwnProperty.call(dependencies, name)
    if (!wasBundled && !wasDependency) {
      return {
        changed: false,
        result: { name, wasBundled, wasDependency, note: 'already absent from bundles and dependencies' },
      }
    }
    if (wasBundled) {
      const next = bundles.filter((entry) => entry !== name)
      if (next.length === 0) {
        // An empty bundle list would leave a profile with no host at all.
        const error = new Error('refusing to remove the last entry of dsh.profile.bundles')
        error.code = 'compose/last-bundle'
        throw error
      }
      pkg.dsh.profile.bundles = next
    }
    if (wasDependency) delete dependencies[name]
    return { changed: true, result: { name, wasBundled, wasDependency } }
  })
}

/**
 * Re-add a package name to `dsh.profile.bundles` and `dependencies`.
 * @param {string} profileDir
 * @param {string} name
 * @param {string} range Version range to record in `dependencies`.
 * @param {{ position?: number }} [options] Insertion index in the bundle list.
 */
export function enablePackage(profileDir, name, range, options = {}) {
  if (typeof range !== 'string' || range.trim().length === 0) {
    const error = new Error(`a version range is required to enable ${name}`)
    error.code = 'compose/range-required'
    throw error
  }
  return editProfilePackage(profileDir, (pkg) => {
    if (pkg.dsh?.profile === undefined) pkg.dsh = { ...(pkg.dsh ?? {}), profile: { bundles: [] } }
    if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
    const bundles = pkg.dsh.profile.bundles
    if (!bundles.includes(name)) {
      const at = typeof options.position === 'number'
        ? Math.max(0, Math.min(bundles.length, options.position))
        : bundles.length
      bundles.splice(at, 0, name)
    }
    if (pkg.dependencies === null || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) {
      pkg.dependencies = {}
    }
    const previousRange = pkg.dependencies[name] ?? null
    pkg.dependencies[name] = range
    return { changed: true, result: { name, range, previousRange, bundles: [...bundles] } }
  })
}

/**
 * Pin a dependency to an exact version (the rollback primitive for one plugin).
 * @param {string} profileDir
 * @param {string} name
 * @param {string} version Exact version, e.g. `0.2.8`.
 */
export function pinPackageVersion(profileDir, name, version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    const error = new Error(`not an exact version: ${version}`)
    error.code = 'compose/invalid-version'
    throw error
  }
  return editProfilePackage(profileDir, (pkg) => {
    if (pkg.dependencies === null || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) {
      const error = new Error(`${name} is not a dependency of this profile`)
      error.code = 'compose/not-a-dependency'
      throw error
    }
    if (!Object.prototype.hasOwnProperty.call(pkg.dependencies, name)) {
      const error = new Error(`${name} is not a dependency of this profile`)
      error.code = 'compose/not-a-dependency'
      throw error
    }
    const previousRange = pkg.dependencies[name]
    pkg.dependencies[name] = version
    return { changed: previousRange !== version, result: { name, version, previousRange } }
  })
}

/**
 * Full uninstall: drop the package from `dependencies` and `bundles`.
 * Differs from {@link disablePackage} only in intent; both end at the same
 * composition, and an explicit `pnpm install` prunes `node_modules` afterwards.
 * @param {string} profileDir
 * @param {string} name
 */
export function uninstallPackage(profileDir, name) {
  return disablePackage(profileDir, name)
}

/**
 * Restore one package's bundle + dependency entry from a snapshot.
 * @param {string} profileDir
 * @param {string} name
 * @param {string} range
 */
export function restorePackage(profileDir, name, range) {
  return enablePackage(profileDir, name, range)
}

/**
 * Explain what a mutation would do, without doing it. Drives the confirmation
 * text in both UIs so the user sees the exact version transition.
 * @param {{ profileDir: string, name: string, yamlHints?: string[] }} input
 */
export function planDisable(input) {
  const paths = profilePaths({ profileDir: input.profileDir, yamlHints: input.yamlHints })
  const description = describeProfile({ profileDir: paths.profileDir, yamlHints: input.yamlHints })
  const row = description.plugins.find((plugin) => plugin.name === input.name)
  if (row === undefined) {
    const error = new Error(`${input.name} is not part of this profile`)
    error.code = 'compose/unknown-package'
    throw error
  }
  return {
    name: row.name,
    installed: row.installed,
    requested: row.requested,
    currentlyBundled: row.bundled,
    willRemoveFromBundles: row.bundled,
    willRemoveFromDependencies: row.requested !== null,
    affectedCordisRows: row.cordisRows.map((cordisRow) => cordisRow.id),
    effect: row.bundled
      ? 'the package stops loading on the next start (its bundle patch is no longer applied)'
      : 'the package is already not loading; removing it only stops reinstalling',
  }
}

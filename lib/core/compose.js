/**
 * Composition mutations: the writes that change *which plugins load at all*.
 *
 * Every function here is deliberately narrow and validates before it writes.
 * Enablement follows DSH's official plugin manager: the package remains
 * installed and declared, while id-targeted `disabled` overrides are written
 * to the profile's `cordis.patch.yml`. This keeps one source of truth and makes
 * changes made in either UI immediately visible to the other.
 */

import { join } from 'node:path'
import { readJsonOrNull, stringifyJson, writeFileAtomic } from './fsx.js'
import { setPackageEnabled } from './cordis-state.js'
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
 * Disable a package through Cordis row overrides, matching the official UI.
 * @param {string} profileDir
 * @param {string} name
 */
export function disablePackage(profileDir, name) {
  const pkg = readProfilePackage(profileDir)
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const dependencies = pkg.dependencies !== null && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  if (!bundles.includes(name) && !Object.prototype.hasOwnProperty.call(dependencies, name)) {
    const error = new Error(`${name} is not part of this profile`)
    error.code = 'compose/unknown-package'
    throw error
  }
  return setPackageEnabled(profileDir, name, false)
}

/**
 * Re-enable a package through Cordis row overrides.
 * @param {string} profileDir
 * @param {string} name
 * @param {string} range Version range to record in `dependencies`.
 * @param {{ position?: number }} [options] Insertion index in the bundle list.
 */
export function enablePackage(profileDir, name, range, options = {}) {
  const pkg = readProfilePackage(profileDir)
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const dependencies = pkg.dependencies !== null && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  if (!bundles.includes(name) && !Object.prototype.hasOwnProperty.call(dependencies, name)) {
    // One-time compatibility for profiles disabled by version 0.1.0, which
    // removed both declarations. New disables never take this path.
    if (typeof range !== 'string' || range.trim().length === 0) {
      const error = new Error(`a version range is required to migrate ${name}`)
      error.code = 'compose/range-required'
      throw error
    }
    editProfilePackage(profileDir, (next) => {
      if (next.dsh?.profile === undefined) next.dsh = { ...(next.dsh ?? {}), profile: { bundles: [] } }
      if (!Array.isArray(next.dsh.profile.bundles)) next.dsh.profile.bundles = []
      if (!next.dsh.profile.bundles.includes(name)) next.dsh.profile.bundles.splice(options.position ?? next.dsh.profile.bundles.length, 0, name)
      if (next.dependencies === null || typeof next.dependencies !== 'object' || Array.isArray(next.dependencies)) next.dependencies = {}
      next.dependencies[name] = range
      return { changed: true }
    })
  }
  return setPackageEnabled(profileDir, name, true)
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
 * This is intentionally distinct from {@link disablePackage}, which only
 * writes Cordis enablement state.
 * @param {string} profileDir
 * @param {string} name
 */
export function uninstallPackage(profileDir, name) {
  return editProfilePackage(profileDir, (pkg) => {
    const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
    const dependencies = pkg.dependencies !== null && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
    const wasBundled = bundles.includes(name)
    const wasDependency = Object.prototype.hasOwnProperty.call(dependencies, name)
    if (wasBundled) pkg.dsh.profile.bundles = bundles.filter((entry) => entry !== name)
    if (wasDependency) delete dependencies[name]
    return { changed: wasBundled || wasDependency, result: { name, wasBundled, wasDependency } }
  })
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
    willRemoveFromBundles: false,
    willRemoveFromDependencies: false,
    affectedCordisRows: row.cordisRows.map((cordisRow) => cordisRow.id),
    effect: 'writes disabled: true to the matching Cordis rows; package.json remains unchanged',
  }
}

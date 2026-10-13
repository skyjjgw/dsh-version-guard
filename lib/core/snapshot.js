/**
 * Snapshots: capture the files that decide *what a profile is*, so a profile
 * broken by a plugin change can be put back to a known-good composition.
 *
 * A snapshot stores composition files (`package.json`, `cordis.patch.yml`,
 * `pnpm-lock.yaml`, the guard's disable list, the market's state) plus a
 * recorded description of every plugin — name, requested range, installed
 * version, lockfile pin, mounted Cordis rows and issues. `node_modules` is
 * never copied: it is derivable from `package.json` + `pnpm-lock.yaml` through
 * pnpm, and copying it would make snapshots enormous.
 *
 * Restores are transactional: every target's current bytes are captured first,
 * writes use temp + rename, and a failure midway rolls completed actions back.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { COMPOSITION_FILES, describeProfile, profilePaths } from './describe.js'
import { readTextOrNull, sha256, stringifyJson, writeFileAtomic } from './fsx.js'

/** Snapshot document format marker. */
export const SNAPSHOT_FORMAT = 'dsh-version-guard/profile-snapshot'
/** Snapshot document schema version. */
export const SNAPSHOT_VERSION = 1
/** Default retained snapshots per profile. */
export const DEFAULT_MAX_SNAPSHOTS = 30
/**
 * Snapshot id shape: `snap-<iso-ish>-<reason>` with an optional `-<seq>`.
 * The reason part is `[a-z]+(?:-[a-z]+)*` so hyphenated reasons such as
 * `pre-restore` validate — a stricter `[a-z]+` silently rejects them, making a
 * snapshot that exists on disk unreadable.
 */
const SNAPSHOT_ID_RE = /^snap-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z]+(?:-[a-z]+)*(?:-\d+)?$/

/**
 * @typedef {'boot' | 'manual' | 'pre-change' | 'pre-restore' | 'recovery'} SnapshotReason
 */

/**
 * Reject any id that is not exactly what {@link nextSnapshotId} generates, so a
 * hostile or corrupt id can never escape the snapshots directory.
 * @param {unknown} id
 */
export function isValidSnapshotId(id) {
  return typeof id === 'string' && SNAPSHOT_ID_RE.test(id)
}

/**
 * Build the next unused snapshot id.
 * @param {string} snapshotsDir
 * @param {SnapshotReason} reason
 */
export function nextSnapshotId(snapshotsDir, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let names = []
  try {
    names = readdirSync(snapshotsDir)
  } catch { /* directory absent: no collisions possible */ }
  let seq = 0
  let id = `snap-${stamp}-${reason}`
  while (names.includes(`${id}.json`)) {
    seq += 1
    id = `snap-${stamp}-${reason}-${seq}`
  }
  return id
}

/**
 * Absolute path of one snapshot document.
 * @param {string} snapshotsDir
 * @param {string} id
 */
export function snapshotPath(snapshotsDir, id) {
  if (!isValidSnapshotId(id)) {
    const error = new Error(`invalid snapshot id: ${String(id)}`)
    error.code = 'snapshot/invalid-id'
    throw error
  }
  return join(snapshotsDir, `${id}.json`)
}

/**
 * Capture one composition file.
 *
 * A file that exists but cannot be read aborts the capture: recording it as
 * "absent" would turn a permission problem into a delete instruction on
 * restore. Only a genuinely missing path becomes an explicit absence marker.
 * @param {string} profileDir
 * @param {string} relative
 */
function captureFile(profileDir, relative) {
  const absolute = join(profileDir, relative)
  let text
  try {
    text = readTextOrNull(absolute)
  } catch (error) {
    const wrapped = new Error(`cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}`)
    wrapped.code = 'snapshot/capture-unreadable'
    throw wrapped
  }
  if (text === null) return { path: relative, absent: /** @type {const} */ (true) }
  return { path: relative, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8'), text }
}

/**
 * Capture a new snapshot of a profile.
 * @param {{ profileDir: string, reason?: SnapshotReason, yamlHints?: string[], maxSnapshots?: number, note?: string, dshVersion?: string | null, boot?: unknown }} input
 * @returns {{ ok: true, id: string, snapshot: Record<string, unknown> } | { ok: false, error: string, code: string }}
 */
export function createSnapshot(input) {
  const paths = profilePaths({ profileDir: input.profileDir, yamlHints: input.yamlHints })
  const reason = input.reason ?? 'manual'
  try {
    const description = describeProfile({ profileDir: paths.profileDir, yamlHints: input.yamlHints })
    const files = COMPOSITION_FILES.map((relative) => captureFile(paths.profileDir, relative))
    const id = nextSnapshotId(paths.snapshotsDir, reason)
    const packageFile = files.find((file) => file.path === 'package.json')
    const snapshot = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      id,
      reason,
      note: typeof input.note === 'string' ? input.note.slice(0, 500) : null,
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
      dshVersion: input.dshVersion ?? null,
      boot: input.boot ?? null,
      profile: {
        dir: paths.profileDir,
        name: basename(paths.profileDir),
        bundles: description.profile.bundles,
        patchReload: description.profile.patchReload,
      },
      packageSha256: packageFile?.sha256 ?? null,
      plugins: description.plugins.map((row) => ({
        name: row.name,
        requested: row.requested,
        installed: row.installed,
        locked: row.locked,
        kind: row.kind,
        bundled: row.bundled,
        state: row.state,
        stateReason: row.stateReason,
        disabledByGuard: row.disabledByGuard,
        cordisRows: row.cordisRows.map((cordisRow) => ({
          id: cordisRow.id,
          name: cordisRow.name,
          state: cordisRow.state,
          expression: cordisRow.expression ?? null,
          source: cordisRow.source,
        })),
        issues: row.issues,
      })),
      stats: description.stats,
      files,
    }
    mkdirSync(paths.snapshotsDir, { recursive: true })
    writeFileAtomic(snapshotPath(paths.snapshotsDir, id), stringifyJson(snapshot))
    pruneSnapshots(paths.snapshotsDir, input.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS, id)
    return { ok: true, id, snapshot }
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === 'string' ? error.code : 'snapshot/capture-failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Validate a parsed snapshot document strictly enough that a restore may trust
 * it. A document failing these checks is corrupt and is never listed.
 * @param {unknown} value
 * @returns {{ ok: true, snapshot: Record<string, any> } | { ok: false, error: string }}
 */
export function validateSnapshot(value) {
  if (value === null || typeof value !== 'object') return { ok: false, error: 'not an object' }
  const snap = /** @type {Record<string, any>} */ (value)
  if (snap.format !== SNAPSHOT_FORMAT) return { ok: false, error: 'unknown format' }
  if (snap.version !== SNAPSHOT_VERSION) return { ok: false, error: `unsupported version ${String(snap.version)}` }
  if (!isValidSnapshotId(snap.id)) return { ok: false, error: 'invalid id' }
  if (typeof snap.createdAt !== 'string' || Number.isNaN(Date.parse(snap.createdAt))) {
    return { ok: false, error: 'invalid createdAt' }
  }
  if (!Array.isArray(snap.files)) return { ok: false, error: 'files is not an array' }
  for (const file of snap.files) {
    if (file === null || typeof file !== 'object') return { ok: false, error: 'file entry is not an object' }
    const entry = /** @type {Record<string, unknown>} */ (file)
    if (typeof entry.path !== 'string') return { ok: false, error: 'file entry has no path' }
    if (!COMPOSITION_FILES.includes(entry.path)) {
      return { ok: false, error: `unsafe snapshot path: ${entry.path}` }
    }
    const hasText = typeof entry.text === 'string'
    const absent = entry.absent === true
    if (hasText === absent) return { ok: false, error: `file ${entry.path} must have exactly one representation` }
    if (hasText && entry.sha256 !== sha256(/** @type {string} */ (entry.text))) {
      return { ok: false, error: `file ${entry.path} failed its checksum` }
    }
  }
  if (!snap.files.some((file) => /** @type {Record<string, unknown>} */ (file).path === 'package.json')) {
    return { ok: false, error: 'snapshot has no package.json' }
  }
  return { ok: true, snapshot: snap }
}

/**
 * Read one snapshot document.
 * @param {string} snapshotsDir
 * @param {string} id
 * @returns {Record<string, any> | null}
 */
export function readSnapshot(snapshotsDir, id) {
  if (!isValidSnapshotId(id)) return null
  const text = readTextOrNull(snapshotPath(snapshotsDir, id))
  if (text === null) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const validated = validateSnapshot(parsed)
  if (!validated.ok || validated.snapshot.id !== id) return null
  return validated.snapshot
}

/**
 * All snapshots for a profile, newest first. Corrupt or unsupported documents
 * are skipped with a diagnostic entry rather than offered for restore.
 * @param {string} snapshotsDir
 * @returns {{ snapshots: Record<string, any>[], skips: { file: string, error: string }[] }}
 */
export function listSnapshots(snapshotsDir) {
  let names = []
  try {
    names = readdirSync(snapshotsDir).filter((name) => name.endsWith('.json'))
  } catch {
    return { snapshots: [], skips: [] }
  }
  const snapshots = []
  const skips = []
  for (const name of names) {
    const id = name.slice(0, -5)
    const text = readTextOrNull(join(snapshotsDir, name))
    if (text === null) continue
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      skips.push({ file: name, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const validated = validateSnapshot(parsed)
    if (!validated.ok) {
      skips.push({ file: name, error: validated.error })
      continue
    }
    if (validated.snapshot.id !== id) {
      skips.push({ file: name, error: 'id does not match the file name' })
      continue
    }
    snapshots.push(validated.snapshot)
  }
  snapshots.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0) || (a.id < b.id ? 1 : -1))
  return { snapshots, skips }
}

/**
 * Compact, UI-facing view of a snapshot: enough for a timeline row without
 * shipping every captured file to the browser.
 * @param {Record<string, any>} snapshot
 */
export function summarizeSnapshot(snapshot) {
  return {
    id: snapshot.id,
    reason: snapshot.reason,
    note: snapshot.note ?? null,
    createdAt: snapshot.createdAt,
    createdAtMs: snapshot.createdAtMs,
    dshVersion: snapshot.dshVersion ?? null,
    boot: snapshot.boot ?? null,
    profile: snapshot.profile ?? null,
    packageSha256: snapshot.packageSha256 ?? null,
    stats: snapshot.stats ?? null,
    pluginCount: Array.isArray(snapshot.plugins) ? snapshot.plugins.length : 0,
    files: Array.isArray(snapshot.files)
      ? snapshot.files.map((file) => ({
        path: file.path,
        absent: file.absent === true,
        bytes: typeof file.bytes === 'number' ? file.bytes : 0,
      }))
      : [],
  }
}

/**
 * Delete one snapshot.
 * @param {string} snapshotsDir
 * @param {string} id
 */
export function deleteSnapshot(snapshotsDir, id) {
  if (!isValidSnapshotId(id)) return false
  const file = snapshotPath(snapshotsDir, id)
  if (!existsSync(file)) return false
  try {
    rmSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * Keep the `max` newest snapshots. A non-positive cap is clamped to 1 so the
 * just-created snapshot is never the one dropped.
 * @param {string} snapshotsDir
 * @param {number} max
 * @param {string} [keepId]
 * @returns {string[]} deleted ids
 */
export function pruneSnapshots(snapshotsDir, max, keepId) {
  const cap = Math.max(1, max)
  const { snapshots } = listSnapshots(snapshotsDir)
  if (snapshots.length <= cap) return []
  const ordered = keepId === undefined
    ? snapshots
    : [
      ...snapshots.filter((snapshot) => snapshot.id === keepId),
      ...snapshots.filter((snapshot) => snapshot.id !== keepId),
    ]
  const dropped = ordered.slice(cap)
  for (const snapshot of dropped) deleteSnapshot(snapshotsDir, snapshot.id)
  return dropped.map((snapshot) => snapshot.id)
}

/**
 * Restore a snapshot into its profile, transactionally.
 *
 * Every target's current bytes are read first, so a failure part-way through
 * can put the profile back exactly as it was found. `package.json`,
 * `cordis.patch.yml` and `pnpm-lock.yaml` are written; the guard's disable list
 * is restored too, so a snapshot taken before a plugin was switched off brings
 * that plugin back.
 *
 * `node_modules` is NOT touched. When the snapshot's dependency set differs
 * from the live one the result reports `installRequired: true` and the caller
 * decides whether to run pnpm.
 *
 * @param {{ profileDir: string, snapshotsDir: string, id: string, yamlHints?: string[], beforeRestore?: boolean, maxSnapshots?: number }} input
 * @returns {Promise<{ ok: boolean, restored?: string[], removed?: string[], previousSnapshot?: string | null, installRequired?: boolean, dependencyChanges?: unknown[], error?: string, code?: string }>}
 */
export async function restoreSnapshot(input) {
  const id = input.id
  // Refuse a malformed id outright rather than reporting it as "not found":
  // callers must not be able to probe the filesystem with a crafted id.
  if (!isValidSnapshotId(id)) {
    return { ok: false, code: 'snapshot/invalid-id', error: `invalid snapshot id: ${String(id)}` }
  }
  const snapshot = readSnapshot(input.snapshotsDir, id)
  if (snapshot === null) {
    return { ok: false, code: 'snapshot/not-found', error: `snapshot ${String(id)} is missing or corrupt` }
  }

  // Compare dependency sets before touching anything, so the caller can be told
  // whether node_modules will need a pnpm run afterwards.
  let dependencyChanges = []
  let installRequired = false
  try {
    const live = describeProfile({ profileDir: input.profileDir, yamlHints: input.yamlHints })
    const snapshotDeps = new Map(
      snapshot.files
        .filter((file) => file.path === 'package.json' && typeof file.text === 'string')
        .flatMap((file) => Object.entries(JSON.parse(file.text).dependencies ?? {}))
        .map(([name, range]) => [name, String(range)]),
    )
    for (const row of live.plugins) {
      const before = snapshotDeps.get(row.name)
      if (before === undefined && row.requested !== null) {
        dependencyChanges.push({ name: row.name, from: `${row.installed ?? '?'} (${row.requested})`, to: 'removed' })
      } else if (before !== undefined && before !== row.requested) {
        dependencyChanges.push({ name: row.name, from: `${row.installed ?? '?'} (${row.requested})`, to: before })
      }
    }
    for (const [name, range] of snapshotDeps) {
      if (!live.plugins.some((row) => row.name === name)) {
        dependencyChanges.push({ name, from: 'absent', to: String(range) })
      }
    }
    installRequired = dependencyChanges.length > 0
  } catch { /* a live profile that cannot be read still allows a raw file restore */ }

  // Take a pre-restore snapshot so the rollback itself is undoable.
  let previousSnapshot = null
  if (input.beforeRestore !== false) {
    const safety = createSnapshot({
      profileDir: input.profileDir,
      reason: 'pre-restore',
      yamlHints: input.yamlHints,
      maxSnapshots: input.maxSnapshots,
      note: `state before restoring ${id}`,
    })
    if (safety.ok) previousSnapshot = safety.id
  }

  /** @type {{ path: string, target: string, content: string | null, previous: string | null }[]} */
  const writes = []
  for (const file of snapshot.files) {
    const target = join(input.profileDir, file.path)
    let previous = null
    try {
      previous = readTextOrNull(target)
      if (previous !== null && !statSync(target).isFile()) {
        return {
          ok: false,
          code: 'snapshot/unsafe-target',
          error: `${file.path} is not a regular file`,
          previousSnapshot,
        }
      }
    } catch (error) {
      return {
        ok: false,
        code: 'snapshot/target-unreadable',
        error: `${file.path}: ${error instanceof Error ? error.message : String(error)}`,
        previousSnapshot,
      }
    }
    writes.push({
      path: file.path,
      target,
      content: file.absent === true ? null : /** @type {string} */ (file.text),
      previous,
    })
  }

  const completed = []
  try {
    for (const write of writes) {
      if (write.content === null) {
        rmSync(write.target, { force: true })
      } else {
        writeFileAtomic(write.target, write.content)
      }
      completed.push(write)
    }
  } catch (error) {
    let rollbackFailure = null
    for (const write of [...completed].reverse()) {
      try {
        if (write.previous === null) rmSync(write.target, { force: true })
        else writeFileAtomic(write.target, write.previous)
      } catch (rollbackError) {
        rollbackFailure ??= rollbackError
      }
    }
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      code: 'snapshot/restore-failed',
      error: rollbackFailure === null
        ? `${detail} (already rolled back)`
        : `${detail}; rollback incomplete: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`,
      previousSnapshot,
    }
  }

  return {
    ok: true,
    restored: writes.filter((write) => write.content !== null).map((write) => write.path),
    removed: writes.filter((write) => write.content === null).map((write) => write.path),
    previousSnapshot,
    installRequired,
    dependencyChanges,
  }
}

/**
 * Compare a snapshot against the live profile.
 * @param {{ profileDir: string, snapshotsDir: string, id: string, yamlHints?: string[] }} input
 */
export function diffSnapshot(input) {
  const snapshot = readSnapshot(input.snapshotsDir, input.id)
  if (snapshot === null) return { ok: false, error: `snapshot ${String(input.id)} is missing or corrupt` }
  const live = describeProfile({ profileDir: input.profileDir, yamlHints: input.yamlHints })
  const snapshotPlugins = new Map(
    (Array.isArray(snapshot.plugins) ? snapshot.plugins : []).map((row) => [row.name, row]),
  )
  const livePlugins = new Map(live.plugins.map((row) => [row.name, row]))

  /** @type {{ name: string, change: string, snapshot: unknown, live: unknown }[]} */
  const pluginChanges = []
  for (const [name, liveRow] of livePlugins) {
    const snapRow = snapshotPlugins.get(name)
    if (snapRow === undefined) {
      pluginChanges.push({ name, change: 'added-since-snapshot', snapshot: null, live: describeRow(liveRow) })
      continue
    }
    if (snapRow.installed !== liveRow.installed || snapRow.requested !== liveRow.requested) {
      pluginChanges.push({ name, change: 'version', snapshot: describeRow(snapRow), live: describeRow(liveRow) })
      continue
    }
    if (snapRow.state !== liveRow.state) {
      pluginChanges.push({ name, change: 'state', snapshot: describeRow(snapRow), live: describeRow(liveRow) })
    }
  }
  for (const [name, snapRow] of snapshotPlugins) {
    if (!livePlugins.has(name)) {
      pluginChanges.push({ name, change: 'missing-now', snapshot: describeRow(snapRow), live: null })
    }
  }

  const fileChanges = snapshot.files.map((file) => {
    const current = readTextOrNull(join(input.profileDir, file.path))
    const snapshotHash = file.absent === true ? null : file.sha256
    const currentHash = current === null ? null : sha256(current)
    return {
      path: file.path,
      changed: snapshotHash !== currentHash,
      snapshotAbsent: file.absent === true,
      liveAbsent: current === null,
    }
  })

  return {
    ok: true,
    snapshot: summarizeSnapshot(snapshot),
    pluginChanges,
    fileChanges,
    identical: pluginChanges.length === 0 && fileChanges.every((file) => !file.changed),
  }
}

/** Compact one describe row for a diff payload. */
function describeRow(row) {
  return {
    name: row.name,
    requested: row.requested,
    installed: row.installed,
    state: row.state,
    stateReason: row.stateReason,
  }
}

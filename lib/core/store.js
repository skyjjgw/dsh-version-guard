/**
 * The service layer: one object that both the DSH host plugin and the offline
 * recovery page drive. Keeping the orchestration here (locking, auto-snapshot
 * policy, crash-loop bookkeeping) means the two front ends cannot drift apart
 * in what they actually do to a profile.
 */

import { hostname } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beginBoot, completeBoot, readBootState, summarizeBoot } from './boot.js'
import {
  disablePackage, enablePackage, pinPackageVersion, planDisable, readProfilePackage,
} from './compose.js'
import { COMPOSITION_FILES, describeProfile, listProfiles, profilePaths } from './describe.js'
import { readTextOrNull, sha256, withLock } from './fsx.js'
import { resolvePnpm, runPnpmInstall } from './pnpm.js'
import {
  createSnapshot, deleteSnapshot, diffSnapshot, listSnapshots, restoreSnapshot, summarizeSnapshot,
} from './snapshot.js'

/** Default auto-snapshot policy. */
export const DEFAULT_POLICY = {
  /** Capture a snapshot once a start completes successfully. */
  snapshotOnHealthyBoot: true,
  /** Skip the capture when nothing about the composition changed. */
  snapshotOnlyWhenChanged: true,
  /** Capture before the first mutation of a session. */
  snapshotBeforeChange: true,
  maxSnapshots: 30,
}

/**
 * Normalize constructor input into absolute paths plus a policy.
 * @param {{ profileDir: string, dshHome?: string, dshVersion?: string | null, yamlHints?: string[], runtimeDir?: string | null, pnpmCommand?: string | null, policy?: Partial<typeof DEFAULT_POLICY>, logger?: { info?: Function, warn?: Function } }} input
 */
export function createService(input) {
  const paths = profilePaths({ profileDir: input.profileDir, yamlHints: input.yamlHints })
  const policy = { ...DEFAULT_POLICY, ...(input.policy ?? {}) }
  const log = {
    info: (message) => input.logger?.info?.(`[dsh-version-guard] ${message}`),
    warn: (message) => input.logger?.warn?.(`[dsh-version-guard] ${message}`),
  }

  /** Whether a change-snapshot has already been taken in this process. */
  let preChangeTaken = false

  /** Capture, ignoring failure but never hiding it silently. */
  const captureQuietly = (reason, note) => {
    const result = createSnapshot({
      profileDir: paths.profileDir,
      reason,
      yamlHints: paths.yamlHints,
      maxSnapshots: policy.maxSnapshots,
      note,
      dshVersion: input.dshVersion ?? null,
    })
    if (result.ok) log.info(`captured ${result.id} (${reason})`)
    else log.warn(`snapshot failed (${reason}): ${result.error}`)
    return result
  }

  const service = {
    paths,
    policy,

    /** Read-only description of the profile. */
    describe() {
      return describeProfile({ profileDir: paths.profileDir, yamlHints: paths.yamlHints })
    },

    /** Everything both UIs need for one screen. */
    status() {
      const { state: bootState, repaired } = readBootState(paths.bootState)
      let description = null
      let descriptionError = null
      try {
        description = this.describe()
      } catch (error) {
        descriptionError = {
          code: typeof error?.code === 'string' ? error.code : 'unexpected',
          message: error instanceof Error ? error.message : String(error),
        }
      }
      const { snapshots, skips } = listSnapshots(paths.snapshotsDir)
      const livePackage = readTextOrNull(paths.packageJson)
      const newest = snapshots[0] ?? null
      return {
        schema: 1,
        generatedAt: new Date().toISOString(),
        host: {
          pid: process.pid,
          node: process.versions.node,
          platform: process.platform,
          hostname: hostname(),
          cwd: process.cwd(),
          dshVersion: input.dshVersion ?? null,
          inDsh: input.inDsh === true,
        },
        paths: {
          profileDir: paths.profileDir,
          profileName: paths.profileDir.split(/[\\/]/).pop() ?? null,
          snapshotsDir: paths.snapshotsDir,
          dshHome: input.dshHome ?? null,
        },
        boot: summarizeBoot(bootState),
        bootRepaired: repaired,
        profile: description,
        profileError: descriptionError,
        snapshots: snapshots.map(summarizeSnapshot),
        snapshotCount: snapshots.length,
        corruptSnapshots: skips,
        drift: newest === null || livePackage === null
          ? null
          : { sinceNewestSnapshot: newest.packageSha256 !== null && newest.packageSha256 !== sha256(livePackage) },
        policy,
      }
    },

    /** List snapshots, newest first. */
    list() {
      const { snapshots, skips } = listSnapshots(paths.snapshotsDir)
      return { snapshots: snapshots.map(summarizeSnapshot), skips }
    },

    /** Read one full snapshot document. */
    read(id) {
      const { snapshots } = listSnapshots(paths.snapshotsDir)
      const found = snapshots.find((snapshot) => snapshot.id === id)
      return found ?? null
    },

    /** Capture a snapshot, serialized against other writers. */
    async snapshot(options = {}) {
      const locked = await withLock(paths.lock, async () => createSnapshot({
        profileDir: paths.profileDir,
        reason: options.reason ?? 'manual',
        note: options.note,
        yamlHints: paths.yamlHints,
        maxSnapshots: policy.maxSnapshots,
        dshVersion: input.dshVersion ?? null,
        boot: summarizeBoot(readBootState(paths.bootState).state),
      }))
      if (locked === null) {
        const error = new Error('another version-guard operation is in progress')
        error.code = 'guard/busy'
        throw error
      }
      if (!locked.ok) {
        const error = new Error(locked.error)
        error.code = locked.code
        throw error
      }
      return locked
    },

    /** Delete a snapshot. */
    delete(id) {
      return { id, deleted: deleteSnapshot(paths.snapshotsDir, id) }
    },

    /** Preview the difference between a snapshot and the live profile. */
    diff(id) {
      return diffSnapshot({
        profileDir: paths.profileDir,
        snapshotsDir: paths.snapshotsDir,
        id,
        yamlHints: paths.yamlHints,
      })
    },

    /**
     * Roll the profile back to a snapshot. Composition files only; the caller
     * decides whether to run pnpm afterwards via `result.installRequired`.
     */
    async restore(id) {
      const locked = await withLock(paths.lock, async () => restoreSnapshot({
        profileDir: paths.profileDir,
        snapshotsDir: paths.snapshotsDir,
        id,
        yamlHints: paths.yamlHints,
        maxSnapshots: policy.maxSnapshots,
      }))
      if (locked === null) {
        const error = new Error('another version-guard operation is in progress')
        error.code = 'guard/busy'
        throw error
      }
      return locked
    },

    /** Run `pnpm install` so `node_modules` matches the restored manifest. */
    install(options = {}) {
      const pnpm = resolvePnpm({
        profileDir: paths.profileDir,
        runtimeDir: input.runtimeDir ?? null,
        explicit: input.pnpmCommand ?? null,
      })
      return runPnpmInstall({ profileDir: paths.profileDir, pnpm, timeoutMs: options.timeoutMs })
    },

    /** Explain a disable without performing it. */
    planDisable(name) {
      return planDisable({ profileDir: paths.profileDir, name, yamlHints: paths.yamlHints })
    },

    /** Stop a plugin from loading from the next start onwards. */
    async disable(name, options = {}) {
      return this.mutate(options, () => disablePackage(paths.profileDir, name))
    },

    /** Put a plugin back into the load list at a recorded version range. */
    async enable(name, range, options = {}) {
      return this.mutate(options, () => enablePackage(paths.profileDir, name, range, { position: options.position }))
    },

    /** Pin one plugin to an exact version. */
    async pin(name, version, options = {}) {
      return this.mutate(options, () => pinPackageVersion(paths.profileDir, name, version))
    },

    /**
     * Shared mutation wrapper: take a change snapshot once per process, run the
     * edit under the lock, and return the exact Cordis rows that changed.
     */
    async mutate(options, run) {
      const locked = await withLock(paths.lock, async () => {
        if (policy.snapshotBeforeChange && !preChangeTaken) {
          preChangeTaken = true
          captureQuietly('pre-change', options.note ?? 'automatic snapshot before a composition change')
        }
        const outcome = run()
        return {
          changed: outcome.changed,
          detail: outcome.result ?? null,
          packageJson: readTextOrNull(paths.packageJson),
        }
      })
      if (locked === null) {
        const error = new Error('another version-guard operation is in progress')
        error.code = 'guard/busy'
        throw error
      }
      return locked
    },

    /**
     * Boot bookkeeping, called by the host plugin. Returns what the caller needs
     * to decide whether to warn the user about a crash loop.
     */
    beginBoot(detail) {
      return beginBoot({
        path: paths.bootState,
        profileDir: paths.profileDir,
        dshVersion: input.dshVersion ?? null,
        detail,
      })
    },

    completeBoot() {
      return completeBoot({ path: paths.bootState, dshVersion: input.dshVersion ?? null })
    },

    bootSummary() {
      return summarizeBoot(readBootState(paths.bootState).state)
    },

    /**
     * Called by the host plugin once the server is confirmed serving: record
     * the healthy start and, per policy, snapshot the composition that produced
     * it. This snapshot is the "known good" a user rolls back to.
     */
    async onHealthyBoot() {
      const state = completeBoot({ path: paths.bootState, dshVersion: input.dshVersion ?? null })
      let snapshotted = null
      if (policy.snapshotOnHealthyBoot) {
        const livePackage = readTextOrNull(paths.packageJson)
        if (livePackage !== null) {
          const { snapshots } = listSnapshots(paths.snapshotsDir)
          const newestBoot = snapshots.find((snapshot) => snapshot.reason === 'boot')
          const unchanged = newestBoot !== undefined
            && newestBoot.packageSha256 === sha256(livePackage)
            && policy.snapshotOnlyWhenChanged
          if (!unchanged) {
            const result = await withLock(paths.lock, async () => createSnapshot({
              profileDir: paths.profileDir,
              reason: 'boot',
              yamlHints: paths.yamlHints,
              maxSnapshots: policy.maxSnapshots,
              dshVersion: input.dshVersion ?? null,
              note: 'captured after a successful start',
              boot: summarizeBoot(state),
            }))
            if (result !== null && result.ok) {
              snapshotted = result.id
              log.info(`captured ${result.id} after a healthy start`)
            }
          }
        }
      }
      return { boot: summarizeBoot(readBootState(paths.bootState).state), snapshot: snapshotted }
    },

    /**
     * One-shot repair for "DSH will not start": restore the newest snapshot that
     * differs from the live composition, preferring the most recent healthy
     * start. Falls back to a report when there is nothing to restore.
     * @param {{ dryRun?: boolean }} [options]
     */
    async rescue(options = {}) {
      const livePackage = readTextOrNull(paths.packageJson)
      if (livePackage === null) {
        return { ok: false, code: 'profile/not-found', error: 'package.json is missing from the profile' }
      }
      const { snapshots } = listSnapshots(paths.snapshotsDir)
      if (snapshots.length === 0) {
        return { ok: false, code: 'rescue/no-snapshots', error: 'this profile has no snapshots to fall back to' }
      }
      const liveHash = sha256(livePackage)
      const differs = (snapshot) => snapshot.packageSha256 !== null && snapshot.packageSha256 !== liveHash
      // Only a snapshot that records a state we were moving TOWARD is a rescue
      // candidate. `pre-change` / `pre-restore` snapshots preserve the state we
      // were leaving, so restoring one would re-apply the very composition
      // being repaired. A rescue that keeps toggling between two states is
      // worse than a rescue that admits it has nothing safe to offer.
      const TRUSTED_REASONS = new Set(['boot', 'manual', 'recovery'])
      const trusted = snapshots.filter((snapshot) => TRUSTED_REASONS.has(snapshot.reason))
      const candidate = trusted.find(differs)
      if (candidate === undefined) {
        return {
          ok: false,
          code: 'rescue/nothing-to-do',
          error: trusted.length === 0
            ? 'no snapshot records a composition that successfully started'
            : 'the live composition already matches every known-good snapshot',
          snapshots: snapshots.map(summarizeSnapshot),
        }
      }
      if (options.dryRun === true) {
        return { ok: true, dryRun: true, wouldRestore: summarizeSnapshot(candidate) }
      }
      const result = await this.restore(candidate.id)
      return { ok: result.ok === true, target: summarizeSnapshot(candidate), result }
    },
  }

  return service
}

/**
 * List the profiles of a DSH home plus a one-line health summary each, used by
 * the offline page's profile picker.
 * @param {{ dshHome: string, yamlHints?: string[] }} input
 */
export function listProfilesWithHealth(input) {
  return listProfiles(input.dshHome).map((profile) => {
    let summary = null
    let error = null
    try {
      const description = describeProfile({ profileDir: profile.dir, yamlHints: input.yamlHints })
      summary = {
        stats: description.stats,
        bundles: description.profile.bundles,
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    let snapshotCount = 0
    try {
      snapshotCount = listSnapshots(join(profile.dir, '.dsh-version-guard', 'snapshots')).snapshots.length
    } catch { /* no guard directory yet */ }
    return {
      name: profile.name,
      dir: profile.dir,
      hasPackage: profile.hasPackage,
      modifiedAtMs: profile.mtimeMs,
      snapshotCount,
      compositionFiles: COMPOSITION_FILES.filter((relative) => existsSync(join(profile.dir, relative))),
      summary,
      error,
    }
  })
}

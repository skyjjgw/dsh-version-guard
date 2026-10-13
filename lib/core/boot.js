/**
 * Boot guard: the reason a crashed DSH can be *detected* at all.
 *
 * A boot writes a pending record when the host plugin starts and completes that
 * record once the server is actually serving. A pending record found on the
 * next start means the previous start died before it finished — that is the
 * crash-loop signal, and it is what turns "DSH will not open" into "the last
 * start did not finish, here are the versions it was running".
 *
 * The record is intentionally tiny and written on every start: it must survive
 * a process that is about to crash for reasons we cannot predict.
 */

import { readJsonOrNull, stringifyJson, writeFileAtomic } from './fsx.js'

/** Boot state schema version. */
export const BOOT_SCHEMA = 1
/** Consecutive unfinished starts that count as a crash loop. */
export const CRASH_LOOP_THRESHOLD = 2

/**
 * @typedef {{
 *   schema: number,
 *   pending: { at: string, pid: number, dshVersion: string | null, attempt: number } | null,
 *   consecutiveFailures: number,
 *   lastCompletedAt: string | null,
 *   lastCompletedVersion: string | null,
 *   totalCompleted: number,
 *   totalAttempts: number,
 *   lastFailedAt: string | null,
 *   lastFailureDetail: string | null,
 *   updatedAt: string | null,
 * }} BootState
 */

/** @returns {BootState} */
export function emptyBootState() {
  return {
    schema: BOOT_SCHEMA,
    pending: null,
    consecutiveFailures: 0,
    lastCompletedAt: null,
    lastCompletedVersion: null,
    totalCompleted: 0,
    totalAttempts: 0,
    lastFailedAt: null,
    lastFailureDetail: null,
    updatedAt: null,
  }
}

/**
 * Read boot state, tolerating any corruption by falling back to empty and
 * reporting it. A crash-loop guard that throws on a malformed file would itself
 * become the reason DSH cannot start.
 * @param {string} path
 * @returns {{ state: BootState, repaired: string | null }}
 */
export function readBootState(path) {
  let parsed
  try {
    parsed = readJsonOrNull(path, 'boot/invalid-json')
  } catch (error) {
    return { state: emptyBootState(), repaired: error instanceof Error ? error.message : String(error) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: emptyBootState(), repaired: parsed === null ? null : 'boot state is not an object' }
  }
  const raw = /** @type {Record<string, any>} */ (parsed)
  const base = emptyBootState()
  return {
    repaired: null,
    state: {
      schema: BOOT_SCHEMA,
      pending: raw.pending !== null && typeof raw.pending === 'object' ? raw.pending : null,
      consecutiveFailures: Number.isFinite(raw.consecutiveFailures) ? Math.max(0, raw.consecutiveFailures) : 0,
      lastCompletedAt: typeof raw.lastCompletedAt === 'string' ? raw.lastCompletedAt : null,
      lastCompletedVersion: typeof raw.lastCompletedVersion === 'string' ? raw.lastCompletedVersion : null,
      totalCompleted: Number.isFinite(raw.totalCompleted) ? raw.totalCompleted : 0,
      totalAttempts: Number.isFinite(raw.totalAttempts) ? raw.totalAttempts : 0,
      lastFailedAt: typeof raw.lastFailedAt === 'string' ? raw.lastFailedAt : null,
      lastFailureDetail: typeof raw.lastFailureDetail === 'string' ? raw.lastFailureDetail : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    },
  }
}

/**
 * @param {string} path
 * @param {BootState} state
 */
export function writeBootState(path, state) {
  writeFileAtomic(path, stringifyJson({ ...state, updatedAt: new Date().toISOString() }))
}

/**
 * Record the start of a boot attempt.
 *
 * If the previous attempt never completed, that failure is counted here — this
 * is the only place a failure can be observed, because the failing process died
 * before it could report anything.
 *
 * @param {{ path: string, profileDir: string, dshVersion?: string | null, pid?: number, detail?: string | null }} input
 * @returns {{ state: BootState, crashedPreviously: boolean, crashLoop: boolean, cleanShutdown: boolean }}
 */
export function beginBoot(input) {
  const { state: previous } = readBootState(input.path)
  const crashedPreviously = previous.pending !== null
  const consecutiveFailures = crashedPreviously ? previous.consecutiveFailures + 1 : previous.consecutiveFailures
  const state = {
    ...previous,
    pending: {
      at: new Date().toISOString(),
      pid: input.pid ?? process.pid,
      dshVersion: input.dshVersion ?? null,
      attempt: previous.totalAttempts + 1,
    },
    consecutiveFailures,
    totalAttempts: previous.totalAttempts + 1,
    lastFailedAt: crashedPreviously ? (previous.lastFailedAt ?? previous.pending?.at ?? null) : previous.lastFailedAt,
    lastFailureDetail: crashedPreviously ? (input.detail ?? previous.lastFailureDetail) : previous.lastFailureDetail,
  }
  writeBootState(input.path, state)
  return {
    state,
    crashedPreviously,
    crashLoop: crashedPreviously && consecutiveFailures >= CRASH_LOOP_THRESHOLD,
    cleanShutdown: previous.pending === null,
  }
}

/**
 * Mark the current boot as completed successfully.
 * @param {{ path: string, dshVersion?: string | null }} input
 * @returns { BootState }
 */
export function completeBoot(input) {
  const { state: previous } = readBootState(input.path)
  const state = {
    ...previous,
    pending: null,
    consecutiveFailures: 0,
    lastCompletedAt: new Date().toISOString(),
    lastCompletedVersion: input.dshVersion ?? previous.lastCompletedVersion,
    totalCompleted: previous.totalCompleted + 1,
  }
  writeBootState(input.path, state)
  return state
}

/**
 * Mark the current boot as failed without waiting for the process to die, so
 * a plugin that knows it broke the host can hand the next start an accurate
 * failure count.
 * @param {{ path: string, detail?: string | null }} input
 */
export function failBoot(input) {
  const { state: previous } = readBootState(input.path)
  const state = {
    ...previous,
    pending: null,
    consecutiveFailures: previous.consecutiveFailures + 1,
    lastFailedAt: new Date().toISOString(),
    lastFailureDetail: input.detail ?? previous.lastFailureDetail,
  }
  writeBootState(input.path, state)
  return state
}

/**
 * Human-facing boot summary used by both UIs.
 * @param {BootState} state
 */
export function summarizeBoot(state) {
  const pending = state.pending
  return {
    crashLoop: pending !== null && state.consecutiveFailures >= CRASH_LOOP_THRESHOLD,
    unfinishedStart: pending !== null,
    pending,
    consecutiveFailures: state.consecutiveFailures,
    lastCompletedAt: state.lastCompletedAt,
    lastCompletedVersion: state.lastCompletedVersion,
    totalCompleted: state.totalCompleted,
    totalAttempts: state.totalAttempts,
    lastFailedAt: state.lastFailedAt,
    lastFailureDetail: state.lastFailureDetail,
  }
}

/**
 * Filesystem helpers: atomic writes, safe JSON reads, byte hashing and a small
 * cross-process lock. Every mutation of a profile file goes through
 * {@link writeFileAtomic} so a crash mid-write can never leave a truncated
 * `package.json` — a half-written composition file would be unrecoverable.
 */

import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * Whether a thrown value is a Node `ENOENT` (missing path).
 * @param {unknown} error
 */
export function isMissing(error) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

/**
 * True only when the path entry itself is absent. `readFileSync` also reports
 * ENOENT for a dangling symlink; callers that turn "missing" into a delete
 * instruction must not confuse the two.
 * @param {string} path
 */
export function isTrulyAbsent(path) {
  try {
    statSync(path)
    return false
  } catch {
    return true
  }
}

/**
 * Read a UTF-8 text file, or `null` when it does not exist. Any other failure
 * (EACCES, EISDIR, a dangling symlink) throws: silently treating an unreadable
 * file as absent would let a later restore delete real user data.
 * @param {string} path
 * @returns {string | null}
 */
export function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissing(error) && isTrulyAbsent(path)) return null
    throw error
  }
}

/**
 * Parse JSON, returning `null` for absent files and throwing a coded error for
 * malformed content so the caller can report *which* file is broken.
 * @param {string} path
 * @param {string} code Error code used when the content is not valid JSON.
 * @returns {unknown | null}
 */
export function readJsonOrNull(path, code) {
  const text = readTextOrNull(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error(`${path} is not valid JSON`)
    error.code = code
    throw error
  }
}

/**
 * Sleep synchronously for `ms`. Used only by the rename retry below: this code
 * runs inside boot paths where an await would reorder the caller's logic.
 * @param {number} ms
 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

/**
 * `renameSync` with bounded retries.
 *
 * On Windows a rename over an existing file can transiently fail with EPERM or
 * EBUSY when an antivirus scanner, the search indexer or another process holds
 * a handle on the target. That is exactly the environment this tool runs in —
 * a profile being repaired after a crash — so a single attempt is not enough.
 * @param {string} from
 * @param {string} to
 */
function renameWithRetry(from, to) {
  const delays = [0, 4, 12, 30, 75, 150]
  let lastError
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) sleepSync(delays[attempt])
    try {
      renameSync(from, to)
      return
    } catch (error) {
      lastError = error
      const code = error?.code
      // Only contention is worth retrying; ENOENT/EACCES will not heal.
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
    }
  }
  throw lastError
}

/**
 * Atomic same-directory replace: write a sibling temp file, then rename over
 * the target. `rename` is atomic on the same volume, so readers only ever see
 * the old or the new bytes, never a partial write.
 * @param {string} path
 * @param {string} content
 */
export function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.vg-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    writeFileSync(temp, content)
    renameWithRetry(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch { /* best-effort temp cleanup */ }
    // Last resort: write in place. A non-atomic write is strictly better than
    // losing the record entirely, and the caller's own validation still applies
    // (a torn boot.json is repaired by readBootState, a torn snapshot is
    // rejected by validateSnapshot).
    if (error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES') {
      writeFileSync(path, content)
      return
    }
    throw error
  }
}

/**
 * Stable hex sha256 of a string, used as a cheap change marker in snapshot
 * metadata so the UI can say "this snapshot differs from the live profile".
 * @param {string} text
 */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** JSON stringify with 2-space indent and a trailing newline (repo convention). */
export function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * `*.json` basenames (extension stripped) in a directory; `[]` when absent.
 * @param {string} dir
 * @returns {string[]}
 */
export function listJsonIds(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
  } catch {
    return []
  }
}

/**
 * Run `fn` while holding an exclusive lock file, so concurrent snapshot
 * captures from the host plugin and the offline page cannot interleave.
 * Returns `null` instead of blocking when the lock is held and not stale.
 * @template T
 * @param {string} lockPath
 * @param {() => T | Promise<T>} fn
 * @param {{ staleMs?: number }} [options]
 * @returns {Promise<T | null>}
 */
export async function withLock(lockPath, fn, options = {}) {
  const staleMs = options.staleMs ?? 30_000
  mkdirSync(dirname(lockPath), { recursive: true })
  const acquire = () => {
    const handle = openSync(lockPath, 'wx')
    try {
      // Record the owner so a stale lock can be attributed in diagnostics.
      writeSync(handle, `${process.pid}@${new Date().toISOString()}\n`)
    } catch { /* the pid line is diagnostic only */ }
    return handle
  }
  let handle
  try {
    handle = acquire()
  } catch (error) {
    if (!isMissing(error) && error?.code !== 'EEXIST') throw error
    // Lock exists: reclaim it only when it is provably stale.
    let age
    try {
      age = Date.now() - statSync(lockPath).mtimeMs
    } catch {
      return null
    }
    if (age <= staleMs) return null
    try {
      rmSync(lockPath, { force: true })
      handle = acquire()
    } catch {
      return null
    }
  }
  try {
    return await fn()
  } finally {
    try {
      closeSync(handle)
    } catch { /* already closed */ }
    try {
      rmSync(lockPath, { force: true })
    } catch { /* best-effort unlock */ }
  }
}

/** True when the directory exists. */
export function dirExists(dir) {
  return existsSync(dir)
}

/**
 * pnpm invocation.
 *
 * Restoring composition files changes *what should be installed*, not what is
 * installed. Nothing here runs automatically: an install can fail, needs the
 * network, and must never be triggered by merely opening a recovery page. The
 * caller asks for it explicitly and receives the full log.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Locate a usable pnpm.
 *
 * Order: an explicit hint, the profile's own hoisted `node_modules/pnpm` (pnpm
 * is a normal dependency of the DSH desktop bundle), then the DSH runtime
 * payload.
 * @param {{ profileDir?: string, runtimeDir?: string | null, explicit?: string | null }} [input]
 * @returns {{ command: string, args: string[], source: string } | null}
 */
export function resolvePnpm(input = {}) {
  const candidates = []
  if (typeof input.explicit === 'string' && input.explicit.length > 0) {
    candidates.push({ command: input.explicit, args: [], source: 'explicit' })
  }
  if (typeof input.profileDir === 'string') {
    const local = join(input.profileDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (existsSync(local)) candidates.push({ command: process.execPath, args: [local], source: 'profile node_modules/pnpm' })
  }
  if (typeof input.runtimeDir === 'string' && input.runtimeDir.length > 0) {
    const runtime = join(input.runtimeDir, 'pnpm', 'bin', 'pnpm.cjs')
    if (existsSync(runtime)) candidates.push({ command: process.execPath, args: [runtime], source: 'DSH runtime payload' })
  }
  candidates.push({ command: 'pnpm', args: [], source: 'PATH' })
  return candidates[0] ?? null
}

/**
 * Run `pnpm install` in a profile directory.
 *
 * `--ignore-scripts` mirrors how DSH itself installs profile dependencies:
 * postinstall scripts from community packages are not part of loading a plugin
 * and running them during a recovery is exactly the moment to avoid surprises.
 *
 * @param {{ profileDir: string, pnpm?: { command: string, args: string[], source: string } | null, timeoutMs?: number, extraArgs?: string[] }} input
 * @returns {Promise<{ ok: boolean, code: number | null, signal: string | null, log: string, command: string, timedOut: boolean }>}
 */
export function runPnpmInstall(input) {
  const pnpm = input.pnpm ?? resolvePnpm({ profileDir: input.profileDir })
  if (pnpm === null) {
    return Promise.resolve({
      ok: false,
      code: null,
      signal: null,
      log: 'no pnpm executable found',
      command: '',
      timedOut: false,
    })
  }
  const args = [...pnpm.args, 'install', '--ignore-scripts', ...(input.extraArgs ?? [])]
  const timeoutMs = input.timeoutMs ?? 180_000
  return new Promise((resolve) => {
    let log = ''
    let timedOut = false
    let settled = false
    const child = spawn(pnpm.command, args, {
      cwd: input.profileDir,
      env: { ...process.env, CI: '1' },
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch { /* already gone */ }
    }, timeoutMs)
    const append = (chunk) => {
      log += chunk.toString()
      // Keep the tail; a pathological install log must not exhaust memory.
      if (log.length > 200_000) log = log.slice(-200_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        log,
        command: `${pnpm.command} ${args.join(' ')}`,
        timedOut,
      })
    }
    child.on('error', (error) => {
      append(`\nspawn failed: ${error.message}`)
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

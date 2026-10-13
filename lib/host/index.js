/**
 * DSH 版本守卫 · 宿主插件
 *
 * 三件事：
 *  1. 每次启动写一条「启动中」记录，服务真正可用后再标记为成功。这样下一次
 *     启动就能知道上一次是否中途死掉 —— 这是发现「DSH 打不开」的唯一可靠信号。
 *  2. 成功启动后自动记录一个回退点（版本号 + 配置），作为已知可用版本。
 *  3. 把离线恢复页所使用的那套 HTTP API 挂到 DSH 自己的 web 服务上，同时让
 *     客户端在设置里能打开「版本守卫」页。
 *
 * 设计原则：本插件自身绝不能成为 DSH 起不来的原因。所有启动期工作都包在
 * try/catch 里，失败只记日志，绝不抛出。救援入口在 lib/bin/version-guard.js，
 * 完全不经过这里，所以即使本插件本身有问题，救援依然可用。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createService } from '../core/store.js'
import { detectActiveProfile, detectDshHome, extraRootsFor, yamlHintCandidates } from '../recovery/detect.js'
import { mountGuardRoutes } from './routes.js'

export const name = 'versionGuard'

/** Services the plugin needs before `apply` runs. */
export const inject = ['webServer']

/** Resolve js-yaml from the DSH application payload without hard-coding a path. */
function yamlHintsFor(profileDir, dshHome) {
  return yamlHintCandidates({
    profileDir,
    env: process.env,
    extraRoots: extraRootsFor(dshHome),
  })
}

/**
 * Confirm the web server is genuinely answering before calling a boot healthy.
 *
 * A TCP listener is not proof that the UI works, so the guard only records
 * success once an HTTP request to the server itself returns a real response.
 *
 * @param {{ port: number, host: string }} target
 * @returns {Promise<boolean>}
 */
async function probeWebServer(target) {
  const host = target.host === '0.0.0.0' || target.host === '::' ? '127.0.0.1' : target.host
  try {
    const response = await fetch(`http://${host}:${target.port}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(2500),
    })
    return typeof response.status === 'number' && response.status > 0
  } catch {
    return false
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ snapshotOnHealthyBoot?: boolean, maxSnapshots?: number, profile?: string, quietBootLog?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  const log = {
    info: (message) => {
      try { ctx.logger?.info?.(`[dsh-version-guard] ${message}`) } catch { /* logging must not throw */ }
    },
    warn: (message) => {
      try { ctx.logger?.warn?.(`[dsh-version-guard] ${message}`) } catch { /* logging must not throw */ }
    },
  }

  const detected = detectDshHome(process.env)
  if (detected.home === null) {
    log.warn(`could not determine the DSH home; version guard is inactive (tried: ${detected.candidates.join(', ')})`)
    return
  }
  const dshHome = detected.home

  // Which profile is this process actually running? Everything the guard writes
  // goes into that profile, so guessing wrong would quietly protect a profile
  // nobody is using — the exact failure this tool exists to prevent.
  // `detectActiveProfile` prefers the launcher's own --profile argument.
  const active = detectActiveProfile({
    dshHome,
    env: process.env,
    argv: process.argv,
    configured: typeof config.profile === 'string' && config.profile.length > 0 ? config.profile : null,
  })
  const profileName = active.name
  const profileDir = active.dir
  if (!active.confident) {
    log.warn(`could not read the active profile from --profile or DSH_PROFILE; using ${JSON.stringify(profileName)}`
      + ` (source: ${active.source}, candidates: ${active.candidates.map((entry) => entry.name).join(', ') || 'none'}).`
      + ' Set `profile` in this plugin\'s config if that is wrong.')
  }
  if (!existsSync(join(profileDir, 'package.json'))) {
    log.warn(`profile ${JSON.stringify(profileName)} has no package.json (${profileDir}); rollback points would be`
      + ' written to a profile DSH does not load. Set `profile` in this plugin\'s config.')
  }

  const policy = {
    snapshotOnHealthyBoot: config.snapshotOnHealthyBoot !== false,
    maxSnapshots: Number.isFinite(config.maxSnapshots) ? Math.max(1, Number(config.maxSnapshots)) : 30,
  }

  // Service construction reads no profile state, so a throw here is a genuine
  // bug — but it still must not stop DSH from booting.
  let service = null
  try {
    service = createService({
      profileDir,
      dshHome,
      dshVersion: typeof process.env.DSH_CLIENT_VERSION === 'string' ? process.env.DSH_CLIENT_VERSION : null,
      yamlHints: yamlHintsFor(profileDir, dshHome),
      inDsh: true,
      policy,
      logger: { info: log.info, warn: log.warn },
    })
  } catch (error) {
    log.warn(`service construction failed, guard inactive: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  let crashLoop = false
  try {
    const begun = service.beginBoot(null)
    crashLoop = begun.crashLoop
  } catch (error) {
    log.warn(`boot bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let healthyReported = false

  /** Record the healthy start and, per policy, snapshot the composition. */
  const reportHealthy = (reason) => {
    if (healthyReported) return
    healthyReported = true
    service.onHealthyBoot().then((result) => {
      if (result.snapshot !== null) {
        log.info(`recorded rollback point ${result.snapshot} after a healthy start (${reason})`)
      }
    }).catch((error) => {
      log.warn(`healthy-boot bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // 1. Mount the HTTP API shared by the offline page and the in-DSH page.
  try {
    const routes = mountGuardRoutes({
      webServer: ctx.webServer,
      serviceFor: () => service,
      listProfiles: () => [{
        name: profileName,
        dir: profileDir,
        hasPackage: true,
        modifiedAtMs: Date.now(),
        snapshotCount: service.list().snapshots.length,
        compositionFiles: [],
        summary: null,
        error: null,
      }],
      logger: log,
    })
    ctx.effect(() => routes, 'version-guard: http routes')
  } catch (error) {
    log.warn(`could not mount guard routes: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 2. Settle the boot record once the server really answers.
  try {
    const port = ctx.webServer?.port
    const host = typeof ctx.webServer?.host === 'string' ? ctx.webServer.host : '127.0.0.1'
    if (typeof port === 'number' && port > 0) {
      let attempts = 0
      const timer = setInterval(() => {
        attempts += 1
        if (healthyReported || attempts > 40) {
          clearInterval(timer)
          if (!healthyReported) log.warn('the web server never answered; this start counts as failed next time')
          return
        }
        probeWebServer({ port, host }).then((alive) => {
          if (alive) {
            clearInterval(timer)
            reportHealthy('the web server answered')
          }
        }).catch(() => { /* retried until the deadline */ })
      }, 500)
      if (typeof timer.unref === 'function') timer.unref()
      ctx.effect(() => () => clearInterval(timer), 'version-guard: boot readiness probe')
    } else {
      // Without a port nothing can be verified, and a wrong "healthy" record
      // would hide exactly the crash the user needs to see.
      log.warn('the web server exposes no port; boot success will not be recorded')
    }
  } catch (error) {
    log.warn(`could not start the boot readiness probe: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 3. Surface a crash loop in the console, where a user stuck at a broken start
  //    will actually look for it.
  if (crashLoop) {
    console.warn('')
    console.warn('  ⛔ DSH 版本守卫：检测到 DSH 连续启动失败。')
    console.warn('     请运行 dsh-version-guard.cmd（或 dsh-version-guard.ps1）打开离线恢复页，')
    console.warn('     然后点「一键救援」退回最近一次成功启动的版本。')
    console.warn('')
  }

  // Expose the service so other host code (or a future tool) can reach it.
  try {
    ctx.provide('versionGuard', {
      status: () => service.status(),
      list: () => service.list(),
      snapshot: (options) => service.snapshot(options),
      restore: (id) => service.restore(id),
      diff: (id) => service.diff(id),
      rescue: (options) => service.rescue(options),
      disable: (packageName, options) => service.disable(packageName, options),
      enable: (packageName, range, options) => service.enable(packageName, range, options),
      pin: (packageName, version, options) => service.pin(packageName, version, options),
      install: (options) => service.install(options),
      paths: service.paths,
    })
  } catch (error) {
    log.warn(`could not register the versionGuard service: ${error instanceof Error ? error.message : String(error)}`)
  }
}

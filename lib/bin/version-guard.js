#!/usr/bin/env node
/**
 * DSH 版本守卫 · 离线恢复页启动器
 *
 * 当插件冲突导致 DSH 无法启动时，这个脚本是唯一的救援入口。它只依赖 Node
 * 和 profile 目录，不加载任何 DSH 代码 —— 所以 DSH 完全打不开时它依然能用。
 *
 * 用法（Windows 上直接双击 dsh-version-guard.cmd 等价于无参数运行）：
 *   node lib/bin/version-guard.js                    打开恢复页
 *   node lib/bin/version-guard.js --list             只列出 profile 和版本状况
 *   node lib/bin/version-guard.js --status           打印当前 profile 的完整状态
 *   node lib/bin/version-guard.js --snapshot         记录一个回退点后退出
 *   node lib/bin/version-guard.js --rescue           自动回退到最近可用版本后退出
 *   node lib/bin/version-guard.js --rescue --dry-run 只报告会回退到哪一版
 *   node lib/bin/version-guard.js --install          同步依赖（pnpm install）
 *   node lib/bin/version-guard.js --profile web      指定 profile
 *   node lib/bin/version-guard.js --port 4000        指定端口
 *   node lib/bin/version-guard.js --host 0.0.0.0     允许局域网访问（默认仅本机）
 *   node lib/bin/version-guard.js --no-open          不自动打开浏览器
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createService, listProfilesWithHealth } from '../core/store.js'
import { profileDirFor } from '../core/describe.js'
import { detectActiveProfile, detectDshHome, extraRootsFor, listProfileDirs, yamlHintCandidates } from '../recovery/detect.js'
import { RECOVERY_HTML } from '../recovery/page.js'
import { startRecoveryServer } from '../recovery/server.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** Package root, two levels above lib/bin. */
const PACKAGE_ROOT = resolve(HERE, '..', '..')

/** Read the guard's own version. */
function readOwnVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Resolve everything the run needs: DSH home, the profile, and yaml hints.
 * @param {{ profile?: string, env?: NodeJS.ProcessEnv }} input
 */
function resolveEnvironment(input) {
  const env = input.env ?? process.env
  const detected = detectDshHome(env)
  if (detected.home === null) {
    fail([
      '找不到 DSH 主目录（应为包含 profiles/ 的目录）。',
      `已尝试：${detected.candidates.join('  |  ')}`,
      '请设置环境变量 DSH_HOME 指向它，例如：set DSH_HOME=E:\\dsh\\data',
    ])
  }
  const dshHome = detected.home
  const extraRoots = extraRootsFor(dshHome)

  const requested = typeof input.profile === 'string' && input.profile.length > 0 ? input.profile : null
  let profileDir
  if (requested !== null) {
    profileDir = profileDirFor(dshHome, requested)
    if (profileDir === null) {
      fail([
        `不安全的 profile 名称：${JSON.stringify(requested)}`,
        '只允许字母、数字、空格、点、下划线和连字符，且不能包含路径分隔符。',
      ])
    }
  } else {
    // No name given: reuse the in-DSH plugin's resolution, so the offline page
    // and the plugin always operate on the same profile.
    const active = detectActiveProfile({ dshHome, env, argv: process.argv })
    profileDir = active.dir
    if (!existsSync(profileDir) && active.source !== 'recent' && active.source !== 'single' && active.source !== 'default') {
      // The name came from configuration rather than from the filesystem — an
      // environment variable pointing at a profile that does not exist here is
      // common (DSH_PROFILE can be set machine-wide). Falling back keeps a
      // double-click working instead of refusing over a stale hint.
      const usable = listProfileDirs(dshHome).filter((entry) => entry.hasPackage)
      if (usable.length > 0) {
        console.log(`注意：${active.source === 'env' ? '环境变量 DSH_PROFILE' : '配置'}`
          + ` 指向的 profile ${JSON.stringify(active.name)} 不存在，已改用 ${JSON.stringify(usable[0].name)}。`)
        console.log('      如果不是你想操作的那个，请用 --profile <名称> 指定。\n')
        profileDir = usable[0].dir
      }
    }
    if (!active.confident && existsSync(profileDir) && profileDir === active.dir) {
      console.log(`提示：没有指定 --profile，已选用 ${JSON.stringify(active.name)}（依据：${active.source}）。`)
      console.log(`      可选：${active.candidates.map((entry) => entry.name).join(', ') || '（无）'}`)
      console.log('      如果不是你想操作的那个，请用 --profile <名称> 指定。\n')
    }
  }

  if (profileDir === null || !existsSync(profileDir)) {
    const available = listProfileDirs(dshHome).map((entry) => entry.name)
    fail([
      requested === null
        ? `没有找到 profile（解析结果：${String(profileDir)}）。`
        : `profile 不存在：${profileDir}`,
      available.length > 0 ? `可用的 profile：${available.join(', ')}` : '该 DSH 主目录下还没有任何 profile。',
      requested === null && env.DSH_PROFILE
        ? `注意：环境变量 DSH_PROFILE=${JSON.stringify(env.DSH_PROFILE)} 指向了一个不存在的 profile，`
          + `但主目录里只有上面这些。用 --profile <名称> 明确指定即可。`
        : '用 --profile <名称> 指定要操作的 profile。',
    ])
  }
  const yamlHints = yamlHintCandidates({ profileDir, env, extraRoots })
  return { dshHome, profileDir, yamlHints, extraRoots }
}

/** Print a fatal, actionable message and exit non-zero. */
function fail(lines) {
  console.error('\n✗ ' + lines[0])
  for (const line of lines.slice(1)) console.error('  ' + line)
  process.exit(1)
}

/** Build the service plus the profile list shared by every mode. */
function buildContext(environment) {
  const { dshHome, profileDir, yamlHints, extraRoots } = environment
  const runtimeDir = pickRuntimeDir(extraRoots)
  const makeService = (dir) => createService({
    profileDir: dir,
    dshHome,
    yamlHints,
    runtimeDir,
    inDsh: false,
    logger: { info: (message) => console.log(message), warn: (message) => console.warn(message) },
  })
  /**
   * Resolve a requested profile name.
   *
   * `null`/`undefined` (no profile named) means "the profile this run was
   * started for" — NOT the profiles root, which is a directory of profiles.
   * That distinction matters: joining a name is what makes the profiles root a
   * valid answer for the *empty* name, and the guard would then report an empty
   * profile and write its state beside the real ones.
   */
  const serviceFor = (profileName) => {
    if (profileName === null || profileName === undefined || profileName === '') {
      return existsSync(join(profileDir, 'package.json')) ? makeService(profileDir) : null
    }
    const dir = profileDirFor(dshHome, profileName)
    // A rejected name resolves to null and is reported as an unknown profile
    // rather than being joined onto the filesystem.
    if (dir === null || !existsSync(join(dir, 'package.json'))) return null
    return makeService(dir)
  }
  const listProfiles = () => listProfilesWithHealth({ dshHome, yamlHints })
  return { service: serviceFor(null), serviceFor, listProfiles, dshHome, profileDir, yamlHints }
}

/** Find a DSH runtime payload directory, used to reach a bundled pnpm. */
function pickRuntimeDir(extraRoots) {
  for (const root of extraRoots) {
    const candidate = join(root, 'resources', 'runtime')
    if (existsSync(join(candidate, 'pnpm', 'bin', 'pnpm.cjs'))) return candidate
    const nested = join(root, 'runtime')
    if (existsSync(join(join(nested, 'pnpm', 'bin', 'pnpm.cjs')))) return nested
  }
  return null
}

/** Open a URL in the platform's default browser. */
function openBrowser(url) {
  const command = process.platform === 'win32'
    ? { file: 'cmd', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : { file: 'xdg-open', args: [url] }
  try {
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch { /* the URL is printed regardless */ }
}

/** One-line plugin summary for console output. */
function pluginLine(plugin) {
  const version = plugin.installed ?? '未安装'
  const state = plugin.state === 'enabled' ? '启用' : plugin.state === 'disabled' ? '停用' : '未知'
  const issues = plugin.issues.length > 0 ? `  ⚠ ${plugin.issues.join('; ')}` : ''
  return `  ${state}  ${plugin.name}@${version}${plugin.requested ? ` (要求 ${plugin.requested})` : ''}${issues}`
}

async function main() {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      snapshot: { type: 'boolean', default: false },
      rescue: { type: 'boolean', default: false },
      install: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      profile: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    console.log(await readOwnDoc())
    return
  }

  const environment = resolveEnvironment({ profile: values.profile })
  const context = buildContext(environment)

  if (values.list) {
    const profiles = context.listProfiles()
    if (values.json) {
      console.log(JSON.stringify(profiles, null, 2))
      return
    }
    console.log(`DSH 主目录：${context.dshHome}`)
    console.log(`发现 ${profiles.length} 个 profile：\n`)
    for (const profile of profiles) {
      const stats = profile.summary?.stats
      console.log(`  ${profile.name}`)
      console.log(`    路径      ${profile.dir}`)
      console.log(`    插件      ${stats ? `${stats.total} 个（${stats.enabled} 启用 / ${stats.disabled} 停用，${stats.withIssues} 个有问题）` : '读取失败'}`)
      console.log(`    回退点    ${profile.snapshotCount} 个`)
      if (profile.error) console.log(`    ⚠ ${profile.error}`)
      console.log('')
    }
    return
  }

  if (values.status) {
    const status = context.service.status()
    if (values.json) {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    console.log(`profile：${status.paths.profileDir}`)
    console.log(`DSH 主目录：${context.dshHome}`)
    console.log(`启动健康：${status.boot.crashLoop ? `连续失败 ${status.boot.consecutiveFailures} 次（崩溃循环）` : status.boot.unfinishedStart ? '上一次启动未完成' : status.boot.lastCompletedAt ? `最近成功于 ${status.boot.lastCompletedAt}` : '无记录'}`)
    console.log(`回退点：${status.snapshotCount} 个${status.drift?.sinceNewestSnapshot ? '（当前配置与最新回退点不一致）' : ''}\n`)
    if (status.profile) {
      console.log('插件：')
      for (const plugin of status.profile.plugins) console.log(pluginLine(plugin))
    } else {
      console.log(`⚠ 无法读取 profile：${status.profileError?.message ?? '未知错误'}`)
    }
    if (status.corruptSnapshots.length > 0) {
      console.log(`\n⚠ ${status.corruptSnapshots.length} 个回退点已损坏，已跳过：`)
      for (const skip of status.corruptSnapshots) console.log(`  ${skip.file}: ${skip.error}`)
    }
    return
  }

  if (values.snapshot) {
    const result = await context.service.snapshot({ reason: 'manual', note: '由命令行记录' })
    console.log(`✓ 已记录回退点：${result.id}`)
    return
  }

  if (values.rescue) {
    const result = await context.service.rescue({ dryRun: values['dry-run'] })
    if (values.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (result.ok === false) {
      console.log(`· 无需救援或无法救援（${result.code}）：${result.error}`)
    } else if (result.dryRun) {
      console.log(`· 将会回退到 ${result.wouldRestore.id}（${result.wouldRestore.createdAt}，${result.wouldRestore.pluginCount} 个插件）`)
    } else {
      console.log(`✓ 已回退到 ${result.target.id}`)
      console.log(`  写入：${(result.result.restored ?? []).join(', ') || '（无）'}`)
      if ((result.result.removed ?? []).length > 0) console.log(`  移除：${result.result.removed.join(', ')}`)
      if (result.result.installRequired) {
        console.log('  ⚠ 依赖清单有变化，请运行 --install 同步 node_modules 后再启动 DSH。')
      } else {
        console.log('  现在可以重新启动 DSH。')
      }
    }
    if (result.ok === false) process.exitCode = 2
    return
  }

  if (values.install) {
    console.log('正在同步依赖（pnpm install）…')
    const result = await context.service.install({ timeoutMs: 600_000 })
    console.log(result.log)
    console.log(result.ok ? '✓ 依赖同步完成' : `✗ 依赖同步失败（退出码 ${result.code}${result.timedOut ? '，超时' : ''}）`)
    if (!result.ok) process.exitCode = 3
    return
  }

  // Default: serve the offline recovery page.
  const port = values.port === undefined ? 3939 : Number.parseInt(values.port, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail([`无效端口：${values.port}`])
  }
  const html = RECOVERY_HTML
  const server = await startRecoveryServer({
    serviceFor: context.serviceFor,
    listProfiles: context.listProfiles,
    html,
    host: values.host ?? '127.0.0.1',
    port,
    inDsh: false,
    log: (line) => console.log(`[guard] ${line}`),
  })

  const status = context.service.status()
  console.log('')
  console.log('  🛡️  DSH 版本守卫 · 离线恢复页')
  console.log(`  版本   ${readOwnVersion()}`)
  console.log(`  地址   ${server.url}`)
  console.log(`  profile ${status.paths.profileDir}`)
  console.log(`  插件   ${status.profile ? `${status.profile.stats.total} 个（${status.profile.stats.enabled} 启用 / ${status.profile.stats.disabled} 停用）` : '读取失败'}`)
  console.log(`  回退点 ${status.snapshotCount} 个`)
  if (status.boot.crashLoop) {
    console.log(`  ⛔ 检测到连续 ${status.boot.consecutiveFailures} 次启动失败 —— 建议直接点「一键救援」`)
  }
  if ((values.host ?? '127.0.0.1') !== '127.0.0.1') {
    console.log('  ⚠ 已监听非本机地址：任何能访问该端口的人都可以修改你的 DSH 配置。')
  }
  console.log('\n  按 Ctrl+C 关闭。\n')

  if (values['no-open'] !== true) openBrowser(server.url)

  const shutdown = async () => {
    console.log('\n正在关闭…')
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/** Re-read this file's header comment as the help text. */
async function readOwnDoc() {
  return readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(' *') || line.startsWith('/**'))
    .map((line) => line.replace(/^\/\*\*|^ \*\/?/, ''))
    .join('\n')
}

main().catch((error) => {
  console.error('\n✗ 版本守卫运行失败：')
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})

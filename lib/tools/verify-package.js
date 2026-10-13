/**
 * Plugin package contract checks.
 *
 * These mirror what DSH actually does when it loads a plugin, because the two
 * failure modes that matter are silent: a client bundle that is not a classic
 * script breaks the whole plugin page, and a missing exports entry is only
 * discovered at boot.
 *
 *   node lib/tools/verify-package.js
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ROUTE_PREFIX, createGuardHandler } from '../host/routes.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..', '..')

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

console.log('=== 1. package.json contract ===')
check('name is a valid package name', /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name), pkg.name)
check('type is module', pkg.type === 'module', pkg.type)
check('main is declared', typeof pkg.main === 'string' && pkg.main.length > 0)
check('main file exists', existsSync(join(PACKAGE_ROOT, pkg.main)), pkg.main)
check('declares dsh.bundle.patch', typeof pkg.dsh?.bundle?.patch === 'string', pkg.dsh)
check('bundle patch file exists', existsSync(join(PACKAGE_ROOT, pkg.dsh.bundle.patch)))
check('declares dsh.client.platform === "web"', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client)
check('exports ./client exists', typeof pkg.exports?.['./client'] === 'string')
check('client file exists', existsSync(join(PACKAGE_ROOT, pkg.exports['./client'])), pkg.exports?.['./client'])
check('client inject is a string array', Array.isArray(pkg.dsh?.client?.inject)
  && pkg.dsh.client.inject.every((entry) => typeof entry === 'string'), pkg.dsh?.client?.inject)
check('exposes ./cordis.patch.yml', typeof pkg.exports?.['./cordis.patch.yml'] === 'string', pkg.exports)
check('exposes ./package.json', pkg.exports?.['./package.json'] === './package.json')
check('bin entry exists', existsSync(join(PACKAGE_ROOT, pkg.bin['dsh-version-guard'])), Object.keys(pkg.bin ?? {}))
check('every exported path resolves', Object.values(pkg.exports).every((rel) => existsSync(join(PACKAGE_ROOT, rel))),
  Object.entries(pkg.exports).filter(([, rel]) => !existsSync(join(PACKAGE_ROOT, rel))))

console.log('\n=== 2. host plugin shape ===')
const hostModule = await import(new URL('../host/index.js', import.meta.url).href)
check('exports a name', typeof hostModule.name === 'string' && hostModule.name.length > 0, hostModule.name)
check('exports apply()', typeof hostModule.apply === 'function')
check('injects only real service keys', Array.isArray(hostModule.inject)
  && hostModule.inject.every((key) => typeof key === 'string'), hostModule.inject)

console.log('\n=== 3. client bundle is a CLASSIC script ===')
const clientPath = join(PACKAGE_ROOT, pkg.exports['./client'])
const clientSource = readFileSync(clientPath, 'utf8')
// Strip comments before scanning: this file's own doc comment quotes the loader
// call, and matching that instead of the real code would make the check lie.
const clientCode = clientSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const moduleSyntax = /^\s*(?:export\s|import\s|import\()/m.exec(clientCode)
check('no top-level import/export', moduleSyntax === null, moduleSyntax?.[0]?.trim())
check('registers through __ModuleLoader__.load', clientCode.includes('window.__ModuleLoader__.load('))
const idMatch = /__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/.exec(clientCode)
check('registration id equals the package name', idMatch?.[1] === pkg.name, { registered: idMatch?.[1], expected: pkg.name })
check('factory is a function of require', /factory:\s*function\s*\(\s*require\s*\)/.test(clientCode))

/** Only these may be required without a matching client graph row. */
const SEED_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
])
const required = [...clientCode.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
const undeclared = [...new Set(required)].filter((spec) => !SEED_MODULES.has(spec) && !(pkg.dsh.client.inject ?? []).includes(spec))
check('requires nothing outside the seed table', undeclared.length === 0, undeclared)
console.log(`        requires: ${[...new Set(required)].join(', ') || '(none)'}`)

console.log('\n=== 4. the client bundle parses as a classic script ===')
// DSH loads this with <script src>, so a parse failure blanks the whole plugin
// page. Compiling it with Function() applies exactly that check: no module
// syntax, no top-level await.
let parseError = null
try {
  // eslint-disable-next-line no-new-func -- deliberate syntax check
  new Function(clientSource)
} catch (error) {
  parseError = error instanceof Error ? error.message : String(error)
}
check('parses as a classic script', parseError === null, parseError)
check('has no top-level await', !/^\s*await\s/m.test(clientCode))
check('references no __VG_ placeholder', !clientSource.includes('__VG_'))

console.log('\n=== 5. every relative import in lib/ resolves ===')
const libFiles = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js')) libFiles.push(full)
  }
}
walk(join(PACKAGE_ROOT, 'lib'))
let unresolved = []
for (const file of libFiles) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/(?:from|import)\s+'(\.[^']+)'/g)) {
    const target = resolve(dirname(file), match[1])
    if (!existsSync(target)) unresolved.push(`${relative(PACKAGE_ROOT, file)} -> ${match[1]}`)
  }
}
check('all relative imports resolve', unresolved.length === 0, unresolved)
check('every lib file is non-trivial', libFiles.every((file) => statSync(file).size > 200),
  libFiles.filter((file) => statSync(file).size <= 200).map((file) => relative(PACKAGE_ROOT, file)))
console.log(`        ${libFiles.length} modules inspected`)

console.log('\n=== 6. cordis.patch.yml mounts exactly one row ===')
const patch = readFileSync(join(PACKAGE_ROOT, pkg.dsh.bundle.patch), 'utf8')
check('contains an insert list', /^\s*-\s*insert:/m.test(patch))
check('inserts the package by name', patch.includes(`name: ${pkg.name}`))
check('row id is present', /^\s*-\s*id:\s*version-guard/m.test(patch))
check('the patch is non-destructive (only insert/overrides)', !/^\s*-\s*delete:/m.test(patch), 'patch should never delete a DSH row')

console.log('\n=== 7. guard route mounting and prefix handling ===')
const handler = createGuardHandler({
  serviceFor: () => { throw Object.assign(new Error('no service in this test'), { code: 'profile/unknown' }) },
  listProfiles: () => [],
  base: '',
})
check('handler is callable', typeof handler === 'function')

// Drive the handlers through node:http, which is the only honest way to test the
// mount-prefix stripping and the real request/response lifecycle.
const { createServer } = await import('node:http')

// Standalone: the guard owns its port, so no prefix is stripped.
const server = createServer((request, response) => handler(request, response))
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`

/** @param {string} path */
async function get(path) {
  const response = await fetch(origin + path, { redirect: 'manual' })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: response.status, text, json }
}

const health = await get('/healthz')
check('healthz answers', health.json?.ok === true, health.json)
const bootstrap = await get('/api/bootstrap')
check('bootstrap answers with a token', typeof bootstrap.json?.value?.token === 'string', bootstrap.json)
const unknownProfile = await get('/api/status?profile=../../etc')
check('unsafe profile name is refused, not joined', unknownProfile.json?.ok === false
  && unknownProfile.json.error.code === 'profile/unknown', unknownProfile.json)
const rootPage = await get('/')
check('standalone page is served with no API prefix', rootPage.text.includes('var API_BASE = ""'), rootPage.text.slice(0, 160))

// Mounted the way DSH does it: `webServer.register({ kind:'prefix', path: ROUTE_PREFIX })`
// hands over the untrimmed URL, so the handler is given the prefix as its base
// and must strip it itself.
const prefixed = createGuardHandler({
  serviceFor: () => null,
  listProfiles: () => [],
  base: ROUTE_PREFIX,
  html: '<!doctype html><script>var API_BASE = "__VG_BASE__"; var T = "__VG_TOKEN__";</script>',
})
const prefixServer = createServer((request, response) => prefixed(request, response))
await new Promise((done) => prefixServer.listen(0, '127.0.0.1', done))
const prefixOrigin = `http://127.0.0.1:${prefixServer.address().port}`

const mountedPage = await fetch(`${prefixOrigin}${ROUTE_PREFIX}/`).then((r) => r.text())
check('page served at the mount root', mountedPage.startsWith('<!doctype html>'))
check('API base injected', mountedPage.includes(`var API_BASE = "${ROUTE_PREFIX}"`), mountedPage.slice(0, 160))
check('token injected', !mountedPage.includes('__VG_TOKEN__'))
const noSlash = await fetch(`${prefixOrigin}${ROUTE_PREFIX}`).then((r) => r.text())
check('mount root without a trailing slash also serves the page', noSlash.startsWith('<!doctype html>'))
const prefixedHealth = await fetch(`${prefixOrigin}${ROUTE_PREFIX}/healthz`).then((r) => r.json())
check('API reachable through the prefix', prefixedHealth.ok === true, prefixedHealth)
const outside = await fetch(`${prefixOrigin}/api/status`).then((r) => r.status)
check('paths outside the mount are refused', outside === 404, outside)

await new Promise((done) => server.close(done))
await new Promise((done) => prefixServer.close(done))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1

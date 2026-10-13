/**
 * Cordis YAML reading.
 *
 * `cordis.yml` / `cordis.patch.yml` use a custom `!!js` tag whose payload is
 * either a plain scalar (`!!js process.platform === 'win32'`) or a quoted one
 * (`!!js '!ctx.get(''profileContext'')'`). Stock js-yaml refuses the tag, so we
 * strip the tag while keeping the payload, then parse normally. The payload
 * text is retained verbatim alongside the parsed value so the UI can always
 * show the user what the file actually says.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Remove the `!!js` tag in all three YAML spellings while preserving the
 * payload. Single-quoted payloads keep YAML's `''` escape intact.
 * @param {string} raw
 */
export function stripJsTags(raw) {
  return raw
    .replace(/!!js[ \t]+'((?:[^']|'')*)'/g, (_match, body) => `'${body}'`)
    .replace(/!!js[ \t]+"((?:[^"\\]|\\.)*)"/g, (_match, body) => `"${body.replace(/"/g, '\\"')}"`)
    .replace(/!!js[ \t]+/g, '')
}

/**
 * Extract every `!!js` payload in file order. Used as a fallback diagnostic
 * and to correlate parsed values with their source expressions.
 * @param {string} raw
 * @returns {string[]}
 */
export function extractJsExpressions(raw) {
  const found = []
  const re = /!!js[ \t]+(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|([^\n]*))/g
  let match
  while ((match = re.exec(raw)) !== null) {
    const raw1 = match[1] ?? match[2] ?? match[3] ?? ''
    found.push((match[1] !== undefined ? raw1.replace(/''/g, "'") : raw1).trim())
  }
  return found
}

/** Candidate `js-yaml` entry points, in resolution order. */
function yamlCandidates(hints = []) {
  const candidates = []
  for (const hint of hints) {
    if (typeof hint === 'string' && hint.length > 0) candidates.push(hint)
  }
  return candidates
}

let cachedYaml
let cachedYamlKey

/**
 * Load `js-yaml` from the first location that resolves. The plugin ships no
 * dependencies, so we borrow the host's copy — and the recovery page runs
 * outside DSH, so the DSH installation root is a legitimate second source.
 * @param {string[]} hints Absolute file or directory paths to resolve from.
 * @returns {typeof import('js-yaml') | null}
 */
export function loadYamlModule(hints = []) {
  const key = hints.join('|')
  if (cachedYamlKey === key) return cachedYaml
  const tried = []
  for (const hint of yamlCandidates(hints)) {
    tried.push(hint)
    try {
      // A file path resolves relative to its own directory; a directory path
      // needs a trailing separator for createRequire to treat it as a root.
      const base = /\.[cm]?js$/.test(hint) ? hint : join(hint, 'noop.js')
      const require = createRequire(base)
      const mod = require('js-yaml')
      cachedYaml = mod
      cachedYamlKey = key
      return mod
    } catch { /* try the next hint */ }
  }
  // Bare specifier as the last resort (works when js-yaml is a dependency).
  try {
    const require = createRequire(join(process.cwd(), 'noop.js'))
    const mod = require('js-yaml')
    cachedYaml = mod
    cachedYamlKey = key
    return mod
  } catch {
    cachedYaml = null
    cachedYamlKey = key
    return null
  }
}

/**
 * Parse a Cordis YAML document into an array of entries.
 * @param {string} raw
 * @param {{ yamlHints?: string[] }} [options]
 * @returns {{ ok: true, entries: Record<string, unknown>[] } | { ok: false, error: string }}
 */
export function parseCordisYaml(raw, options = {}) {
  const yaml = loadYamlModule(options.yamlHints)
  if (yaml === null) return { ok: false, error: 'js-yaml is unavailable (no resolvable copy)' }
  let doc
  try {
    doc = yaml.load(stripJsTags(raw))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (doc === null || doc === undefined) return { ok: true, entries: [] }
  if (!Array.isArray(doc)) return { ok: false, error: 'top level is not a YAML array' }
  return { ok: true, entries: doc.filter((entry) => entry !== null && typeof entry === 'object') }
}

/**
 * Evaluate a Cordis `!!js` expression conservatively.
 *
 * These expressions decide whether a plugin row loads, so the settings page
 * must not guess. The expression is compiled in a `Function` scope with no
 * module access; only the globals Cordis itself provides are injected. A
 * throwing or resource-hungry expression yields `{ known: false }` rather than
 * a fabricated boolean.
 *
 * @param {string} expression
 * @param {{ ctx?: unknown, extra?: Record<string, unknown>, timeoutMs?: number }} [options]
 * @returns {{ known: true, value: unknown } | { known: false, reason: string }}
 */
export function evaluateJsExpression(expression, options = {}) {
  const expr = expression.trim()
  if (expr.length === 0) return { known: false, reason: 'empty expression' }
  if (expr.length > 2000) return { known: false, reason: 'expression too long' }
  // `ctx` is the Cordis context: `ctx.get('name')` is the only member the
  // profile YAMLs use, and answering `undefined` is safe for unknown names.
  const ctxProxy = new Proxy({}, {
    get: () => undefined,
    has: () => true,
  })
  const scope = {
    ctx: options.ctx ?? ctxProxy,
    dshHomePath: (...parts) => join(...parts.map(String)),
    baseUrl: '',
    require: undefined,
    process,
    console: { log() {}, warn() {}, error() {} },
    ...options.extra,
  }
  let fn
  try {
    // eslint-disable-next-line no-new-func -- deliberate sandboxed evaluation
    fn = new Function(...Object.keys(scope), `"use strict"; return (${expr});`)
  } catch (error) {
    return { known: false, reason: `compile failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const started = Date.now()
  try {
    const value = fn(...Object.values(scope))
    if (Date.now() - started > (options.timeoutMs ?? 250)) {
      return { known: false, reason: 'expression exceeded the time budget' }
    }
    return { known: true, value }
  } catch (error) {
    return { known: false, reason: `evaluation threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Describe the `disabled` field of one Cordis entry.
 * @param {Record<string, unknown>} entry
 * @param {{ yamlHints?: string[] }} [options]
 * @returns {{ state: 'enabled' | 'disabled' | 'unknown', expression?: string, reason?: string }}
 */
export function describeDisabled(entry, options = {}) {
  if (!('disabled' in entry) || entry.disabled === undefined || entry.disabled === null) {
    return { state: 'enabled' }
  }
  if (typeof entry.disabled === 'boolean') {
    return { state: entry.disabled ? 'disabled' : 'enabled' }
  }
  if (typeof entry.disabled === 'string') {
    const verdict = evaluateJsExpression(entry.disabled, options)
    if (!verdict.known) return { state: 'unknown', expression: entry.disabled, reason: verdict.reason }
    return { state: verdict.value ? 'disabled' : 'enabled', expression: entry.disabled }
  }
  return { state: 'unknown', expression: String(entry.disabled), reason: 'unsupported disabled value' }
}

/**
 * List the plugin rows a loader patch inserts.
 * @param {Record<string, unknown>} entry
 * @returns {string[]} row ids
 */
export function insertedRowIds(entry) {
  const insert = entry.insert
  if (!Array.isArray(insert)) return []
  return insert
    .filter((row) => row !== null && typeof row === 'object')
    .map((row) => String(row.id ?? row.name ?? ''))
    .filter((id) => id.length > 0)
}

/**
 * Directory of a resolved module path, for building a `createRequire` base.
 * @param {string} modulePath
 */
export function dirOf(modulePath) {
  return dirname(modulePath)
}

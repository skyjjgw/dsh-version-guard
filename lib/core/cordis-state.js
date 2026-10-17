/**
 * Cordis enablement state shared with DSH's official plugin manager.
 *
 * DSH persists next-start enablement in the profile's `cordis.patch.yml` as
 * id-targeted rows.  This module deliberately edits only the matching row (or
 * appends a small override) so comments, `!!js` expressions and unrelated
 * settings remain byte-for-byte untouched.  The recovery tool therefore does
 * not need to ship a YAML dependency just to switch a plugin off.
 */

import { join } from 'node:path'
import { readJsonOrNull, readTextOrNull, writeFileAtomic } from './fsx.js'

/** Parse the scalar shapes used for Cordis ids and package names. */
function parseScalar(raw) {
  const value = raw.trim().replace(/\s+#.*$/, '').trim()
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) } catch { return value.slice(1, -1) }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** Emit a YAML string scalar without relying on a serializer. */
function yamlScalar(value) {
  return JSON.stringify(String(value))
}

/** Leading-space count; tabs are rejected by YAML and treated as content. */
function indentOf(line) {
  return /^ */.exec(line)?.[0].length ?? 0
}

/**
 * Read insert rows from one package's bundle patch.
 *
 * Only direct children of a top-level `insert:` list count. Nested `id` keys
 * inside plugin config are intentionally ignored.
 * @param {string} text
 * @returns {{ id: string, name: string, baseEnabled: boolean }[]}
 */
export function scanBundleRows(text) {
  const lines = text.split(/\r?\n/)
  const rows = []
  let insertIndent = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const insert = /^( *)-\s+insert:\s*(?:#.*)?$/.exec(line)
    if (insert !== null) {
      insertIndent = insert[1].length
      continue
    }
    if (insertIndent === null || line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = indentOf(line)
    if (indent <= insertIndent) {
      insertIndent = null
      index -= 1
      continue
    }
    const idMatch = /^( *)-\s+id:\s*(.*?)\s*$/.exec(line)
    if (idMatch === null || idMatch[1].length <= insertIndent) continue
    const rowIndent = idMatch[1].length
    const id = parseScalar(idMatch[2])
    let name = ''
    let disabled = false
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor]
      if (next.trim() === '' || next.trimStart().startsWith('#')) continue
      if (indentOf(next) <= rowIndent) break
      const nameMatch = new RegExp(`^ {${rowIndent + 2}}name:\\s*(.*?)\\s*$`).exec(next)
      if (nameMatch !== null) name = parseScalar(nameMatch[1])
      const disabledMatch = new RegExp(`^ {${rowIndent + 2}}disabled:\\s*(true|false)\\s*(?:#.*)?$`, 'i').exec(next)
      if (disabledMatch !== null) disabled = disabledMatch[1].toLowerCase() === 'true'
    }
    if (id !== '') rows.push({ id, name: name || id, baseEnabled: !disabled })
  }
  // Bundle patches may insert a row first and then change its default with a
  // later top-level `{ id, disabled }` row. Apply those later-wins semantics.
  for (let index = 0; index < lines.length; index += 1) {
    const idMatch = /^-\s+id:\s*(.*?)\s*$/.exec(lines[index])
    if (idMatch === null) continue
    const id = parseScalar(idMatch[1])
    const row = rows.find((candidate) => candidate.id === id)
    if (row === undefined) continue
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor]
      if (next.trim() === '' || next.trimStart().startsWith('#')) continue
      if (indentOf(next) === 0) break
      const disabledMatch = /^  disabled:\s*(true|false)\s*(?:#.*)?$/i.exec(next)
      if (disabledMatch !== null) row.baseEnabled = disabledMatch[1].toLowerCase() !== 'true'
    }
  }
  return rows
}

/**
 * Cordis rows claimed by an installed package. Plain plugins fall back to a
 * package-name row, matching the official manager.
 * @param {string} profileDir
 * @param {string} packageName
 */
export function packageCordisRows(profileDir, packageName) {
  const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
  const manifest = readJsonOrNull(join(packageDir, 'package.json'), 'installed/package-invalid')
  if (manifest !== null && typeof manifest === 'object') {
    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch === 'string' && patch.length > 0) {
      const text = readTextOrNull(join(packageDir, patch))
      if (text !== null) {
        const rows = scanBundleRows(text)
        if (rows.length > 0) return rows
      }
    }
  }
  return [{ id: packageName, name: packageName, baseEnabled: true }]
}

/** Locate every matching id row and prefer an official insert-format row. */
function findRow(text, id) {
  const lines = text.split(/\r?\n/)
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^( *)-\s+id:\s*(.*?)\s*$/.exec(lines[index])
    if (match === null || parseScalar(match[2]) !== id) continue
    const rowIndent = match[1].length
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue
      if (indentOf(line) <= rowIndent) {
        end = cursor
        break
      }
    }
    found.push({ start: index, end, indent: rowIndent, nested: rowIndent > 0 })
  }
  return found.find((row) => row.nested) ?? found.find((row) => !row.nested) ?? null
}

/** Set one existing row's direct `disabled` property. */
function updateExistingRow(text, row, disabled) {
  const lines = text.split(/\r?\n/)
  const propertyIndent = row.indent + 2
  const disabledPattern = new RegExp(`^ {${propertyIndent}}disabled:\\s*(?:true|false)`, 'i')
  for (let index = row.start + 1; index < row.end; index += 1) {
    if (!disabledPattern.test(lines[index])) continue
    const suffix = lines[index].includes('#') ? ` ${lines[index].slice(lines[index].indexOf('#'))}` : ''
    lines[index] = `${' '.repeat(propertyIndent)}disabled: ${disabled}${suffix}`
    return lines.join('\n')
  }
  lines.splice(row.start + 1, 0, `${' '.repeat(propertyIndent)}disabled: ${disabled}`)
  return lines.join('\n')
}

/** Append the same bare override shape written by the official manager. */
function appendOverride(text, row, disabled) {
  let base = text
  if (base.trim() === '[]') base = ''
  if (base.length > 0 && !base.endsWith('\n')) base += '\n'
  return `${base}- id: ${yamlScalar(row.id)}\n  name: ${yamlScalar(row.name)}\n  disabled: ${disabled}\n`
}

/**
 * Persist plugin enablement in `cordis.patch.yml` without changing package.json.
 * @param {string} profileDir
 * @param {string} packageName
 * @param {boolean} enabled
 */
export function setPackageEnabled(profileDir, packageName, enabled) {
  const path = join(profileDir, 'cordis.patch.yml')
  const rows = packageCordisRows(profileDir, packageName)
  let text = readTextOrNull(path) ?? '[]\n'
  const before = text
  for (const row of rows) {
    const existing = findRow(text, row.id)
    text = existing === null
      ? appendOverride(text, row, !enabled)
      : updateExistingRow(text, existing, !enabled)
  }
  if (text !== before) writeFileAtomic(path, text)
  return {
    changed: text !== before,
    result: {
      name: packageName,
      enabled,
      cordisRows: rows.map((row) => row.id),
      patchPath: path,
    },
  }
}


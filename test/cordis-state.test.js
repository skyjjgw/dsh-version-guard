import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { disablePackage, enablePackage } from '../lib/core/compose.js'
import { scanBundleRows } from '../lib/core/cordis-state.js'

const bundlePatch = `- insert:
    - id: sample-row
      name: sample-plugin
      config:
        nested:
          id: not-a-row
`

const disabledByDefaultPatch = `${bundlePatch}- id: sample-row
  disabled: true
`

test('bundle row scan ignores nested config ids', () => {
  assert.deepEqual(scanBundleRows(bundlePatch), [
    { id: 'sample-row', name: 'sample-plugin', baseEnabled: true },
  ])
})

test('bundle row scan applies later disabled defaults', () => {
  assert.deepEqual(scanBundleRows(disabledByDefaultPatch), [
    { id: 'sample-row', name: 'sample-plugin', baseEnabled: false },
  ])
})

test('disable and enable share cordis.patch.yml with the official manager', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'version-guard-cordis-'))
  try {
    const manifest = {
      dependencies: { 'sample-plugin': '^1.2.3' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'sample-plugin'] } },
    }
    writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const installed = join(profile, 'node_modules', 'sample-plugin')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({
      name: 'sample-plugin', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(installed, 'cordis.patch.yml'), bundlePatch)
    const originalPatch = `# user comment stays
- id: unrelated
  disabled: !!js process.platform === 'linux'
`
    writeFileSync(join(profile, 'cordis.patch.yml'), originalPatch)

    const packageBefore = readFileSync(join(profile, 'package.json'), 'utf8')
    const disabled = disablePackage(profile, 'sample-plugin')
    assert.equal(disabled.changed, true)
    assert.deepEqual(disabled.result.cordisRows, ['sample-row'])
    assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), packageBefore)
    const afterDisable = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
    assert.ok(afterDisable.startsWith(originalPatch))
    assert.match(afterDisable, /- id: "sample-row"\n  name: "sample-plugin"\n  disabled: true/)

    const enabled = enablePackage(profile, 'sample-plugin', '^1.2.3')
    assert.equal(enabled.changed, true)
    assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), packageBefore)
    const afterEnable = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(afterEnable, /- id: "sample-row"\n  name: "sample-plugin"\n  disabled: false/)
    assert.match(afterEnable, /disabled: !!js process\.platform === 'linux'/)
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})


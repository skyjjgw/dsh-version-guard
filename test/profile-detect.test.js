import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { detectActiveProfile, profileFromArgv } from '../lib/recovery/detect.js'

test('profileFromArgv accepts both launcher forms', () => {
  assert.equal(profileFromArgv(['node', 'dsh', '--profile', 'web-enhanced']), 'web-enhanced')
  assert.equal(profileFromArgv(['node', 'dsh', '--profile=desktop']), 'desktop')
})

test('argv profile wins over stale DSH_PROFILE', async () => {
  const home = await mkdtemp(join(tmpdir(), 'version-guard-profile-'))
  try {
    for (const name of ['desktop', 'web-enhanced']) {
      const dir = join(home, 'profiles', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), '{}\n')
    }
    const selected = detectActiveProfile({
      dshHome: home,
      env: { DSH_PROFILE: 'desktop' },
      argv: ['node', 'dsh', '--profile', 'web-enhanced'],
    })
    assert.equal(selected.name, 'web-enhanced')
    assert.equal(selected.source, 'argv')
    assert.equal(selected.confident, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})


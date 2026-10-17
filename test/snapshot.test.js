import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { createSnapshot, restoreSnapshot } from '../lib/core/snapshot.js'

test('snapshots exclude market-owned and legacy private state', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'version-guard-snapshot-'))
  try {
    mkdirSync(join(profile, '.dsh-market'), { recursive: true })
    mkdirSync(join(profile, '.dsh-version-guard'), { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{"dependencies":{}}\n')
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeFileSync(join(profile, '.dsh-market', 'state.json'), '{"owner":"market","value":1}\n')
    writeFileSync(join(profile, '.dsh-version-guard', 'cordis.disabled.json'), '{"disabled":["old"]}\n')

    const snapshot = createSnapshot({ profileDir: profile, reason: 'manual' })
    assert.equal(snapshot.ok, true)
    assert.deepEqual(snapshot.snapshot.files.map((file) => file.path), [
      'package.json', 'cordis.patch.yml', 'pnpm-lock.yaml',
    ])

    writeFileSync(join(profile, 'package.json'), '{"dependencies":{"changed":"1.0.0"}}\n')
    writeFileSync(join(profile, '.dsh-market', 'state.json'), '{"owner":"market","value":2}\n')
    const restored = await restoreSnapshot({
      profileDir: profile,
      snapshotsDir: join(profile, '.dsh-version-guard', 'snapshots'),
      id: snapshot.id,
      beforeRestore: false,
    })
    assert.equal(restored.ok, true)
    assert.equal(readFileSync(join(profile, '.dsh-market', 'state.json'), 'utf8'), '{"owner":"market","value":2}\n')
    assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), '{"dependencies":{}}\n')
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})


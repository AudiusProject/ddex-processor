import { beforeAll, expect, test } from 'vitest'

import { releaseRepo } from './db'
import { pgMigrate } from './db/migrations'
import { sql } from './db/sql'
import type { DDEXRelease } from './parseDelivery'

beforeAll(async () => {
  await pgMigrate()
})

test('unpublished media pruning uses latest message timestamp', async () => {
  const recentMessageKey = '999000000001'
  const staleMessageKey = '999000000002'
  const keys = [recentMessageKey, staleMessageKey]

  await sql`delete from assets where "releaseId" = any(${keys})`
  await sql`delete from releases where "key" = any(${keys})`

  await releaseRepo.upsert(
    'purgeTest',
    'fixtures/recent_message.xml',
    '2026-06-25T14:10:42-07:00',
    makeRelease(recentMessageKey, 'Old Release Date, Recent Message')
  )
  await releaseRepo.upsert(
    'purgeTest',
    'fixtures/stale_message.xml',
    '2025-01-01T00:00:00Z',
    makeRelease(staleMessageKey, 'Stale Message')
  )

  await sql`
    update releases
    set "createdAt" = '2024-01-01T00:00:00Z'
    where "key" = ${recentMessageKey}
  `
  await sql`
    update releases
    set "createdAt" = '2026-06-25T00:00:00Z'
    where "key" = ${staleMessageKey}
  `

  const rows = await releaseRepo.findStaleUnpublishedWithMedia(
    new Date('2026-01-01T00:00:00Z')
  )
  const staleKeys = rows.map((row) => row.key)

  expect(staleKeys).not.toContain(recentMessageKey)
  expect(staleKeys).toContain(staleMessageKey)
})

function makeRelease(key: string, title: string): DDEXRelease {
  return {
    ref: 'R1',
    title,
    genre: 'Electronic',
    subGenre: 'Dance',
    releaseDate: '2020-01-01',
    releaseType: 'Single',
    releaseIds: {
      icpn: key,
    },
    isMainRelease: true,
    problems: [],
    soundRecordings: [],
    images: [],
    deals: [],
    artists: [{ name: 'Prune Test Artist', role: 'MainArtist' }],
    contributors: [],
    indirectContributors: [],
    labelName: 'Prune Test Label',
  }
}

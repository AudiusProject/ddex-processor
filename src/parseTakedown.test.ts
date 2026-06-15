import { beforeAll, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'

import { ReleaseProcessingStatus, releaseRepo, userRepo } from './db'
import { pgMigrate } from './db/migrations'
import {
  parseDdexXml,
  parseDdexXmlFile,
  type DDEXRelease,
} from './parseDelivery'
import { sources } from './sources'

beforeAll(async () => {
  // some test db stuff
  await pgMigrate()
  sources.load('./fixtures/sources.test.json')
})

test('crud', async () => {
  const grid = 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0'
  const source = 'crudTest'

  // create user for artist matching
  await userRepo.upsert({
    apiKey: 'crudTestKey',
    id: 'djtheo',
    handle: 'djtheo',
    name: 'DJ Theo',
    createdAt: new Date(),
  })

  const u = await userRepo.findById('djtheo')
  expect(u).toMatchObject({
    id: 'djtheo',
    name: 'DJ Theo',
  })

  // load 01
  {
    await parseDdexXmlFile(source, 'fixtures/01_delivery.xml')
    const rr = (await releaseRepo.get(grid))!
    expect(rr.labelName).toBe('Iron Crown Music')
    expect(rr.soundRecordings[0].title).toBe('Example Song')
    expect(rr.soundRecordings[0].labelName).toBe('Label Name, Inc.')
    expect(rr.soundRecordings[0].duration).toBe(225)
    expect(rr.status).toBe(ReleaseProcessingStatus.PublishPending)
    expect(rr.source).toBe('crudTest')
  }

  // simulate publish
  await releaseRepo.update({
    key: grid,
    status: ReleaseProcessingStatus.Published,
  })

  // TODO: update-support
  // load 02 update
  await parseDdexXmlFile(source, 'fixtures/02_update.xml')
  const rr = (await releaseRepo.get(grid))!
  expect(rr.soundRecordings[0].title).toBe('Updated Example Song')
  expect(rr.status).toBe(ReleaseProcessingStatus.PublishPending)

  // simulate publish
  await releaseRepo.update({
    key: grid,
    status: ReleaseProcessingStatus.Published,
  })

  // reprocess older 01 .. should be a noop
  {
    await parseDdexXmlFile(source, 'fixtures/01_delivery.xml')
    const rr = (await releaseRepo.get(grid))!
    expect(rr.soundRecordings[0].title).toBe('Updated Example Song')
    expect(rr.status).toBe(ReleaseProcessingStatus.Published)
  }

  // load 03 delete
  {
    await parseDdexXmlFile(source, 'fixtures/03_delete.xml')
    const rr = (await releaseRepo.get(grid))!
    expect(rr.status).toBe(ReleaseProcessingStatus.DeletePending)
  }

  // simulate delete
  await releaseRepo.update({
    key: grid,
    status: ReleaseProcessingStatus.Deleted,
  })

  {
    const rr = (await releaseRepo.get(grid))!
    expect(rr.status).toBe(ReleaseProcessingStatus.Deleted)
  }

  // re-load 03 delete — stale purge (same messageTimestamp as prior) must
  // be ignored, otherwise a rescanAll-style replay would undo a later
  // re-delivery and re-purge a freshly published release.
  {
    await parseDdexXmlFile(source, 'fixtures/03_delete.xml')
    const rr = (await releaseRepo.get(grid))!
    expect(rr.status).toBe(ReleaseProcessingStatus.Deleted)
  }

  // A same-timestamp purge should still delete a published row. The same
  // timestamp only means stale when the release was already deleted.
  await releaseRepo.update({
    key: grid,
    status: ReleaseProcessingStatus.Published,
    entityType: 'track',
    entityId: 't-same-timestamp',
    messageTimestamp: '2024-04-02T07:00:00Z',
  })

  {
    await parseDdexXmlFile(source, 'fixtures/03_delete.xml')
    const rr = (await releaseRepo.get(grid))!
    expect(rr.status).toBe(ReleaseProcessingStatus.DeletePending)
  }

  // ----------------
  // no deal as takedown:
  // track is in a published state
  await releaseRepo.update({
    key: grid,
    status: ReleaseProcessingStatus.Published,
    entityType: 'track',
    entityId: 't1',
  })

  // update arrives without a deal
  {
    await parseDdexXmlFile(source, 'fixtures/04_no_deal.xml')
    const rr = (await releaseRepo.get(grid))!
    expect(rr.soundRecordings[0].title).toBe('Updated Example Song')
    expect(rr.status).toBe(ReleaseProcessingStatus.DeletePending)
  }

  // ----------------
  // re-delivery after a completed takedown:
  // a NewReleaseMessage for a Deleted release must reset for re-publish,
  // not get treated as a takedown again. Roll messageTimestamp back so
  // 01_delivery's timestamp is treated as "newer".
  await releaseRepo.update({
    key: grid,
    status: ReleaseProcessingStatus.Deleted,
    entityType: 'track',
    entityId: 't1',
    publishedAt: new Date().toISOString(),
    messageTimestamp: '2020-01-01T00:00:00Z',
  })

  {
    await parseDdexXmlFile(source, 'fixtures/01_delivery.xml')
    const rr = (await releaseRepo.get(grid))!
    // status should advance to PublishPending, not bounce back to DeletePending
    expect(rr.status).toBe(ReleaseProcessingStatus.PublishPending)
    // stale entity pointers must be cleared so the worker takes the create path
    expect(rr.entityId).toBeFalsy()
    expect(rr.entityType).toBeFalsy()
    expect(rr.publishedAt).toBeFalsy()
  }

  // ----------------
  // stale-purge replay after a re-delivery:
  // an S3 rescan re-parses the old PurgeReleaseMessage (older
  // messageTimestamp than the row's current one). It must not flip status
  // back to DeletePending — that would re-delete the freshly published
  // entity.
  await releaseRepo.update({
    key: grid,
    status: ReleaseProcessingStatus.Published,
    entityType: 'track',
    entityId: 't2',
    publishedAt: new Date().toISOString(),
    messageTimestamp: '2099-01-01T00:00:00Z',
  })

  {
    await parseDdexXmlFile(source, 'fixtures/03_delete.xml')
    const rr = (await releaseRepo.get(grid))!
    expect(rr.status).toBe(ReleaseProcessingStatus.Published)
    expect(rr.entityId).toBe('t2')
  }
})

test('redelivery after takedown with a new artist clears stale Audius user', async () => {
  const source = 'crudTest'
  const grid = 'REDLVRYARTISTCHANGE0000000000000000000000001'
  const oldArtist = 'Dima E Alyousef'
  const newArtist = 'SAYee Oasis'

  await userRepo.upsert({
    apiKey: 'crudTestKey',
    id: 'dima-user',
    handle: 'dimaealyousef',
    name: oldArtist,
    createdAt: new Date(),
  })

  const baseXml = await readFile('fixtures/01_delivery.xml', 'utf8')
  const oldDeliveryXml = baseXml
    .replaceAll('A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0', grid)
    .replaceAll('DJ Theo', oldArtist)
    .replaceAll('Robert Louis', oldArtist)
    .replace('2024-04-01T05:00:00Z', '2026-06-09T23:00:00Z')

  await parseDdexXml(
    source,
    'fixtures/redelivery_old_artist.xml',
    oldDeliveryXml
  )
  let rr = (await releaseRepo.get(grid))!
  expect(rr.audiusUser).toBe('dima-user')

  await releaseRepo.update({
    key: grid,
    status: ReleaseProcessingStatus.Deleted,
    entityType: 'track',
    entityId: 'old-track-id',
    audiusUser: 'dima-user',
    audiusHandle: 'dimaealyousef',
    publishedAt: new Date().toISOString(),
    messageTimestamp: '2026-06-10T00:00:00Z',
  })

  const redeliveryXml = baseXml
    .replaceAll('A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0', grid)
    .replaceAll('DJ Theo', newArtist)
    .replaceAll('Robert Louis', oldArtist)
    .replace('2024-04-01T05:00:00Z', '2026-06-10T01:00:00Z')

  await parseDdexXml(
    source,
    'fixtures/redelivery_new_artist.xml',
    redeliveryXml
  )
  rr = (await releaseRepo.get(grid))!
  expect(rr.status).toBe(ReleaseProcessingStatus.PublishPending)
  expect(rr.artists[0].name).toBe(newArtist)
  expect(rr.soundRecordings[0].rightsController?.name).toBe(oldArtist)
  expect(rr.audiusUser).toBeFalsy()
  expect(rr.audiusHandle).toBeFalsy()
  expect(rr.entityId).toBeFalsy()
})

test('purge can match a release by a non-key release id', async () => {
  const source = 'crudTest'
  const upc = '000000000123'
  const grid = 'GRIDALT0000000000000000000000000000000000'

  const release: DDEXRelease = {
    ref: 'R1',
    title: 'Alternate ID Album',
    genre: 'Folk',
    subGenre: 'Indie Folk',
    releaseDate: '2024-01-01',
    releaseType: 'Album',
    releaseIds: {
      icpn: upc,
      grid,
    },
    isMainRelease: true,
    problems: [],
    soundRecordings: [],
    images: [],
    deals: [],
    artists: [{ name: 'DJ Theo', role: 'MainArtist' }],
    contributors: [],
    indirectContributors: [],
    labelName: 'Iron Crown Music',
  }

  await releaseRepo.upsert(
    source,
    'fixtures/alternate_id_delivery.xml',
    '2024-01-01T00:00:00Z',
    release
  )
  await releaseRepo.update({
    key: upc,
    status: ReleaseProcessingStatus.Published,
    entityType: 'album',
    entityId: 'album-alt-id',
  })

  await releaseRepo.markForDelete(
    source,
    'fixtures/alternate_id_purge.xml',
    '2024-01-02T00:00:00Z',
    { grid }
  )

  const rr = (await releaseRepo.get(upc))!
  expect(rr.status).toBe(ReleaseProcessingStatus.DeletePending)
  expect(rr.xmlUrl).toBe('fixtures/alternate_id_purge.xml')
})

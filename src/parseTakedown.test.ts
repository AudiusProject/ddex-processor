import { beforeAll, expect, test } from 'vitest'

import { ReleaseProcessingStatus, releaseRepo, userRepo } from './db'
import { pgMigrate } from './db/migrations'
import { parseDdexXmlFile } from './parseDelivery'
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

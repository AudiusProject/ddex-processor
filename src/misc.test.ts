import { expect, test } from 'vitest'
import { s3markerRepo } from './db'

test('parse duration', async () => {
  await s3markerRepo.upsert('a', 'b')
  expect(await s3markerRepo.get('a')).toBe('b')
  await s3markerRepo.upsert('a', 'c')
  expect(await s3markerRepo.get('a')).toBe('c')
})

import { expect, test } from 'vitest'

import { decodeDdexUriPath, resolveS3AssetLocation } from './s3poller'

test('decodeDdexUriPath decodes valid UTF-8 escapes and preserves raw percent characters', () => {
  expect(decodeDdexUriPath('audio/Caf%C3%A9%20No.%201.flac')).toBe(
    'audio/Café No. 1.flac'
  )
  expect(decodeDdexUriPath('audio/100% Real.flac')).toBe('audio/100% Real.flac')
})

test('resolveS3AssetLocation preserves Unicode and reserved filename characters', () => {
  expect(
    resolveS3AssetLocation(
      's3://ddex-bucket/releases/20260601/message.xml',
      'audio/Caf%C3%A9 #1?.flac'
    )
  ).toEqual({
    bucket: 'ddex-bucket',
    key: 'releases/20260601/audio/Café #1?.flac',
  })
})

test('resolveS3AssetLocation handles raw Unicode asset paths', () => {
  expect(
    resolveS3AssetLocation(
      's3://ddex-bucket/releases/20260601/message.xml',
      '画像/青いカバー.jpg'
    )
  ).toEqual({
    bucket: 'ddex-bucket',
    key: 'releases/20260601/画像/青いカバー.jpg',
  })
})

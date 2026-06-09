import { afterEach, expect, test, vi } from 'vitest'

const { assetRepo, getSdk, readAssetWithCaching, releaseRepo } = vi.hoisted(
  () => ({
    assetRepo: {
      get: vi.fn(),
    },
    getSdk: vi.fn(),
    readAssetWithCaching: vi.fn(),
    releaseRepo: {
      update: vi.fn(),
    },
  })
)

vi.mock('./db', () => ({
  assetRepo,
  releaseRepo,
  userRepo: {},
  ReleaseProcessingStatus: {
    Blocked: 'Blocked',
    PublishPending: 'PublishPending',
    Published: 'Published',
    Failed: 'Failed',
    DeletePending: 'DeletePending',
    Deleted: 'Deleted',
  },
}))

vi.mock('./s3poller', () => ({
  readAssetWithCaching,
}))

vi.mock('./sdk', () => ({
  getSdk,
}))

import {
  deleteAlbumTracks,
  fetchAlbumTrackIds,
  updateAlbum,
  updateTrack,
} from './publishRelease'
import { type SourceConfig } from './sources'

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const source = {
  name: 'source-1',
  ddexKey: '0x0000000000000000000000000000000000000001',
} as SourceConfig

const releaseRow = {
  key: 'release-1',
  entityId: 'entity-1',
  audiusUser: 'user-1',
  prependArtist: false,
  useDefaultDeal: false,
} as any

function mockCoverAsset() {
  const imageFile = Buffer.from('cover')
  assetRepo.get.mockResolvedValue({
    xmlUrl: 's3://bucket/release.xml',
    filePath: 'images/',
    fileName: 'cover.jpg',
  })
  readAssetWithCaching.mockResolvedValue(imageFile)
  return imageFile
}

test('fetchAlbumTrackIds returns track ids from the Audius album', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [
        {
          tracks: [{ id: 'track-1' }, { id: 'track-2' }, {}],
        },
      ],
    }),
  } as any)

  const source = { env: 'production' } as SourceConfig

  await expect(fetchAlbumTrackIds(source, 'album-1')).resolves.toEqual([
    'track-1',
    'track-2',
  ])
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.audius.co/v1/full/playlists/album-1',
    { headers: { accept: 'application/json' } }
  )
})

test('deleteAlbumTracks deletes each track in the album', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [
        {
          tracks: [{ id: 'track-1' }, { id: 'track-2' }],
        },
      ],
    }),
  } as any)

  const deleteTrack = vi.fn().mockResolvedValue({})
  const sdk = {
    tracks: {
      deleteTrack,
    },
  } as any
  const source = { env: 'staging' } as SourceConfig

  await deleteAlbumTracks(source, sdk, 'album-1', 'user-1')

  expect(deleteTrack).toHaveBeenNthCalledWith(1, {
    trackId: 'track-1',
    userId: 'user-1',
  })
  expect(deleteTrack).toHaveBeenNthCalledWith(2, {
    trackId: 'track-2',
    userId: 'user-1',
  })
})

test('updateTrack sends the latest cover art file', async () => {
  const imageFile = mockCoverAsset()
  const updateTrackMock = vi.fn().mockResolvedValue({ blockHash: '0xabc' })
  getSdk.mockReturnValue({
    tracks: {
      updateTrack: updateTrackMock,
    },
  })

  await updateTrack(source, releaseRow, {
    audiusGenre: 'Electronic',
    audiusUser: 'user-1',
    deals: [],
    images: [{ ref: 'cover' }],
    releaseDate: '2024-01-01',
    releaseIds: {},
    artists: [],
    soundRecordings: [
      {
        ref: 'track-asset',
        title: 'Track Title',
        artists: [],
        contributors: [],
        indirectContributors: [],
      },
    ],
  } as any)

  expect(assetRepo.get).toHaveBeenCalledWith('source-1', 'release-1', 'cover')
  expect(readAssetWithCaching).toHaveBeenCalledWith(
    's3://bucket/release.xml',
    'images/',
    'cover.jpg'
  )
  expect(updateTrackMock).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: 'user-1',
      trackId: 'entity-1',
      coverArtFile: imageFile,
      metadata: expect.objectContaining({
        title: 'Track Title',
      }),
    })
  )
})

test('updateAlbum sends the latest cover art file', async () => {
  const imageFile = mockCoverAsset()
  const updateAlbumMock = vi.fn().mockResolvedValue({ blockHash: '0xabc' })
  getSdk.mockReturnValue({
    albums: {
      updateAlbum: updateAlbumMock,
    },
  })

  await updateAlbum(source, releaseRow, {
    title: 'Album Title',
    audiusGenre: 'Electronic',
    audiusUser: 'user-1',
    deals: [],
    images: [{ ref: 'cover' }],
    releaseDate: '2024-01-01',
    releaseIds: {
      icpn: '0123456789012',
    },
    artists: [],
    soundRecordings: [],
  } as any)

  expect(assetRepo.get).toHaveBeenCalledWith('source-1', 'release-1', 'cover')
  expect(readAssetWithCaching).toHaveBeenCalledWith(
    's3://bucket/release.xml',
    'images/',
    'cover.jpg'
  )
  expect(updateAlbumMock).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: 'user-1',
      albumId: 'entity-1',
      coverArtFile: imageFile,
      metadata: expect.objectContaining({
        albumName: 'Album Title',
      }),
    })
  )
})

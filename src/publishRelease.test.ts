import { afterEach, expect, test, vi } from 'vitest'

const { assetRepo, getSdk, publogRepo, readAssetWithCaching, releaseRepo } =
  vi.hoisted(() => ({
    assetRepo: {
      get: vi.fn(),
    },
    getSdk: vi.fn(),
    publogRepo: {
      log: vi.fn(),
    },
    readAssetWithCaching: vi.fn(),
    releaseRepo: {
      update: vi.fn(),
    },
  }))

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

vi.mock('./db/publogRepo', () => ({
  publogRepo,
}))

import {
  deleteAlbumTracks,
  fetchAlbumTrackIds,
  publishRelease,
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
  xmlUrl: 's3://bucket/release.xml',
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

function mockReleaseAssets() {
  assetRepo.get.mockImplementation(async (_source, _releaseId, ref) => ({
    xmlUrl: 's3://bucket/release.xml',
    filePath: `${ref}/`,
    fileName: `${ref}.bin`,
  }))
  readAssetWithCaching.mockImplementation(
    async (_xmlUrl, _filePath, fileName) => Buffer.from(fileName)
  )
}

function albumRelease(overrides = {}) {
  return {
    title: 'Album Title',
    audiusGenre: 'Electronic',
    audiusUser: 'user-1',
    deals: [],
    images: [{ ref: 'cover' }],
    labelName: 'Label',
    releaseDate: '2024-01-01',
    releaseIds: {
      icpn: '0123456789012',
    },
    artists: [{ name: 'Artist', role: 'MainArtist' }],
    soundRecordings: [
      {
        ref: 'track-1',
        title: 'Track One',
        artists: [],
        contributors: [],
        indirectContributors: [],
      },
      {
        ref: 'track-2',
        title: 'Track Two',
        artists: [],
        contributors: [],
        indirectContributors: [],
      },
    ],
    ...overrides,
  } as any
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

test('publishRelease persists album track ids after each track publish', async () => {
  mockReleaseAssets()
  const uploadTrackMock = vi
    .fn()
    .mockResolvedValueOnce({
      trackId: 'track-id-1',
      blockHash: '0xtrack1',
      blockNumber: 10,
    })
    .mockResolvedValueOnce({
      trackId: 'track-id-2',
      blockHash: '0xtrack2',
      blockNumber: 11,
    })
  const createAlbumMock = vi.fn().mockResolvedValue({
    albumId: 'album-id-1',
    blockHash: '0xalbum',
    blockNumber: 12,
  })
  getSdk.mockReturnValue({
    tracks: {
      uploadTrack: uploadTrackMock,
    },
    albums: {
      createAlbum: createAlbumMock,
    },
  })

  await publishRelease(source, releaseRow, albumRelease())

  expect(uploadTrackMock).toHaveBeenCalledTimes(2)
  expect(releaseRepo.update).toHaveBeenNthCalledWith(1, {
    key: 'release-1',
    partialTrackIds: ['track-id-1'],
  })
  expect(releaseRepo.update).toHaveBeenNthCalledWith(2, {
    key: 'release-1',
    partialTrackIds: ['track-id-1', 'track-id-2'],
  })
  expect(createAlbumMock).toHaveBeenCalledWith(
    expect.objectContaining({
      trackIds: ['track-id-1', 'track-id-2'],
      userId: 'user-1',
    })
  )
  expect(releaseRepo.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      key: 'release-1',
      status: 'Published',
      entityType: 'album',
      entityId: 'album-id-1',
      partialTrackIds: null,
    })
  )
})

test('publishRelease reuses partial album track ids on retry', async () => {
  mockReleaseAssets()
  const uploadTrackMock = vi.fn()
  const createAlbumMock = vi.fn().mockResolvedValue({
    albumId: 'album-id-1',
    blockHash: '0xalbum',
    blockNumber: 12,
  })
  getSdk.mockReturnValue({
    tracks: {
      uploadTrack: uploadTrackMock,
    },
    albums: {
      createAlbum: createAlbumMock,
    },
  })

  await publishRelease(
    source,
    {
      ...releaseRow,
      partialTrackIds: ['track-id-1', 'track-id-2'],
    },
    albumRelease()
  )

  expect(uploadTrackMock).not.toHaveBeenCalled()
  expect(createAlbumMock).toHaveBeenCalledWith(
    expect.objectContaining({
      trackIds: ['track-id-1', 'track-id-2'],
    })
  )
})

test('publishRelease keeps partial album track ids when a later track fails', async () => {
  mockReleaseAssets()
  const uploadTrackMock = vi
    .fn()
    .mockResolvedValueOnce({
      trackId: 'track-id-1',
      blockHash: '0xtrack1',
      blockNumber: 10,
    })
    .mockRejectedValueOnce(new Error('track publish failed'))
  const createAlbumMock = vi.fn()
  getSdk.mockReturnValue({
    tracks: {
      uploadTrack: uploadTrackMock,
    },
    albums: {
      createAlbum: createAlbumMock,
    },
  })

  await expect(
    publishRelease(source, releaseRow, albumRelease())
  ).rejects.toThrow('track publish failed')

  expect(releaseRepo.update).toHaveBeenCalledWith({
    key: 'release-1',
    partialTrackIds: ['track-id-1'],
  })
  expect(createAlbumMock).not.toHaveBeenCalled()
})

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
import { encodeId } from './util'

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const source = {
  name: 'source-1',
  env: 'production',
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
  const imageBuffer = Buffer.from('cover')
  const imageFile = { buffer: imageBuffer, name: 'cover.jpg' }
  assetRepo.get.mockResolvedValue({
    xmlUrl: 's3://bucket/release.xml',
    filePath: 'images/',
    fileName: 'cover.jpg',
  })
  readAssetWithCaching.mockResolvedValue(imageBuffer)
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
      imageFile,
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
      imageFile,
      metadata: expect.objectContaining({
        albumName: 'Album Title',
      }),
    })
  )
})

test('publishRelease persists album track ids after each track publish', async () => {
  mockReleaseAssets()
  const plannedTrackId1 = encodeId(101)
  const plannedTrackId2 = encodeId(102)
  const plannedAlbumId = encodeId(201)
  const uploadTrackMock = vi
    .fn()
    .mockResolvedValueOnce({
      trackId: plannedTrackId1,
      blockHash: '0xtrack1',
      blockNumber: 10,
    })
    .mockResolvedValueOnce({
      trackId: plannedTrackId2,
      blockHash: '0xtrack2',
      blockNumber: 11,
    })
  const createAlbumMock = vi.fn().mockResolvedValue({
    playlistId: plannedAlbumId,
    blockHash: '0xalbum',
    blockNumber: 12,
  })
  const generateTrackIdMock = vi
    .fn()
    .mockResolvedValueOnce(101)
    .mockResolvedValueOnce(102)
  const generatePlaylistIdMock = vi.fn().mockResolvedValue(201)
  getSdk.mockReturnValue({
    tracks: {
      createTrack: uploadTrackMock,
      generateTrackId: generateTrackIdMock,
    },
    albums: {
      createAlbum: createAlbumMock,
    },
    playlists: {
      generatePlaylistId: generatePlaylistIdMock,
    },
  })

  await publishRelease(source, releaseRow, albumRelease())

  expect(uploadTrackMock).toHaveBeenCalledTimes(2)
  expect(uploadTrackMock).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      metadata: expect.objectContaining({
        trackId: plannedTrackId1,
      }),
    })
  )
  expect(uploadTrackMock).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      metadata: expect.objectContaining({
        trackId: plannedTrackId2,
      }),
    })
  )
  expect(releaseRepo.update).toHaveBeenNthCalledWith(1, {
    key: 'release-1',
    plannedTrackIds: [plannedTrackId1],
  })
  expect(releaseRepo.update).toHaveBeenNthCalledWith(2, {
    key: 'release-1',
    partialTrackIds: [plannedTrackId1],
  })
  expect(releaseRepo.update).toHaveBeenNthCalledWith(3, {
    key: 'release-1',
    plannedTrackIds: [plannedTrackId1, plannedTrackId2],
  })
  expect(releaseRepo.update).toHaveBeenNthCalledWith(4, {
    key: 'release-1',
    partialTrackIds: [plannedTrackId1, plannedTrackId2],
  })
  expect(releaseRepo.update).toHaveBeenNthCalledWith(5, {
    key: 'release-1',
    plannedEntityType: 'album',
    plannedEntityId: plannedAlbumId,
  })
  const albumRequest = createAlbumMock.mock.calls[0][0]
  expect(albumRequest).toEqual(
    expect.objectContaining({
      userId: 'user-1',
      metadata: expect.objectContaining({
        playlistId: plannedAlbumId,
        playlistContents: [
          { trackId: plannedTrackId1, timestamp: expect.any(Number) },
          { trackId: plannedTrackId2, timestamp: expect.any(Number) },
        ],
      }),
    })
  )
  expect(albumRequest).not.toHaveProperty('albumId')
  expect(albumRequest).not.toHaveProperty('trackIds')
  expect(releaseRepo.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      key: 'release-1',
      status: 'Published',
      entityType: 'album',
      entityId: plannedAlbumId,
      plannedEntityType: null,
      plannedEntityId: null,
      plannedTrackIds: null,
      partialTrackIds: null,
    })
  )
})

test('publishRelease reuses partial album track ids on retry', async () => {
  mockReleaseAssets()
  const uploadTrackMock = vi.fn()
  const generateTrackIdMock = vi.fn()
  const generatePlaylistIdMock = vi.fn()
  const createAlbumMock = vi.fn().mockResolvedValue({
    albumId: 'album-id-1',
    blockHash: '0xalbum',
    blockNumber: 12,
  })
  getSdk.mockReturnValue({
    tracks: {
      createTrack: uploadTrackMock,
      generateTrackId: generateTrackIdMock,
    },
    albums: {
      createAlbum: createAlbumMock,
    },
    playlists: {
      generatePlaylistId: generatePlaylistIdMock,
    },
  })

  await publishRelease(
    source,
    {
      ...releaseRow,
      partialTrackIds: ['track-id-1', 'track-id-2'],
      plannedEntityType: 'album',
      plannedEntityId: 'planned-album-id',
    },
    albumRelease()
  )

  expect(uploadTrackMock).not.toHaveBeenCalled()
  expect(generateTrackIdMock).not.toHaveBeenCalled()
  expect(generatePlaylistIdMock).not.toHaveBeenCalled()
  const albumRequest = createAlbumMock.mock.calls[0][0]
  expect(albumRequest).toEqual(
    expect.objectContaining({
      metadata: expect.objectContaining({
        playlistId: 'planned-album-id',
        playlistContents: [
          { trackId: 'track-id-1', timestamp: expect.any(Number) },
          { trackId: 'track-id-2', timestamp: expect.any(Number) },
        ],
      }),
    })
  )
  expect(albumRequest).not.toHaveProperty('albumId')
  expect(albumRequest).not.toHaveProperty('trackIds')
})

test('publishRelease does not mark albums published without a response id', async () => {
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
    blockHash: '0xalbum',
    blockNumber: 12,
  })
  getSdk.mockReturnValue({
    tracks: {
      createTrack: uploadTrackMock,
      generateTrackId: vi
        .fn()
        .mockResolvedValueOnce(101)
        .mockResolvedValueOnce(102),
    },
    albums: {
      createAlbum: createAlbumMock,
    },
    playlists: {
      generatePlaylistId: vi.fn().mockResolvedValue(201),
    },
  })

  await expect(publishRelease(source, releaseRow, albumRelease())).rejects.toThrow(
    'album publish response missing playlistId'
  )

  expect(releaseRepo.update).not.toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: 'Published',
    })
  )
})

test('publishRelease keeps partial album track ids when a later track fails', async () => {
  mockReleaseAssets()
  const plannedTrackId1 = encodeId(101)
  const plannedTrackId2 = encodeId(102)
  const uploadTrackMock = vi
    .fn()
    .mockResolvedValueOnce({
      trackId: plannedTrackId1,
      blockHash: '0xtrack1',
      blockNumber: 10,
    })
    .mockRejectedValueOnce(new Error('track publish failed'))
  const createAlbumMock = vi.fn()
  const generateTrackIdMock = vi
    .fn()
    .mockResolvedValueOnce(101)
    .mockResolvedValueOnce(102)
  getSdk.mockReturnValue({
    tracks: {
      createTrack: uploadTrackMock,
      generateTrackId: generateTrackIdMock,
    },
    albums: {
      createAlbum: createAlbumMock,
    },
    playlists: {
      generatePlaylistId: vi.fn(),
    },
  })

  await expect(
    publishRelease(source, releaseRow, albumRelease())
  ).rejects.toThrow('track publish failed')

  expect(releaseRepo.update).toHaveBeenCalledWith({
    key: 'release-1',
    plannedTrackIds: [plannedTrackId1],
  })
  expect(releaseRepo.update).toHaveBeenCalledWith({
    key: 'release-1',
    partialTrackIds: [plannedTrackId1],
  })
  expect(releaseRepo.update).toHaveBeenCalledWith({
    key: 'release-1',
    plannedTrackIds: [plannedTrackId1, plannedTrackId2],
  })
  expect(createAlbumMock).not.toHaveBeenCalled()
})

test('publishRelease reuses a planned album id when album creation fails', async () => {
  mockReleaseAssets()
  const createAlbumMock = vi.fn().mockRejectedValue(new Error('album failed'))
  getSdk.mockReturnValue({
    tracks: {
      createTrack: vi.fn(),
      generateTrackId: vi.fn(),
    },
    albums: {
      createAlbum: createAlbumMock,
    },
    playlists: {
      generatePlaylistId: vi.fn(),
    },
  })

  await expect(
    publishRelease(
      source,
      {
        ...releaseRow,
        partialTrackIds: ['track-id-1', 'track-id-2'],
        plannedEntityType: 'album',
        plannedEntityId: 'planned-album-id',
      },
      albumRelease()
    )
  ).rejects.toThrow('album failed')

  const albumRequest = createAlbumMock.mock.calls[0][0]
  expect(albumRequest).toEqual(
    expect.objectContaining({
      metadata: expect.objectContaining({
        playlistId: 'planned-album-id',
        playlistContents: [
          { trackId: 'track-id-1', timestamp: expect.any(Number) },
          { trackId: 'track-id-2', timestamp: expect.any(Number) },
        ],
      }),
    })
  )
  expect(albumRequest).not.toHaveProperty('albumId')
  expect(albumRequest).not.toHaveProperty('trackIds')
})

test('publishRelease persists a planned single track id before upload', async () => {
  mockReleaseAssets()
  const plannedTrackId = encodeId(301)
  const uploadTrackMock = vi.fn().mockResolvedValue({
    trackId: plannedTrackId,
    blockHash: '0xtrack',
    blockNumber: 20,
  })
  const generateTrackIdMock = vi.fn().mockResolvedValue(301)
  getSdk.mockReturnValue({
    tracks: {
      createTrack: uploadTrackMock,
      generateTrackId: generateTrackIdMock,
    },
  })

  await publishRelease(
    source,
    {
      ...releaseRow,
      entityId: undefined,
    },
    {
      ...albumRelease({
        title: 'Single Title',
        releaseIds: { isrc: 'USRC17607839' },
        soundRecordings: [
          {
            ref: 'track-1',
            title: 'Track One',
            artists: [],
            contributors: [],
            indirectContributors: [],
          },
        ],
      }),
    }
  )

  expect(releaseRepo.update).toHaveBeenNthCalledWith(1, {
    key: 'release-1',
    plannedEntityType: 'track',
    plannedEntityId: plannedTrackId,
  })
  expect(uploadTrackMock).toHaveBeenCalledWith(
    expect.objectContaining({
      metadata: expect.objectContaining({
        trackId: plannedTrackId,
      }),
    })
  )
  expect(releaseRepo.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      entityType: 'track',
      entityId: plannedTrackId,
      plannedEntityType: null,
      plannedEntityId: null,
    })
  )
})

test('publishRelease seeds planned track ids from prior partial album tracks', async () => {
  mockReleaseAssets()
  const plannedTrackId2 = encodeId(102)
  const uploadTrackMock = vi.fn().mockResolvedValue({
    trackId: plannedTrackId2,
    blockHash: '0xtrack2',
    blockNumber: 11,
  })
  const createAlbumMock = vi.fn().mockRejectedValue(new Error('stop'))
  const generateTrackIdMock = vi.fn().mockResolvedValue(102)
  getSdk.mockReturnValue({
    tracks: {
      createTrack: uploadTrackMock,
      generateTrackId: generateTrackIdMock,
    },
    albums: {
      createAlbum: createAlbumMock,
    },
    playlists: {
      generatePlaylistId: vi.fn(),
    },
  })

  await expect(
    publishRelease(
      source,
      {
        ...releaseRow,
        partialTrackIds: ['track-id-1'],
      },
      albumRelease()
    )
  ).rejects.toThrow('stop')

  expect(releaseRepo.update).toHaveBeenCalledWith({
    key: 'release-1',
    plannedTrackIds: ['track-id-1', plannedTrackId2],
  })
  expect(uploadTrackMock).toHaveBeenCalledWith(
    expect.objectContaining({
      metadata: expect.objectContaining({
        trackId: plannedTrackId2,
      }),
    })
  )
})

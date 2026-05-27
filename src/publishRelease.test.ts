import { afterEach, expect, test, vi } from 'vitest'

import { deleteAlbumTracks, fetchAlbumTrackIds } from './publishRelease'
import { type SourceConfig } from './sources'

afterEach(() => {
  vi.restoreAllMocks()
})

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

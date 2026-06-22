import { createSdkWithServices } from '@audius/sdk'
import { expect, test, vi } from 'vitest'
import { getSdk, getSdkNetworkConfig } from './sdk'
import { encodeId } from './util'

test('getSdkNetworkConfig requires an explicit publishing env', () => {
  expect(() => getSdkNetworkConfig(undefined)).toThrow(
    'source env is required for DDEX publishing with @audius/sdk v15'
  )
})

test('getSdkNetworkConfig preserves production publishing writes', () => {
  expect(getSdkNetworkConfig('production')).toEqual({
    environment: 'production',
  })
})

test('getSdkNetworkConfig preserves development publishing writes', () => {
  expect(getSdkNetworkConfig('development')).toEqual({
    environment: 'development',
  })
})

test('getSdkNetworkConfig fails fast for unsupported staging publishing writes', () => {
  expect(() => getSdkNetworkConfig('staging')).toThrow(
    'staging DDEX publishing is not supported by @audius/sdk v15'
  )
})

test('getSdk surfaces unsupported staging publishing writes', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

  expect(() =>
    getSdk({
      env: 'staging',
      name: 'source-1',
      ddexKey: '0x0000000000000000000000000000000000000001',
      ddexSecret: '0000000000000000000000000000000000000001',
      labelUserIds: {},
    } as any)
  ).toThrow('staging DDEX publishing is not supported by @audius/sdk v15')

  logSpy.mockRestore()
})

test('SDK v15 accepts the DDEX album create payload shape', async () => {
  const uploadFile = vi.fn(() => ({
    start: vi.fn().mockResolvedValue({ orig_file_cid: 'cover-cid' }),
  }))
  const manageEntity = vi.fn().mockResolvedValue({
    blockHash: '0xblock',
    blockNumber: 1,
    transactionHash: '0xtx',
  })
  const audiusSdk = createSdkWithServices({
    apiKey: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
    apiSecret:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    appName: 'ddex-test',
    environment: 'production',
    services: {
      storage: { uploadFile } as any,
      entityManager: { manageEntity } as any,
    },
  })

  const albumId = encodeId(201)
  const trackId = encodeId(101)
  const userId = encodeId(301)
  const imageFile = {
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64'
    ),
    name: 'cover.png',
    type: 'image/png',
  }

  await expect(
    audiusSdk.albums.createAlbum({
      imageFile,
      metadata: {
        albumName: 'Album',
        playlistId: albumId,
        playlistContents: [{ trackId, timestamp: 1 }],
      },
      userId,
    } as any)
  ).resolves.toEqual(
    expect.objectContaining({
      playlistId: albumId,
    })
  )
  expect(manageEntity).toHaveBeenCalledWith(
    expect.objectContaining({
      entityId: 201,
      userId: 301,
    })
  )
})

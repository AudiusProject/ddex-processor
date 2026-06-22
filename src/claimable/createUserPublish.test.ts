import { afterEach, expect, test, vi } from 'vitest'

const {
  assetRepo,
  releaseRepo,
  userRepo,
  publogRepo,
  publishRelease,
  readAssetWithCaching,
  findByName,
  signUp,
  createHedgehogWalletClient,
  createSdkWithServices,
  createAuthLookupKey,
  createKey,
  getEntropyFromLocalStorage,
} = vi.hoisted(() => ({
  assetRepo: {
    get: vi.fn(),
  },
  releaseRepo: {
    get: vi.fn(),
    upsert: vi.fn(),
  },
  userRepo: {
    match: vi.fn(),
    upsert: vi.fn(),
  },
  publogRepo: {
    log: vi.fn(),
  },
  publishRelease: vi.fn(),
  readAssetWithCaching: vi.fn(),
  findByName: vi.fn(),
  signUp: vi.fn(),
  createHedgehogWalletClient: vi.fn(),
  createSdkWithServices: vi.fn(),
  createAuthLookupKey: vi.fn(),
  createKey: vi.fn(),
  getEntropyFromLocalStorage: vi.fn(),
}))

vi.mock('../db', () => ({
  assetRepo,
  releaseRepo,
  userRepo,
}))

vi.mock('../db/publogRepo', () => ({
  publogRepo,
}))

vi.mock('../publishRelease', () => ({
  publishRelease,
}))

vi.mock('../s3poller', () => ({
  readAssetWithCaching,
}))

vi.mock('../sources', () => ({
  sources: {
    findByName,
  },
}))

vi.mock('@audius/sdk', () => ({
  createHedgehogWalletClient,
  createSdkWithServices,
}))

vi.mock('@audius/hedgehog', () => ({
  WalletManager: {
    createAuthLookupKey,
    getEntropyFromLocalStorage,
  },
}))

vi.mock('./hedgehog', () => ({
  generateRecoveryInfo: vi.fn(),
  getHedgehog: vi.fn(() => ({
    signUp,
    createKey,
  })),
}))

import {
  ClaimableHandleRequiredError,
  ClaimableRecoveryRequiredError,
  defaultClaimableHandle,
  publishToClaimableAccount,
} from './createUserPublish'
import { encodeId } from '../util'

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

test('defaultClaimableHandle uses ASCII artist names directly', () => {
  expect(defaultClaimableHandle('DJ Theo')).toBe('DJTheo')
})

test('defaultClaimableHandle returns no handle for non-ASCII artist names', () => {
  expect(defaultClaimableHandle('ОСОБО ТЯЖКИЙ')).toBeUndefined()
})

test('defaultClaimableHandle preserves dots in artist names', () => {
  expect(defaultClaimableHandle('DJ Theo Jr.')).toBe('DJTheoJr.')
})

test('ClaimableHandleRequiredError explains the operator action', () => {
  expect(new ClaimableHandleRequiredError('ОСОБО ТЯЖКИЙ').message).toContain(
    'Set audiusHandle in the UI'
  )
})

test('retries recover when the remote claimable account and source grant already exist', async () => {
  const release = {
    key: 'release-1',
    source: 'source-1',
    xmlUrl: 's3://bucket/file.xml',
    messageTimestamp: '2026-06-08T00:00:00.000Z',
    artists: [{ name: 'DJ Theo' }],
    images: [{ ref: 'cover' }],
    soundRecordings: [],
    releaseIds: [],
  }

  releaseRepo.get.mockResolvedValue(release)
  findByName.mockReturnValue({
    ddexKey: '0xabc123',
    env: 'staging',
    name: 'source-1',
  })
  assetRepo.get.mockResolvedValue({
    xmlUrl: 's3://bucket/file.xml',
    filePath: '/tmp/cover.jpg',
    fileName: 'cover.jpg',
  })
  readAssetWithCaching.mockResolvedValue(Buffer.from('cover'))
  userRepo.match.mockResolvedValue(undefined)
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          id: 42,
          handle: 'DJTheo',
          name: 'DJ Theo',
        },
      }),
    } as any)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: 42,
            handle: 'DJTheo',
            name: 'DJ Theo',
          },
        ],
      }),
    } as any)

  await publishToClaimableAccount('release-1')

  expect(signUp).not.toHaveBeenCalled()
  expect(userRepo.upsert).toHaveBeenCalledWith({
    apiKey: '0xabc123',
    createdAt: expect.any(Date),
    handle: 'DJTheo',
    id: encodeId(42),
    name: 'DJ Theo',
  })
  expect(releaseRepo.upsert).toHaveBeenCalledTimes(1)
  expect(publishRelease).toHaveBeenCalledWith(
    expect.objectContaining({ ddexKey: '0xabc123' }),
    release,
    expect.objectContaining({ audiusUser: encodeId(42) })
  )
})

test('retries fail with a recovery-required error when the remote account exists without the source grant', async () => {
  const release = {
    key: 'release-1',
    source: 'source-1',
    xmlUrl: 's3://bucket/file.xml',
    messageTimestamp: '2026-06-08T00:00:00.000Z',
    artists: [{ name: 'DJ Theo' }],
    images: [{ ref: 'cover' }],
    soundRecordings: [],
    releaseIds: [],
  }

  releaseRepo.get.mockResolvedValue(release)
  findByName.mockReturnValue({
    ddexKey: '0xabc123',
    env: 'staging',
    name: 'source-1',
  })
  assetRepo.get.mockResolvedValue({
    xmlUrl: 's3://bucket/file.xml',
    filePath: '/tmp/cover.jpg',
    fileName: 'cover.jpg',
  })
  readAssetWithCaching.mockResolvedValue(Buffer.from('cover'))
  userRepo.match.mockResolvedValue(undefined)
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          id: 42,
          handle: 'DJTheo',
          name: 'DJ Theo',
        },
      }),
    } as any)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [],
      }),
    } as any)

  await expect(publishToClaimableAccount('release-1')).rejects.toBeInstanceOf(
    ClaimableRecoveryRequiredError
  )
  expect(userRepo.upsert).not.toHaveBeenCalled()
  expect(publishRelease).not.toHaveBeenCalled()
})

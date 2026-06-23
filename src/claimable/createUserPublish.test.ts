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
  generateRecoveryInfo,
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
  generateRecoveryInfo: vi.fn(),
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
  generateRecoveryInfo,
  getHedgehog: vi.fn(() => ({
    signUp,
    createKey,
  })),
}))

import {
  ClaimableHandleRequiredError,
  ClaimableRecoveryRequiredError,
  claimableEmailForHandle,
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

test('claimableEmailForHandle can scope stale login retries to a release', () => {
  expect(claimableEmailForHandle('DJTheo')).toBe(
    'ddex-support+DJTheo@audius.co'
  )
  expect(claimableEmailForHandle('DJTheo', 'release-1')).toMatch(
    /^ddex-support\+DJTheo-[a-f0-9]{12}@audius\.co$/
  )
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

test('retries with a release-scoped login when the support login already exists but the handle is free', async () => {
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
  const createUser = vi.fn().mockResolvedValue({ userId: 'user-1' })
  const updateUser = vi.fn().mockResolvedValue({ blockHash: '0ximage' })
  const createGrant = vi.fn().mockResolvedValue({ blockHash: '0xgrant' })

  releaseRepo.get.mockResolvedValue(release)
  findByName.mockReturnValue({
    ddexKey: '0xabc123',
    env: 'production',
    name: 'source-1',
  })
  assetRepo.get.mockResolvedValue({
    xmlUrl: 's3://bucket/file.xml',
    filePath: '/tmp/cover.jpg',
    fileName: 'cover.jpg',
  })
  readAssetWithCaching.mockResolvedValue(Buffer.from('cover'))
  userRepo.match.mockResolvedValue(undefined)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status: 404,
  } as any)
  signUp
    .mockRejectedValueOnce(
      new Error(
        'set user failed {"error":"Account already exists for user, try logging in"}'
      )
    )
    .mockResolvedValueOnce({
      getAddressString: () => '0xwallet',
    })
  createHedgehogWalletClient.mockReturnValue({ wallet: true })
  createSdkWithServices.mockReturnValue({
    users: {
      createUser,
      updateUser,
    },
    grants: {
      createGrant,
    },
  })
  generateRecoveryInfo.mockResolvedValue({
    login: 'recovery-login',
    host: 'https://audius.co',
    loginUrl: 'https://audius.co/recover?login=recovery-login',
  })
  createAuthLookupKey.mockResolvedValue('lookup-key')

  await publishToClaimableAccount('release-1')

  const initialSignUp = signUp.mock.calls[0][0]
  const retrySignUp = signUp.mock.calls[1][0]
  expect(initialSignUp).toEqual({
    username: 'ddex-support+DJTheo@audius.co',
    password: expect.any(String),
  })
  expect(retrySignUp).toEqual({
    username: claimableEmailForHandle('DJTheo', 'release-1'),
    password: initialSignUp.password,
  })
  expect(createAuthLookupKey).toHaveBeenCalledWith(
    claimableEmailForHandle('DJTheo', 'release-1'),
    initialSignUp.password,
    createKey
  )
  expect(createUser).toHaveBeenCalledWith({
    metadata: {
      handle: 'DJTheo',
      name: 'DJ Theo',
      wallet: '0xwallet',
    },
  })
  expect(userRepo.upsert).toHaveBeenCalledWith({
    apiKey: '0xabc123',
    createdAt: expect.any(Date),
    handle: 'DJTheo',
    id: 'user-1',
    login: 'recovery-login',
    lookupKey: 'lookup-key',
    name: 'DJ Theo',
  })
  expect(publishRelease).toHaveBeenCalledWith(
    expect.objectContaining({ ddexKey: '0xabc123' }),
    expect.objectContaining({ audiusUser: 'user-1' }),
    expect.objectContaining({ audiusUser: 'user-1' })
  )
})

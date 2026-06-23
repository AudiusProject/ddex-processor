import { createHedgehogWalletClient, createSdkWithServices } from '@audius/sdk'
import { createHash, randomBytes } from 'crypto'
import { assetRepo, releaseRepo, userRepo } from '../db'
import { publogRepo } from '../db/publogRepo'
import { DDEXResource } from '../parseDelivery'
import { publishRelease } from '../publishRelease'
import { readAssetWithCaching } from '../s3poller'
import { sources } from '../sources'
import { encodeId, lowerAscii } from '../util'
import { WalletManager } from '@audius/hedgehog'
import { generateRecoveryInfo, getHedgehog } from './hedgehog'
import { getSdkNetworkConfig } from '../sdk'

export class ClaimableHandleRequiredError extends Error {
  constructor(artistName: string) {
    super(
      `ClaimableHandleRequired: artist name '${artistName}' does not produce a valid Audius handle. ` +
        `Set audiusHandle in the UI to publish under a unique ASCII handle.`
    )
    this.name = 'ClaimableHandleRequiredError'
  }
}

export class ClaimableRecoveryRequiredError extends Error {
  constructor() {
    super(
      'ClaimableRecoveryRequired: an existing remote claimable account matches this release, ' +
        'but the source app grant is missing. Restore the grant or link the user before retrying.'
    )
    this.name = 'ClaimableRecoveryRequiredError'
  }
}

type DiscoveryUser = {
  encodedUserId: string
  handle: string
  name: string
}

export async function publishToClaimableAccount(releaseId: string) {
  const releaseRow = await releaseRepo.get(releaseId)
  const release = releaseRow
  if (!releaseRow || !release) {
    throw new Error(`release not found: ${releaseId}`)
  }

  const source = sources.findByName(releaseRow.source)
  if (!source) {
    throw new Error(`missing source: ${releaseRow.source}`)
  }

  // if already has a user... don't create claimable account
  if (release.audiusUser) {
    return await publishRelease(source!, releaseRow, release)
  }

  const artistName = release.artists[0].name
  // releaseRow.audiusHandle is an admin override set in the UI when the
  // default-derived handle collides with an existing audius user. When set,
  // we trust it and bypass the per-row regex stripping.
  const handle = releaseRow.audiusHandle || defaultClaimableHandle(artistName)
  if (!handle) {
    throw new ClaimableHandleRequiredError(artistName)
  }

  // read image asset file
  async function resolveFile({ ref }: DDEXResource) {
    const asset = await assetRepo.get(releaseRow!.source, releaseRow!.key, ref)
    if (!asset) {
      throw new Error(`failed to resolve asset ${releaseRow!.key} ${ref}`)
    }
    return readAssetWithCaching(asset.xmlUrl, asset.filePath, asset.fileName)
  }

  const imageFile = await resolveFile(release.images[0])
  let email = claimableEmailForHandle(handle)
  const password = randomBytes(16).toString('hex')

  // attempt to find existing user record
  // if not found, create a claimable account
  let encodedUserId = await userRepo.match(source.ddexKey, [artistName])
  if (!encodedUserId) {
    const existingUser = await lookupUserByHandle(
      handle,
      source.env || 'staging'
    )
    if (existingUser) {
      const grantedUser = await lookupGrantedUserByHandle(
        source.ddexKey,
        handle,
        source.env || 'staging'
      )
      if (grantedUser?.encodedUserId === existingUser.encodedUserId) {
        encodedUserId = existingUser.encodedUserId
        await userRepo.upsert({
          id: encodedUserId,
          apiKey: source.ddexKey,
          handle: existingUser.handle,
          name: existingUser.name,
          createdAt: new Date(),
        })
      } else if (lowerAscii(existingUser.name) === lowerAscii(artistName)) {
        throw new ClaimableRecoveryRequiredError()
      } else {
        throw handleClaimedError(handle, source.env || 'staging')
      }
    }
  }

  if (!encodedUserId) {
    // no user: create claimable user
    console.log(`=== creating claimable account for ${artistName}`)
    const hedgehog = getHedgehog()
    let identityResult
    try {
      identityResult = await hedgehog.signUp({
        username: email,
        password,
      })
    } catch (e) {
      if (!isIdentityUserExistsError(e)) {
        throw e
      }
      email = claimableEmailForHandle(handle, releaseRow.key)
      console.log(
        `claimable login already exists for ${handle}; retrying with release-scoped login`
      )
      identityResult = await hedgehog.signUp({
        username: email,
        password,
      })
    }
    console.log('identityResult', identityResult)

    const { login } = await generateRecoveryInfo()
    const lookupKey = await WalletManager.createAuthLookupKey(
      email,
      password,
      hedgehog.createKey
    )

    const audiusWalletClient = createHedgehogWalletClient(getHedgehog())
    const userSdk = createSdkWithServices({
      appName: 'ddex',
      ...getSdkNetworkConfig(source.env),
      services: {
        audiusWalletClient,
      },
    })

    const newUser = await userSdk.users.createUser({
      metadata: {
        handle: handle,
        name: artistName,
        wallet: identityResult.getAddressString(),
      },
    })

    await publogRepo.log({
      release_id: release.key,
      msg: 'created user',
      extra: newUser,
    })

    if (!newUser.userId) {
      throw new Error('create user response missing userId')
    }
    encodedUserId = newUser.userId
    console.log(newUser, encodedUserId)

    // upload profile picture + cover photo
    const updateImageResult = await userSdk.users.updateUser({
      id: encodedUserId,
      userId: encodedUserId,
      metadata: {},
      profilePictureFile: imageFile as any,
      coverArtFile: imageFile as any,
    })
    console.log('updateImageResult', updateImageResult)

    await publogRepo.log({
      release_id: release.key,
      msg: 'set user image',
      extra: updateImageResult,
    })

    // authorize source ddex app
    const grantResult = await userSdk.grants.createGrant({
      userId: encodedUserId,
      appApiKey: source.ddexKey,
    })
    console.log('grantResult', grantResult)

    await publogRepo.log({
      release_id: release.key,
      msg: 'user grant',
      extra: grantResult,
    })

    // save user details to db
    await userRepo.upsert({
      id: encodedUserId,
      apiKey: source.ddexKey,
      handle: handle,
      name: artistName,
      login,
      lookupKey,
      createdAt: new Date(),
    })
  }

  // save release with associated audius user
  release.audiusUser = encodedUserId
  await releaseRepo.upsert(
    releaseRow.source,
    releaseRow.xmlUrl,
    releaseRow.messageTimestamp,
    release
  )

  await publishRelease(source!, releaseRow, release)
}

export function defaultClaimableHandle(artistName: string) {
  const fromArtist = artistName.replace(/[^a-zA-Z0-9.]/g, '')
  return fromArtist || undefined
}

export function claimableEmailForHandle(handle: string, releaseKey?: string) {
  const suffix = releaseKey
    ? `-${createHash('sha256').update(releaseKey).digest('hex').slice(0, 12)}`
    : ''
  return `ddex-support+${handle}${suffix}@audius.co`
}

function isIdentityUserExistsError(e: unknown) {
  return String((e as Error)?.message || e).includes(
    'Account already exists for user'
  )
}

async function lookupUserByHandle(
  handle: string,
  env: string
): Promise<DiscoveryUser | undefined> {
  const apiHost =
    env === 'production'
      ? 'https://api.audius.co'
      : 'https://api.staging.audius.co'
  const res = await fetch(
    `${apiHost}/v1/users/handle/${encodeURIComponent(handle)}`
  )
  if (res.status === 404) return
  if (!res.ok) {
    throw new Error(
      `discovery handle check failed for ${handle}: HTTP ${res.status}`
    )
  }
  const payload = await res.json()
  const user = Array.isArray(payload.data) ? payload.data[0] : payload.data
  if (!user) return
  return {
    encodedUserId: encodeId(user.id || user.user_id),
    handle: user.handle || handle,
    name: user.name || '',
  }
}

async function lookupGrantedUserByHandle(
  ddexKey: string,
  handle: string,
  env: string
): Promise<DiscoveryUser | undefined> {
  const apiHost =
    env === 'production'
      ? 'https://api.audius.co'
      : 'https://api.staging.audius.co'
  const address = ddexKey.replace(/^0x/, '')
  const normalizedHandle = lowerAscii(handle)
  const pageSize = 100

  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${apiHost}/v1/grantees/${address}/users?is_revoked=false&limit=${pageSize}&offset=${offset}`,
      {
        headers: { accept: 'application/json' },
      }
    )
    if (!res.ok) {
      throw new Error(`discovery grant check failed: HTTP ${res.status}`)
    }
    const payload = await res.json()
    const users = payload.data || []
    const user = users.find(
      (candidate: any) =>
        lowerAscii(candidate.handle || '') === normalizedHandle
    )
    if (user) {
      return {
        encodedUserId: encodeId(user.id || user.user_id),
        handle: user.handle || handle,
        name: user.name || '',
      }
    }
    if (users.length < pageSize) return
  }
}

function handleClaimedError(handle: string, env: string) {
  const profileUrl =
    env === 'production'
      ? `https://audius.co/${handle}`
      : `https://staging.audius.co/${handle}`
  return new Error(
    `HandleClaimed: '${handle}' already exists on Audius (${profileUrl}). ` +
      `Set audiusHandle in the UI to publish under a different handle.`
  )
}

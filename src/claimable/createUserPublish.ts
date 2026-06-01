import { createHedgehogWalletClient, sdk } from '@audius/sdk'
import { randomBytes } from 'crypto'
import { assetRepo, releaseRepo, userRepo } from '../db'
import { publogRepo } from '../db/publogRepo'
import { DDEXResource } from '../parseDelivery'
import { publishRelease } from '../publishRelease'
import { readAssetWithCaching } from '../s3poller'
import { sources } from '../sources'
import { encodeId } from '../util'
import { WalletManager } from '@audius/hedgehog'
import { generateRecoveryInfo, getHedgehog } from './hedgehog'

export class ClaimableHandleRequiredError extends Error {
  constructor(artistName: string) {
    super(
      `ClaimableHandleRequired: artist name '${artistName}' does not produce a valid Audius handle. ` +
        `Set audiusHandle in the UI to publish under a unique ASCII handle.`
    )
    this.name = 'ClaimableHandleRequiredError'
  }
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
  const email = `ddex-support+${handle}@audius.co`
  const password = randomBytes(16).toString('hex')

  // attempt to find existing user record
  // if not found, create a claimable account
  let encodedUserId = await userRepo.match(source.ddexKey, [artistName])
  if (!encodedUserId) {
    // Refuse to signUp if the handle is already claimed on Audius — that
    // produces an orphaned identity row with no audius user (createUser fails
    // downstream because the handle is taken). Admin can set audiusHandle in
    // the UI to publish under a different handle.
    await assertHandleAvailable(handle, source.env || 'staging')

    // no user: create claimable user
    console.log(`=== creating claimable account for ${artistName}`)
    const hedgehog = getHedgehog()
    const identityResult = await hedgehog.signUp({
      username: email,
      password,
    })
    console.log('identityResult', identityResult)

    const { login } = await generateRecoveryInfo()
    const lookupKey = await WalletManager.createAuthLookupKey(
      email,
      password,
      hedgehog.createKey
    )

    const audiusWalletClient = createHedgehogWalletClient(getHedgehog())
    const userSdk = sdk({
      appName: 'ddex',
      environment: source.env || 'staging',
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

    encodedUserId = encodeId(newUser.metadata.userId)
    console.log(newUser, encodedUserId)

    // upload profile picture + cover photo
    const updateImageResult = await userSdk.users.updateProfile({
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

/**
 * Throws HandleClaimed if a discovery user already exists with this handle.
 * Caller's error gets surfaced as the release's lastPublishError, prompting
 * the admin to set an audiusHandle override in the UI.
 */
async function assertHandleAvailable(handle: string, env: string) {
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
  const profileUrl =
    env === 'production'
      ? `https://audius.co/${handle}`
      : `https://staging.audius.co/${handle}`
  throw new Error(
    `HandleClaimed: '${handle}' already exists on Audius (${profileUrl}). ` +
      `Set audiusHandle in the UI to publish under a different handle.`
  )
}

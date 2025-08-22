import { createHedgehogWalletClient, sdk } from '@audius/sdk'
import { randomBytes } from 'crypto'
import { assetRepo, releaseRepo, userRepo } from '../db'
import { publogRepo } from '../db/publogRepo'
import { DDEXResource } from '../parseDelivery'
import { publishRelease } from '../publishRelease'
import { readAssetWithCaching } from '../s3poller'
import { sources } from '../sources'
import { encodeId } from '../util'
import { getHedgehog } from './hedgehog'

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
  const handle = artistName.replace(/[^a-zA-Z0-9.]/g, '')

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

  try {
    // attempt to find existing user record
    // if not found, create a claimable account
    let encodedUserId = await userRepo.match(source.ddexKey, [artistName])
    if (!encodedUserId) {
      // no user: create claimable user
      console.log(`=== creating claimable account for ${artistName}`)
      const hedgehog = getHedgehog()
      const identityResult = await hedgehog.signUp({
        username: email,
        password,
      })
      console.log('identityResult', identityResult)

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
          bio: `${release.labelName}.`,
        },
      })

      await publogRepo.log({
        release_id: release.key,
        msg: 'created user',
        extra: newUser,
      })

      // const entropy = localStorage.getItem('hedgehog-entropy-key')
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
        password,
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
  } catch (e) {
    console.log('attempt', attempt, e)
  }
}

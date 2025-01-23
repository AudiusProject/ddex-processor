import { createHedgehogWalletClient, sdk } from '@audius/sdk'
import { assetRepo, releaseRepo } from '../db'
import { DDEXResource } from '../parseDelivery'
import { publishRelease } from '../publishRelease'
import { readAssetWithCaching } from '../s3poller'
import { sources } from '../sources'
import { encodeId } from '../util'
import { getHedgehog } from './hedgehog'

async function main() {
  sources.load()

  const releaseId = '8690101820359'
  const releaseRow = releaseRepo.get(releaseId)
  const release = releaseRow?._parsed
  if (!releaseRow || !release) {
    throw new Error(`release not found: ${releaseId}`)
  }
  const artistName = release.artists[0].name
  const baseHandle = artistName.replace(/[^a-zA-Z0-9]/g, '')

  const source = sources.findByName(releaseRow.source)
  if (!source) {
    throw new Error(`missing source: ${releaseRow.source}`)
  }

  // read asset file
  async function resolveFile({ ref }: DDEXResource) {
    const asset = assetRepo.get(releaseRow!.source, releaseRow!.key, ref)
    if (!asset) {
      throw new Error(`failed to resolve asset ${releaseRow!.key} ${ref}`)
    }
    return readAssetWithCaching(asset.xmlUrl, asset.filePath, asset.fileName)
  }

  const imageFile = await resolveFile(release.images[0])

  // TODO: attempt to find existing claimable artist if publishing a second release from an artist

  // use attempt to handle situations where email / handle is taken.
  for (let attempt = 0; attempt < 20; attempt++) {
    let handle = baseHandle
    if (attempt) {
      handle += `_${attempt}`
    }
    const email = `steve+${handle}@audius.co`
    const password = 'password123'

    try {
      const hedgehog = getHedgehog()
      const identityResult = await hedgehog.signUp({
        username: email,
        password,
      })
      console.log('identityResult', identityResult)

      const audiusWalletClient = createHedgehogWalletClient(getHedgehog())
      const userSdk = sdk({
        appName: 'ddex',
        environment: 'staging',
        services: {
          audiusWalletClient,
        },
      })

      const discoveryResult = await userSdk.users.createUser({
        metadata: {
          handle: handle,
          name: artistName,
          wallet: identityResult.getAddressString(),
          bio: `${release.labelName}.`,
        },
      })

      // const entropy = localStorage.getItem('hedgehog-entropy-key')
      const encodedUserId = encodeId(discoveryResult.metadata.userId)
      console.log(discoveryResult, encodedUserId)

      // upload profile picture + cover photo
      const updateImageResult = await userSdk.users.updateProfile({
        userId: encodedUserId,
        metadata: {},
        profilePictureFile: imageFile as any,
        coverArtFile: imageFile as any,
      })
      console.log('updateImageResult', updateImageResult)

      // TODO: save user details to db

      // authorize source ddex app
      const grantResult = await userSdk.grants.createGrant({
        userId: encodedUserId,
        appApiKey: source?.ddexKey,
      })
      console.log('grantResult', grantResult)

      // save release with associated audius user
      release.audiusUser = encodedUserId
      releaseRepo.upsert(
        releaseRow.source,
        releaseRow.xmlUrl,
        releaseRow.messageTimestamp,
        release
      )

      await publishRelease(source!, releaseRow, release)

      break
    } catch (e) {
      console.log('attempt', attempt, e)
    }
  }

  process.exit(0)
}

main()

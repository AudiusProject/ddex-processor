import 'dotenv/config'

import { program } from 'commander'
import { cleanupFiles } from './src/cleanupFiles'
import { releaseRepo, userRepo } from './src/db'
import { parseDelivery, reParsePastXml } from './src/parseDelivery'
import {
  prepareTrackMetadatas,
  publishValidPendingReleases,
} from './src/publishRelease'
import { clmReport } from './src/reporting'
import { pollForNewLSRFiles } from './src/reporting_lsr'
import { pollS3 } from './src/s3poller'
import { sync } from './src/s3sync'
import { getSdk } from './src/sdk'
import { startServer } from './src/server'
import { sources } from './src/sources'
import { startUsersPoller } from './src/usersPoller'
import { sleep } from './src/util'

sources.load()

program
  .name('ddexer')
  .description('CLI to process ddex files')
  .version('0.1')
  .option('-d, --debug', 'output extra debugging')

program
  .command('parse')
  .description('Parse DDEX xml and print results')
  .argument('<source>', 'source name to use')
  .argument('<path>', 'path to ddex xml file')
  .action(async (source, p) => {
    const releases = await parseDelivery(source, p)
    console.log(JSON.stringify(releases, undefined, 2))
  })

program
  .command('publish')
  .description('Publish any valid deliveries')
  .action(async () => {
    reParsePastXml()
    await publishValidPendingReleases()
    process.exit(0) // sdk client doesn't know when to quit
  })

program
  .command('publish-to-user')
  .description('Publish a single release to a user')
  .argument('<releaseId>', 'release ID')
  .argument('<userId>', 'encoded user ID to publish to')
  .option(
    '--prepend-artist',
    'Prepend artist name: <artist> - <title>.  Useful for label accounts'
  )
  .action(async (releaseId, userId, opts) => {
    const releaseRow = releaseRepo.get(releaseId)
    const release = releaseRow?._parsed
    if (!releaseRow || !release) {
      throw new Error(`release not found: ${releaseId}`)
    }

    const source = sources.findByName(releaseRow.source)
    const user = userRepo.findOne({
      id: userId,
      apiKey: source?.ddexKey,
    })

    if (!user) {
      throw new Error(`connected user not found: ${userId}`)
    }

    release.audiusUser = userId

    const artistName = release.artists[0].name
    if (opts.prependArtist) {
      if (!release.title.startsWith(artistName)) {
        release.title = `${artistName} - ${release.title}`
      }
      for (const s of release.soundRecordings) {
        if (!s.title.startsWith(artistName)) {
          s.title = `${artistName} - ${s.title}`
        }
      }
    }

    console.log(JSON.stringify(release, undefined, 2))
    console.log('publishing in 5s...')

    await sleep(5_000)

    releaseRepo.upsert(
      releaseRow.source,
      releaseRow.xmlUrl,
      releaseRow.messageTimestamp,
      release
    )

    await publishValidPendingReleases()
    process.exit(0) // sdk client doesn't know when to quit
  })

program
  .command('sync-s3')
  .description('Sync target directory from S3')
  .argument('<path>', 'path after s3:// to sync')
  .action(async (p) => {
    await sync(p)
  })

program
  .command('poll-s3')
  .description('Pull down assets from S3 and process')
  .option('--reset', 'reset cursor, start from beginning')
  .action(async (opts) => {
    await pollS3(opts.reset)
  })

program
  .command('server')
  .description('start server without background processes, useful for dev')
  .action(async () => {
    startServer()
  })

program
  .command('worker')
  .description('start background processes, useful for dev')
  .action(async () => {
    startWorker()
  })

program
  .command('reparse')
  .description('reparse all stored xml')
  .action(async () => {
    reParsePastXml()
  })

program
  .command('start')
  .description('Start both server + background processes')
  .action(async () => {
    startServer()
    startWorker()
  })

program
  .command('delete')
  .description('Delete a release... USE CAUTION')
  .argument('<release_id>', 'release ID to delete')
  .action(async (releaseId) => {
    const releaseRow = releaseRepo.get(releaseId)
    if (!releaseRow) {
      console.warn(`no release for id: ${releaseId}`)
      process.exit(1)
    }

    const release = releaseRow._parsed!
    const userId = release.audiusUser
    if (!releaseRow.entityId) {
      console.warn(`release id ${releaseId} has no entityId`)
      process.exit(1)
    }
    if (!userId) {
      console.warn(`release id ${releaseId} has no audiusUser`)
      process.exit(1)
    }

    const sourceConfig = sources.findByName(releaseRow.source)!
    const sdk = getSdk(sourceConfig)

    console.warn(
      `deleting ${releaseRow.entityType} ${releaseId}: ${release.title}`
    )
    let result: any
    if (releaseRow.entityType == 'album') {
      result = await sdk.albums.deleteAlbum({
        albumId: releaseRow.entityId,
        userId,
      })
    } else {
      result = await sdk.tracks.deleteTrack({
        trackId: releaseRow.entityId,
        userId,
      })
    }
    console.warn(`deleted ${releaseId}`, result)
    process.exit(0)
  })

program
  .command('report-clm')
  .description(
    'Generate CLM report and push to reporting.clm bucket defined in data/sources.json'
  )
  .action(async () => {
    clmReport()
  })

program
  .command('report-lsr')
  .description('Parse LSR files')
  .action(async () => {
    pollForNewLSRFiles()
  })

program
  .command('republish-album')
  .description('issue sdk updates for all album tracks')
  .argument('<release_id>', 'release ID to republish')
  .action(async (releaseId) => {
    const releaseRow = releaseRepo.get(releaseId)
    if (!releaseRow) {
      throw new Error(`Release ID ${releaseId} not found`)
    }
    if (releaseRow.entityType != 'album') {
      throw new Error(`Release ID ${releaseId} must be a published album`)
    }

    console.log(
      'republish',
      releaseId,
      releaseRow.entityType,
      releaseRow.entityId
    )
    const sourceConfig = sources.findByName(releaseRow.source)!
    const sdk = getSdk(sourceConfig)

    // await new Promise((r) => setTimeout(r, 1_000))
    // const sel = await sdk.services.discoveryNodeSelector.getSelectedEndpoint()
    // console.log('selected', sel)
    // await new Promise((r) => setTimeout(r, 1_000))

    // I want to do this but it hangs forever :shrug:
    // const sdkAlbum = await sdk.full.playlists.getPlaylist({
    //   playlistId: releaseRow.entityId!,
    // })

    const IS_PROD = process.env.NODE_ENV == 'production'
    const API_HOST = IS_PROD
      ? 'https://discoveryprovider2.audius.co'
      : 'https://discoveryprovider2.staging.audius.co'

    const albumUrl = `${API_HOST}/v1/full/playlists/${releaseRow.entityId!}`
    const sdkAlbum = await fetch(albumUrl).then((r) => r.json())

    const trackUpdates = prepareTrackMetadatas(
      sourceConfig,
      releaseRow._parsed!
    )

    for (const sdkTrack of sdkAlbum.data![0].tracks) {
      const trackUpdate = trackUpdates.find((s) => s.title == sdkTrack.title)
      if (!trackUpdate) {
        throw new Error(`failed to find track record for: ${sdkTrack.title}`)
      }

      console.log('update track', sdkTrack.id, sdkTrack.title, trackUpdate)

      // this is needed if transcodePreview is true
      // latest.audioUploadId = apiTrack.audio_upload_id

      try {
        await sdk.tracks.updateTrack({
          trackId: sdkTrack.id,
          userId: sdkTrack.user.id,
          metadata: trackUpdate,
          // transcodePreview: false,
        })
      } catch (e) {
        console.log('track update failed', sdkTrack.id, sdkTrack.title, e)
        throw e
      }
    }

    process.exit(0)
  })

program.command('cleanup').description('remove temp files').action(cleanupFiles)

program.parse()

async function startWorker() {
  startUsersPoller().catch(console.error)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(3_000)
    console.log('polling...')
    await pollS3()
    await pollForNewLSRFiles()
    await clmReport()

    // for now we publish manually via CLI
    // because album publish can fail
    // want to have human in loop to clean up orphans tracks when that happens.
    // await publishValidPendingReleases()

    await sleep(10 * 60_000)
  }
}

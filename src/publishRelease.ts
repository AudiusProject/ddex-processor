import { Genre, UploadAlbumRequest, UploadTrackRequest } from '@audius/sdk'
import {
  ReleaseProcessingStatus,
  ReleaseRow,
  assetRepo,
  releaseRepo,
} from './db'
import { DDEXContributor, DDEXRelease, DDEXResource } from './parseDelivery'
import { readAssetWithCaching } from './s3poller'
import { getSdk } from './sdk'
import { SourceConfig, sources } from './sources'
import { decodeId } from './util'

const DEFAULT_TRACK_PRICE = 1.0
const DEFAULT_ALBUM_PRICE = 5.0

export async function publishValidPendingReleases() {
  const rows = releaseRepo.all({ pendingPublish: true })
  if (!rows.length) return

  for (const row of rows) {
    const source = sources.findByName(row.source)
    if (!source) {
      continue
    }
    const parsed = row._parsed!

    if (row.status == ReleaseProcessingStatus.DeletePending) {
      // delete
      deleteRelease(source, row)
    } else if (row.entityId) {
      // update
      if (row.entityType == 'track') {
        await updateTrack(source, row, parsed)
      } else if (row.entityType == 'album') {
        await updateAlbum(source, row, parsed)
      } else {
        console.log('unknown entity type', row.entityType)
      }
    } else {
      // create
      try {
        await publishRelease(source, row, parsed)
      } catch (e: any) {
        console.log('failed to publish', row.key, e)
        releaseRepo.addPublishError(row.key, e)
      }
    }
  }
}

export async function publishRelease(
  source: SourceConfig,
  releaseRow: ReleaseRow,
  release: DDEXRelease
) {
  if (new Date(release.releaseDate) > new Date()) {
    console.log(
      `Skipping future release: ${releaseRow.key} ${release.releaseDate}`
    )
    return
  }

  const skipSdkPublish = process.env.SKIP_SDK_PUBLISH == 'true'

  if (!releaseRow.xmlUrl) {
    throw new Error(`xmlUrl is required to resolve file paths`)
  }

  const sdk = getSdk(source)

  // read asset file
  async function resolveFile({ ref }: DDEXResource) {
    const asset = assetRepo.get(releaseRow.key, ref)
    if (!asset) {
      throw new Error(`failed to resolve asset ${releaseRow.key} ${ref}`)
    }
    return readAssetWithCaching(asset.xmlUrl, asset.filePath, asset.fileName)
  }

  const imageFile = await resolveFile(release.images[0])

  const trackFiles = await Promise.all(
    release.soundRecordings.map((track) => resolveFile(track))
  )

  const trackMetadatas = prepareTrackMetadatas(source, release)

  if (source.placementHosts) {
    for (const t of trackMetadatas) {
      t.placementHosts = source.placementHosts
    }
  }

  // publish album
  if (release.soundRecordings.length > 1) {
    const uploadAlbumRequest: UploadAlbumRequest = {
      coverArtFile: imageFile,
      metadata: prepareAlbumMetadata(source, release),
      trackFiles,
      trackMetadatas,
      userId: release.audiusUser!,
    }

    if (skipSdkPublish) {
      console.log('skipping sdk publish')
      return
    }

    const result = await sdk.albums.uploadAlbum(uploadAlbumRequest)
    console.log(result)

    // on success set publishedAt, entityId, blockhash
    releaseRepo.update({
      key: releaseRow.key,
      status: ReleaseProcessingStatus.Published,
      entityType: 'album',
      entityId: result.albumId!,
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      publishedAt: new Date().toISOString(),
    })

    // return result
  } else if (trackFiles[0]) {
    // publish track

    const metadata = trackMetadatas[0]
    const trackFile = trackFiles[0]

    metadata.ddexReleaseIds = release.releaseIds

    const uploadTrackRequest: UploadTrackRequest = {
      userId: release.audiusUser!,
      metadata,
      coverArtFile: imageFile,
      trackFile,
    }

    if (skipSdkPublish) {
      console.log('skipping sdk publish')
      return
    }

    const result = await sdk.tracks.uploadTrack(uploadTrackRequest)
    console.log(result)

    // on succes: update releases
    releaseRepo.update({
      key: releaseRow.key,
      status: ReleaseProcessingStatus.Published,
      entityType: 'track',
      entityId: result.trackId!,
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      publishedAt: new Date().toISOString(),
    })
  }
}

async function updateTrack(
  source: SourceConfig,
  row: ReleaseRow,
  release: DDEXRelease
) {
  const sdk = getSdk(source)
  const metas = prepareTrackMetadatas(source, release)

  const result = await sdk.tracks.updateTrack({
    userId: release.audiusUser!,
    trackId: row.entityId!,
    metadata: metas[0],
  })

  releaseRepo.update({
    key: row.key,
    status: ReleaseProcessingStatus.Published,
    publishedAt: new Date().toISOString(),
    ...result,
  })

  return result
}

export function prepareTrackMetadatas(
  source: SourceConfig,
  release: DDEXRelease
) {
  const trackMetas: UploadTrackRequest['metadata'][] =
    release.soundRecordings.map((sound) => {
      const audiusGenre = sound.audiusGenre || release.audiusGenre || Genre.ALL

      const releaseDate =
        new Date(sound.releaseDate) ||
        new Date(release.releaseDate) ||
        new Date()

      // use sound copyright, fallback to release copyright
      const copyrightLine = sound.copyrightLine || release.copyrightLine
      const producerCopyrightLine =
        sound.producerCopyrightLine || release.producerCopyrightLine
      const parentalWarningType =
        sound.parentalWarningType || release.parentalWarningType

      const meta: UploadTrackRequest['metadata'] = {
        genre: audiusGenre,
        title: sound.title,
        isrc: release.releaseIds.isrc,
        iswc: release.releaseIds.iswc,
        ddexReleaseIds: release.releaseIds,
        ddexApp: source.name,
        releaseDate,
        copyrightLine,
        producerCopyrightLine,
        parentalWarningType,
        rightsController: sound.rightsController,
        artists: sound.artists.map(mapContributor),
        resourceContributors: sound.contributors.map(mapContributor),
        indirectResourceContributors:
          sound.indirectContributors.map(mapContributor),
      }

      for (const deal of release.deals) {
        if (deal.audiusDealType == 'FollowGated') {
          const cond = { followUserId: release.audiusUser! }
          if (deal.forStream) {
            meta.isStreamGated = true
            meta.streamConditions = cond
          }
          if (deal.forDownload) {
            meta.isDownloadGated = true
            meta.downloadConditions = cond
          }
        }

        if (deal.audiusDealType == 'TipGated') {
          const cond = { tipUserId: release.audiusUser! }
          if (deal.forStream) {
            meta.isStreamGated = true
            meta.streamConditions = cond
          }
          if (deal.forDownload) {
            meta.isDownloadGated = true
            meta.downloadConditions = cond
          }
        }

        if (deal.audiusDealType == 'PayGated') {
          const payTo = source.payoutWallet || decodeId(release.audiusUser!)
          const priceUsd = deal.priceUsd || DEFAULT_TRACK_PRICE
          console.log({ payTo, priceUsd })

          const cond = {
            usdcPurchase: {
              price: priceUsd * 100,
              splits: [{ user_id: payTo, percentage: 100 }],
            },
          }

          if (sound.previewStartSeconds != undefined) {
            meta.previewStartSeconds = sound.previewStartSeconds
          }

          if (deal.forStream) {
            meta.isStreamGated = true
            meta.streamConditions = cond
            if (!meta.previewStartSeconds) {
              meta.previewStartSeconds = 0
            }
          }
          if (deal.forDownload) {
            meta.isDownloadGated = true
            meta.downloadConditions = cond
          }
        }
      }

      // todo: nft gated types

      return meta
    })

  return trackMetas
}

//
// Album
//

async function updateAlbum(
  source: SourceConfig,
  row: ReleaseRow,
  release: DDEXRelease
) {
  const meta = prepareAlbumMetadata(source, release)
  const sdk = getSdk(source)

  const result = await sdk.albums.updateAlbum({
    userId: release.audiusUser!,
    albumId: row.entityId!,
    metadata: meta,
  })

  releaseRepo.update({
    key: row.key,
    status: ReleaseProcessingStatus.Published,
    publishedAt: new Date().toISOString(),
    ...result,
  })

  return result
}

export async function deleteRelease(source: SourceConfig, r: ReleaseRow) {
  const sdk = getSdk(source)
  const userId = r._parsed!.audiusUser!
  const entityId = r.entityId

  // if not yet published to audius, mark internal releases row as deleted
  if (!userId || !entityId) {
    releaseRepo.update({
      key: r.key,
      status: ReleaseProcessingStatus.Deleted,
    })
    return
  }

  if (r.entityType == 'track') {
    const result = await sdk.tracks.deleteTrack({
      trackId: entityId,
      userId,
    })
    return onDeleted(result)
  } else if (r.entityType == 'album') {
    const result = await sdk.albums.deleteAlbum({
      albumId: entityId,
      userId,
    })
    return onDeleted(result)
  }

  function onDeleted(result: any) {
    releaseRepo.update({
      key: r.key,
      status: ReleaseProcessingStatus.Deleted,
      publishedAt: new Date().toISOString(),
      ...result,
    })
    return result
  }
}

export function prepareAlbumMetadata(
  source: SourceConfig,
  release: DDEXRelease
) {
  let releaseDate: Date | undefined
  if (release.releaseDate) {
    releaseDate = new Date(release.releaseDate)
  }
  const meta: UploadAlbumRequest['metadata'] = {
    genre: release.audiusGenre || Genre.ALL,
    albumName: release.title,
    releaseDate,
    ddexReleaseIds: release.releaseIds,
    ddexApp: source.name,
    artists: release.artists.map(mapContributor),
    upc: release.releaseIds.icpn, // ICPN is either UPC (USA/Canada) or EAN (rest of world), but we call them both UPC
    parentalWarningType: release.parentalWarningType,
    copyrightLine: release.copyrightLine,
    producerCopyrightLine: release.producerCopyrightLine,
  }

  for (const deal of release.deals) {
    if (deal.audiusDealType == 'PayGated') {
      const payTo = source.payoutWallet || decodeId(release.audiusUser!)
      const priceUsd = deal.priceUsd || DEFAULT_ALBUM_PRICE

      const cond = {
        usdcPurchase: {
          price: priceUsd * 100,
          splits: [{ user_id: payTo, percentage: 100 }],
        },
      }
      if (deal.forStream) {
        meta.isStreamGated = true
        meta.streamConditions = cond
      }
      if (deal.forDownload) {
        meta.isDownloadGated = true
        meta.downloadConditions = cond
      }
    }
  }

  return meta
}

function mapContributor(c: DDEXContributor) {
  return {
    name: c.name,
    roles: [c.role!], // todo: does ddex xml have multiple roles for a contributor?
  }
}

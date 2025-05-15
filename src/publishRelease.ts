import { UploadAlbumRequest, UploadTrackRequest } from '@audius/sdk'
import Web3 from 'web3'
import {
  ReleaseProcessingStatus,
  ReleaseRow,
  assetRepo,
  releaseRepo,
} from './db'
import { publogRepo } from './db/publogRepo'
import { DDEXContributor, DDEXRelease, DDEXResource } from './parseDelivery'
import { readAssetWithCaching } from './s3poller'
import { getSdk } from './sdk'
import { SourceConfig, sources } from './sources'
import { decodeId } from './util'

const DEFAULT_TRACK_PRICE = 1.0
const DEFAULT_ALBUM_PRICE = 5.0

export async function publishValidPendingReleases() {
  const rows = await releaseRepo.all({ pendingPublish: true })
  if (!rows.length) return

  for (const row of rows) {
    const source = sources.findByName(row.source)
    if (!source) {
      continue
    }
    const parsed = row

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
        await releaseRepo.addPublishError(row.key, e)
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

  if (!releaseRow.xmlUrl) {
    throw new Error(`xmlUrl is required to resolve file paths`)
  }

  const sdk = getSdk(source)

  // read asset file
  async function resolveFile({ ref }: DDEXResource) {
    const asset = await assetRepo.get(source.name, releaseRow.key, ref)
    if (!asset) {
      throw new Error(`failed to resolve asset ${releaseRow.key} ${ref}`)
    }
    return readAssetWithCaching(asset.xmlUrl, asset.filePath, asset.fileName)
  }

  const imageFile = await resolveFile(release.images[0])

  const trackFiles = await Promise.all(
    release.soundRecordings.map((track) => resolveFile(track))
  )

  const trackMetadatas = prepareTrackMetadatas(source, releaseRow, release)

  if (source.placementHosts) {
    for (const t of trackMetadatas) {
      t.placementHosts = source.placementHosts
    }
  }

  console.log('publishing', trackMetadatas)

  // publish album
  if (release.soundRecordings.length > 1) {
    const uploadAlbumRequest: UploadAlbumRequest = {
      coverArtFile: imageFile as any,
      metadata: prepareAlbumMetadata(source, releaseRow, release),
      trackFiles: trackFiles as any,
      trackMetadatas,
      userId: release.audiusUser!,
    }

    const result = await sdk.albums.uploadAlbum(uploadAlbumRequest)
    console.log('album published', result)

    await publogRepo.log({
      release_id: releaseRow.key,
      msg: 'album publish result',
      extra: result,
    })

    // on success set publishedAt, entityId, blockhash
    await releaseRepo.update({
      key: releaseRow.key,
      status: ReleaseProcessingStatus.Published,
      entityType: 'album',
      entityId: result.albumId!,
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      publishedAt: new Date().toISOString(),
    })

    // todo: poll for result to ensure it's actually created

    // return result
  } else if (trackFiles[0]) {
    // publish track

    const metadata = trackMetadatas[0]
    const trackFile = trackFiles[0]

    metadata.ddexReleaseIds = release.releaseIds

    const uploadTrackRequest: UploadTrackRequest = {
      userId: release.audiusUser!,
      metadata,
      coverArtFile: imageFile as any,
      trackFile: trackFile as any,
    }

    const result = await sdk.tracks.uploadTrack(uploadTrackRequest)
    console.log('track published', result)

    await publogRepo.log({
      release_id: releaseRow.key,
      msg: 'track publish result',
      extra: result,
    })

    // on succes: update releases
    await releaseRepo.update({
      key: releaseRow.key,
      status: ReleaseProcessingStatus.Published,
      entityType: 'track',
      entityId: result.trackId!,
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      publishedAt: new Date().toISOString(),
    })

    // todo: poll for result to ensure it's actually created
  }
}

export async function updateTrack(
  source: SourceConfig,
  row: ReleaseRow,
  release: DDEXRelease
) {
  const sdk = getSdk(source)
  const metas = prepareTrackMetadatas(source, row, release)

  const result = await sdk.tracks.updateTrack({
    userId: release.audiusUser!,
    trackId: row.entityId!,
    metadata: metas[0],
  })

  await releaseRepo.update({
    key: row.key,
    status: ReleaseProcessingStatus.Published,
    publishedAt: new Date().toISOString(),
    ...result,
  })

  return result
}

export function prepareTrackMetadatas(
  source: SourceConfig,
  releaseRow: ReleaseRow,
  release: DDEXRelease
) {
  const trackMetas: UploadTrackRequest['metadata'][] =
    release.soundRecordings.map((sound) => {
      const audiusGenre = release.audiusGenre || sound.audiusGenre

      if (!audiusGenre) {
        throw `missing audiusGenre for ${releaseRow.key}`
      }

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

      let title = [sound.title, sound.subTitle].filter(Boolean).join(' ')
      if (releaseRow.prependArtist) {
        title = release.artists[0].name + ' - ' + title
      }

      const meta: UploadTrackRequest['metadata'] = {
        genre: audiusGenre,
        title,
        isrc: release.releaseIds.isrc,
        iswc: release.releaseIds.iswc,
        ddexReleaseIds: release.releaseIds,
        ddexApp: Web3.utils.toChecksumAddress(source.ddexKey),
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
          const cond = { followUserId: decodeId(release.audiusUser!) }
          if (deal.forStream) {
            meta.isStreamGated = true
            meta.streamConditions = cond
          }
          if (deal.forDownload) {
            meta.isDownloadable = true
            meta.isDownloadGated = true
            meta.downloadConditions = cond
          }
        }

        if (deal.audiusDealType == 'TipGated') {
          const cond = { tipUserId: decodeId(release.audiusUser!) }
          if (deal.forStream) {
            meta.isStreamGated = true
            meta.streamConditions = cond
          }
          if (deal.forDownload) {
            meta.isDownloadable = true
            meta.isDownloadGated = true
            meta.downloadConditions = cond
          }
        }

        if (deal.audiusDealType == 'PayGated') {
          const payTo =
            source.labelUserIds[release.labelName] ||
            source.payoutUserId ||
            release.audiusUser!
          const priceUsd = deal.priceUsd || DEFAULT_TRACK_PRICE
          console.log({ payTo, priceUsd })

          const cond = {
            usdcPurchase: {
              price: priceUsd * 100,
              splits: [{ user_id: decodeId(payTo), percentage: 100 }],
            },
          }

          if (sound.previewStartSeconds != undefined) {
            meta.previewStartSeconds = sound.previewStartSeconds
          }

          if (sound.isrc) {
            meta.isrc = sound.isrc
          }

          // apply any conditions to both stream + download
          // or indexer will say:
          // failed to process transaction error Track N is stream gated but not download gated
          if (deal.forStream || deal.forDownload) {
            meta.isStreamGated = true
            meta.streamConditions = cond
            if (!meta.previewStartSeconds) {
              meta.previewStartSeconds = 0
            }

            meta.isDownloadable = true
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

export async function updateAlbum(
  source: SourceConfig,
  row: ReleaseRow,
  release: DDEXRelease
) {
  const meta = prepareAlbumMetadata(source, row, release)
  const sdk = getSdk(source)

  const result = await sdk.albums.updateAlbum({
    userId: release.audiusUser!,
    albumId: row.entityId!,
    metadata: meta,
  })

  await releaseRepo.update({
    key: row.key,
    status: ReleaseProcessingStatus.Published,
    publishedAt: new Date().toISOString(),
    ...result,
  })

  return result
}

export async function deleteRelease(source: SourceConfig, r: ReleaseRow) {
  const sdk = getSdk(source)
  const userId = r.audiusUser!
  const entityId = r.entityId

  // if not yet published to audius, mark internal releases row as deleted
  if (!userId || !entityId) {
    await releaseRepo.update({
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

  async function onDeleted(result: any) {
    await releaseRepo.update({
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
  releaseRow: ReleaseRow,
  release: DDEXRelease
) {
  let releaseDate: Date | undefined
  if (release.releaseDate) {
    releaseDate = new Date(release.releaseDate)
  }
  let title = [release.title, release.subTitle].filter(Boolean).join(' ')
  if (releaseRow.prependArtist) {
    title = release.artists[0].name + ' - ' + title
  }

  if (!release.audiusGenre) {
    throw `missing audiusGenre for ${releaseRow.key}`
  }

  const meta: UploadAlbumRequest['metadata'] = {
    genre: release.audiusGenre,
    albumName: title,
    releaseDate,
    ddexReleaseIds: release.releaseIds,
    ddexApp: Web3.utils.toChecksumAddress(source.ddexKey),
    artists: release.artists.map(mapContributor),
    upc: release.releaseIds.icpn, // ICPN is either UPC (USA/Canada) or EAN (rest of world), but we call them both UPC
    parentalWarningType: release.parentalWarningType,
    copyrightLine: release.copyrightLine,
    producerCopyrightLine: release.producerCopyrightLine,
  }

  for (const deal of release.deals) {
    if (deal.audiusDealType == 'PayGated') {
      const payTo =
        source.labelUserIds[release.labelName] ||
        source.payoutUserId ||
        release.audiusUser!

      const defaultPrice = Math.min(
        DEFAULT_ALBUM_PRICE,
        release.soundRecordings.length
      )
      const priceUsd = deal.priceUsd || defaultPrice

      const cond = {
        usdcPurchase: {
          price: priceUsd * 100,
          splits: [{ user_id: decodeId(payTo), percentage: 100 }],
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

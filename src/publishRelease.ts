import type {
  CreateAlbumMetadata,
  UploadTrackRequest,
} from '@audius/sdk'
import { fromBuffer as fileTypeFromBuffer } from 'file-type'
import Web3 from 'web3'
import {
  ClaimableHandleRequiredError,
  ClaimableRecoveryRequiredError,
  publishToClaimableAccount,
} from './claimable/createUserPublish'
import {
  ReleaseProcessingStatus,
  ReleaseRow,
  assetRepo,
  releaseRepo,
} from './db'
import { publogRepo } from './db/publogRepo'
import {
  DDEXContributor,
  DDEXRelease,
  DDEXResource,
  DealPayGated,
} from './parseDelivery'
import { readAssetWithCaching } from './s3poller'
import { getSdk } from './sdk'
import { SourceConfig, sources } from './sources'
import { decodeId, encodeId } from './util'

const DEFAULT_TRACK_PRICE = 1.0
const DEFAULT_ALBUM_PRICE = 5.0
type SdkNodeFile = {
  buffer: Buffer
  name?: string
  type?: string
}
type CachedAssetData =
  | Awaited<ReturnType<typeof readAssetWithCaching>>
  | Buffer
  | Uint8Array

function normalizeAssetBuffer(assetData: CachedAssetData): Buffer {
  if (Buffer.isBuffer(assetData)) return assetData
  if (assetData instanceof Uint8Array) return Buffer.from(assetData)
  return Buffer.isBuffer(assetData.buffer)
    ? assetData.buffer
    : Buffer.from(assetData.buffer)
}

export const DEFAULT_TRACK_DEAL: DealPayGated = {
  audiusDealType: 'PayGated',
  forStream: true,
  forDownload: true,
  priceUsd: DEFAULT_TRACK_PRICE,
  validityStartDate: new Date().toISOString(),
}
export const DEFAULT_ALBUM_DEAL: DealPayGated = {
  audiusDealType: 'PayGated',
  forStream: true,
  forDownload: true,
  priceUsd: DEFAULT_ALBUM_PRICE,
  validityStartDate: new Date().toISOString(),
}

export async function publishValidPendingReleases() {
  const rows = await releaseRepo.all({ pendingPublish: true })
  if (!rows.length) return

  for (const row of rows) {
    const source = sources.findByName(row.source)
    if (!source) {
      continue
    }
    if (!row.audiusUser) {
      if (source.autoPublish) {
        try {
          await publishToClaimableAccount(row.key)
        } catch (e: any) {
          console.log('auto-publish failed', row.key, e)
          if (
            e instanceof ClaimableHandleRequiredError ||
            e instanceof ClaimableRecoveryRequiredError
          ) {
            await releaseRepo.addPublishBlock(row.key, e)
          } else {
            await releaseRepo.addPublishError(row.key, e)
          }
        }
      }
      continue
    }
    const parsed = row

    if (row.status == ReleaseProcessingStatus.DeletePending) {
      try {
        await deleteRelease(source, row)
      } catch (e: any) {
        console.log('failed to delete', row.key, e)
        await releaseRepo.addPublishError(row.key, e)
      }
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

  const imageFile = await resolveReleaseAssetFile(
    source,
    releaseRow,
    release.images[0]
  )

  const trackFiles = await Promise.all(
    release.soundRecordings.map((track) =>
      resolveReleaseAssetFile(source, releaseRow, track)
    )
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
    const trackIds = await publishAlbumTracks(
      releaseRow,
      release,
      imageFile,
      trackFiles,
      trackMetadatas
    )
    const albumId = await ensurePlannedEntityId(releaseRow, 'album', async () =>
      encodeId(await sdk.playlists.generatePlaylistId())
    )

    const metadata = {
      ...prepareAlbumMetadata(source, releaseRow, release),
      playlistId: albumId,
      playlistContents: buildPlaylistContents(trackIds),
    }

    const result = await sdk.albums.createAlbum({
      imageFile: imageFile as any,
      metadata: metadata as any,
      userId: release.audiusUser!,
    } as any)
    const resultAlbumId = (result as any).albumId || result.playlistId
    if (!resultAlbumId) {
      throw new Error('album publish response missing playlistId')
    }
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
      entityId: resultAlbumId,
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      publishedAt: new Date().toISOString(),
      plannedEntityType: null,
      plannedEntityId: null,
      plannedTrackIds: null,
      partialTrackIds: null,
    })

    // media stays in S3 for a grace period after publishing; the
    // purgeOldPublishedMedia worker routine reclaims it later.

    // todo: poll for result to ensure it's actually created

    // return result
  } else if (trackFiles[0]) {
    // publish track

    const metadata = trackMetadatas[0]
    const trackFile = trackFiles[0]

    metadata.ddexReleaseIds = release.releaseIds
    metadata.trackId = await ensurePlannedEntityId(
      releaseRow,
      'track',
      async () => encodeId(await sdk.tracks.generateTrackId())
    )

    const uploadTrackRequest: UploadTrackRequest = {
      userId: release.audiusUser!,
      metadata,
      imageFile: imageFile as any,
      audioFile: trackFile as any,
    }

    const result = await sdk.tracks.createTrack(uploadTrackRequest as any)
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
      plannedEntityType: null,
      plannedEntityId: null,
    })

    // media stays in S3 for a grace period after publishing; the
    // purgeOldPublishedMedia worker routine reclaims it later.

    // todo: poll for result to ensure it's actually created
  }

  async function publishAlbumTracks(
    releaseRow: ReleaseRow,
    release: DDEXRelease,
    imageFile: Awaited<ReturnType<typeof resolveReleaseAssetFile>>,
    trackFiles: Awaited<ReturnType<typeof resolveReleaseAssetFile>>[],
    trackMetadatas: UploadTrackRequest['metadata'][]
  ) {
    const partialTrackIds = Array.isArray(releaseRow.partialTrackIds)
      ? releaseRow.partialTrackIds.slice(0, release.soundRecordings.length)
      : []
    const plannedTrackIds = Array.isArray(releaseRow.plannedTrackIds)
      ? releaseRow.plannedTrackIds.slice(0, release.soundRecordings.length)
      : []
    for (let i = 0; i < partialTrackIds.length; i++) {
      plannedTrackIds[i] ||= partialTrackIds[i]
    }

    if (partialTrackIds.length === release.soundRecordings.length) {
      console.log('using partial album track ids', {
        releaseKey: releaseRow.key,
        count: partialTrackIds.length,
      })
      return partialTrackIds
    }

    for (
      let i = partialTrackIds.length;
      i < release.soundRecordings.length;
      i++
    ) {
      const trackFile = trackFiles[i]
      const metadata = trackMetadatas[i]
      if (!trackFile || !metadata) {
        throw new Error(
          `missing album track data for ${releaseRow.key} index ${i}`
        )
      }
      const plannedTrackId = await ensurePlannedTrackId(
        releaseRow,
        plannedTrackIds,
        i,
        async () => encodeId(await sdk.tracks.generateTrackId())
      )

      const trackResult = await sdk.tracks.createTrack({
        userId: release.audiusUser!,
        metadata: {
          ...metadata,
          trackId: plannedTrackId,
        },
        imageFile: imageFile as any,
        audioFile: trackFile as any,
      } as any)

      if (!trackResult.trackId) {
        throw new Error(
          `album track publish missing trackId for ${releaseRow.key} index ${i}`
        )
      }

      partialTrackIds.push(trackResult.trackId)
      await releaseRepo.update({
        key: releaseRow.key,
        partialTrackIds: [...partialTrackIds],
      })
      await publogRepo.log({
        release_id: releaseRow.key,
        msg: 'album track publish result',
        extra: {
          index: i,
          trackId: trackResult.trackId,
          blockNumber: trackResult.blockNumber,
          blockHash: trackResult.blockHash,
        },
      })
    }

    return partialTrackIds
  }
}

async function ensurePlannedEntityId(
  releaseRow: ReleaseRow,
  entityType: NonNullable<ReleaseRow['plannedEntityType']>,
  generateId: () => Promise<string>
) {
  if (
    releaseRow.plannedEntityId &&
    releaseRow.plannedEntityType === entityType
  ) {
    return releaseRow.plannedEntityId
  }

  const plannedEntityId = await generateId()
  await releaseRepo.update({
    key: releaseRow.key,
    plannedEntityType: entityType,
    plannedEntityId,
  })
  return plannedEntityId
}

async function ensurePlannedTrackId(
  releaseRow: ReleaseRow,
  plannedTrackIds: string[],
  index: number,
  generateId: () => Promise<string>
) {
  if (plannedTrackIds[index]) {
    return plannedTrackIds[index]
  }

  plannedTrackIds[index] = await generateId()
  await releaseRepo.update({
    key: releaseRow.key,
    plannedTrackIds: [...plannedTrackIds],
  })
  return plannedTrackIds[index]
}

export async function updateTrack(
  source: SourceConfig,
  row: ReleaseRow,
  release: DDEXRelease
) {
  const sdk = getSdk(source)
  const metas = prepareTrackMetadatas(source, row, release)
  const imageFile = await resolveReleaseAssetFile(
    source,
    row,
    release.images[0]
  )

  const result = await sdk.tracks.updateTrack({
    userId: release.audiusUser!,
    trackId: row.entityId!,
    metadata: metas[0] as any,
    imageFile: imageFile as any,
  })

  await releaseRepo.update({
    key: row.key,
    status: ReleaseProcessingStatus.Published,
    publishedAt: new Date().toISOString(),
    ...sdkWriteResultFields(result),
  })

  return result
}

function toValidDate(val: string | undefined): Date | undefined {
  if (!val) return undefined
  const d = new Date(val)
  return isNaN(d.getTime()) ? undefined : d
}

function buildPlaylistContents(trackIds: string[]) {
  const timestamp = Math.floor(Date.now() / 1000)
  return trackIds.map((trackId) => ({
    trackId,
    timestamp,
  }))
}

function sdkWriteResultFields(result: {
  blockHash?: string
  blockNumber?: number
}): Partial<Pick<ReleaseRow, 'blockHash' | 'blockNumber'>> {
  return {
    ...(result.blockHash ? { blockHash: result.blockHash } : {}),
    ...(result.blockNumber !== undefined
      ? { blockNumber: result.blockNumber }
      : {}),
  }
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
        toValidDate(sound.releaseDate) ||
        toValidDate(release.releaseDate) ||
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
      if (releaseRow.useDefaultDeal) {
        release.deals = [DEFAULT_TRACK_DEAL]
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

          const cond = {
            usdcPurchase: {
              price: priceUsd * 100,
              splits: [{ userId: decodeId(payTo), percentage: 100 }],
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
      // todo: artist coin gated types

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
  const imageFile = await resolveReleaseAssetFile(
    source,
    row,
    release.images[0]
  )

  const result = await sdk.albums.updateAlbum({
    userId: release.audiusUser!,
    albumId: row.entityId!,
    metadata: meta,
    imageFile: imageFile as any,
  })

  await releaseRepo.update({
    key: row.key,
    status: ReleaseProcessingStatus.Published,
    publishedAt: new Date().toISOString(),
    ...sdkWriteResultFields(result),
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
    await deleteAlbumTracks(source, sdk, entityId, userId)
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

export async function deleteAlbumTracks(
  source: SourceConfig,
  sdk: ReturnType<typeof getSdk>,
  albumId: string,
  userId: string
) {
  const trackIds = await fetchAlbumTrackIds(source, albumId)

  for (const trackId of trackIds) {
    console.log('delete album track', trackId)
    await sdk.tracks.deleteTrack({
      trackId,
      userId,
    })
  }
}

export async function fetchAlbumTrackIds(
  source: SourceConfig,
  albumId: string
) {
  const apiHost =
    source.env === 'production'
      ? 'https://api.audius.co'
      : 'https://api.staging.audius.co'
  const resp = await fetch(`${apiHost}/v1/full/playlists/${albumId}`, {
    headers: { accept: 'application/json' },
  })

  if (!resp.ok) {
    throw new Error(`failed to fetch album ${albumId}: ${resp.status}`)
  }

  const json = await resp.json()
  const album = json.data?.[0]
  if (!album) {
    throw new Error(`failed to fetch album ${albumId}: no album returned`)
  }

  return (album.tracks || []).map((track: any) => track.id).filter(Boolean)
}

export function prepareAlbumMetadata(
  source: SourceConfig,
  releaseRow: ReleaseRow,
  release: DDEXRelease
) {
  const releaseDate = toValidDate(release.releaseDate)
  let title = [release.title, release.subTitle].filter(Boolean).join(' ')
  if (releaseRow.prependArtist) {
    title = release.artists[0].name + ' - ' + title
  }
  if (releaseRow.useDefaultDeal) {
    release.deals = [DEFAULT_ALBUM_DEAL]
  }

  if (!release.audiusGenre) {
    throw `missing audiusGenre for ${releaseRow.key}`
  }

  const meta: CreateAlbumMetadata = {
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
          splits: [{ userId: decodeId(payTo), percentage: 100 }],
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

async function resolveReleaseAssetFile(
  source: SourceConfig,
  releaseRow: ReleaseRow,
  { ref }: DDEXResource
): Promise<SdkNodeFile> {
  const asset = await assetRepo.get(source.name, releaseRow.key, ref)
  if (!asset) {
    throw new Error(`failed to resolve asset ${releaseRow.key} ${ref}`)
  }
  const assetData = await readAssetWithCaching(
    asset.xmlUrl,
    asset.filePath,
    asset.fileName
  )
  const buffer = normalizeAssetBuffer(assetData)
  const detected = await fileTypeFromBuffer(buffer)
  return {
    buffer,
    name: asset.fileName,
    ...(detected?.mime ? { type: detected.mime } : {}),
  }
}

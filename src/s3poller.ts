import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3'
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import sharp from 'sharp'
import { assetRepo, ReleaseRow, releaseRepo, s3markerRepo } from './db'
import { parseDdexXml } from './parseDelivery'
import { BucketConfig, SourceConfig, sources } from './sources'

type AccessKey = string

const s3clients: Record<AccessKey, S3Client> = {}

export function dialS3(sourceConfig: BucketConfig) {
  const { awsKey, awsSecret, awsRegion } = sourceConfig
  if (!s3clients[awsKey]) {
    const config: S3ClientConfig = {
      credentials: {
        accessKeyId: awsKey,
        secretAccessKey: awsSecret,
      },
      region: awsRegion,
    }
    s3clients[awsKey] = new S3Client(config)
  }
  return s3clients[awsKey]
}

export async function pollS3(reset?: boolean, options?: { bucket?: string }) {
  const configs = sources.all().filter((s) => s.awsBucket)
  const toPoll = options?.bucket
    ? configs.filter((s) => s.awsBucket === options.bucket)
    : configs
  if (options?.bucket && toPoll.length === 0) {
    console.log(`no source found for bucket ${options.bucket}`)
    return
  }
  for (const sourceConfig of toPoll) {
    if (!sourceConfig.awsBucket) continue
    await pollS3Source(sourceConfig, reset)
  }
}

export async function pollS3Source(
  sourceConfig: SourceConfig,
  reset?: boolean
) {
  if (!sourceConfig.awsBucket) {
    console.log(`skipping non-s3 source: ${sourceConfig.name}`)
    return
  }

  const client = dialS3(sourceConfig)
  const bucket = sourceConfig.awsBucket
  const sourceName = sourceConfig.name

  // reset clears marker and listing_prefix so we re-detect structure
  if (reset) {
    await s3markerRepo.reset(bucket)
  }

  let listingPrefix: string | null = await s3markerRepo.getListingPrefix(bucket)

  // detect structure once if not yet set (only sets listing_prefix, preserves marker)
  if (listingPrefix === null) {
    const detect = await client.send(
      new ListObjectsCommand({
        Bucket: bucket,
        Delimiter: '/',
      })
    )
    const topPrefixes = (detect.CommonPrefixes?.map((p) => p.Prefix).filter(Boolean) || []) as string[]
    if (topPrefixes.length === 1 && topPrefixes[0] === 'releases/') {
      listingPrefix = 'releases/'
      console.log(`detected releases/ structure for ${bucket}`)
    } else {
      listingPrefix = ''
      console.log(`detected root structure for ${bucket}`)
    }
    // only set listing_prefix; preserve existing marker
    const existingMarker = await s3markerRepo.get(bucket)
    await s3markerRepo.upsert(bucket, existingMarker, listingPrefix)
  }

  // load marker for incremental polling (skip if rescanAll — always start from beginning)
  let marker = sourceConfig.rescanAll ? undefined : await s3markerRepo.get(bucket)
  const lastModified = sourceConfig.rescanAll
    ? await s3markerRepo.getLastModified(bucket)
    : null
  let maxLastModified: Date | null = null
  let pageCount = 0

  while (true) {
    const result = await client.send(
      new ListObjectsCommand({
        Bucket: bucket,
        Delimiter: '/',
        Prefix: listingPrefix || undefined,
        Marker: marker || undefined,
      })
    )

    const prefixes = (result.CommonPrefixes?.map((p) => p.Prefix).filter(Boolean) || []) as string[]
    const contents = result.Contents || []

    pageCount++
    console.log(
      `polling s3 ${bucket} prefix=${listingPrefix || '(root)'} page=${pageCount} got ${prefixes.length} prefixes and ${contents.length} files`
    )

    if (prefixes.length > 0) {
      const batchSize = 20
      for (let i = 0; i < prefixes.length; i += batchSize) {
        const batch = prefixes.slice(i, i + batchSize)
        const results = await Promise.all(
          batch.map((prefix) =>
            scanS3Prefix(sourceName, client, bucket, prefix, lastModified)
          )
        )
        for (const ts of results) {
          if (ts && (!maxLastModified || ts > maxLastModified)) {
            maxLastModified = ts
          }
        }
      }
    } else if (contents.length > 0) {
      await processS3Contents(sourceName, client, bucket, contents)
    }

    // persist marker for incremental polling; next poll continues from here
    const nextMarker =
      result.NextMarker ||
      prefixes.at(-1) ||
      contents.at(-1)?.Key ||
      undefined
    if (nextMarker && !sourceConfig.rescanAll) {
      // only update marker; preserve listing_prefix
      await s3markerRepo.upsert(bucket, nextMarker)
    }
    if (!result.IsTruncated || !nextMarker) break
    marker = nextMarker
  }

  // for rescanAll sources, persist the max LastModified we saw
  if (sourceConfig.rescanAll && maxLastModified) {
    const existingMarker = await s3markerRepo.get(bucket)
    await s3markerRepo.upsert(bucket, existingMarker, undefined, maxLastModified)
  }
}

// Helper function to process S3 objects (XML files)
async function processS3Contents(
  source: string,
  client: S3Client,
  bucket: string,
  contents: any[]
) {
  for (const c of contents) {
    if (!c.Key) continue

    const lowerKey = c.Key.toLowerCase()
    if (!lowerKey.endsWith('.xml') || lowerKey.includes('batchcomplete')) {
      continue
    }

    const xmlUrl = `s3://` + join(bucket, c.Key)
    const { Body } = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: c.Key,
      })
    )
    const xml = await Body?.transformToString()
    if (xml) {
      console.log('parsing', xmlUrl)
      try {
        await parseDdexXml(source, xmlUrl, xml)
      } catch (e) {
        // Don't let one malformed XML kill the worker — log and move on.
        // The error has already been logged inside parseDdexXml.
        console.error('skipping unparseable XML', xmlUrl, e)
      }
    }
  }
}

// recursively scan a prefix for xml files
// returns the max LastModified date found in this prefix (for rescanAll tracking)
async function scanS3Prefix(
  source: string,
  client: S3Client,
  bucket: string,
  prefix: string,
  lastModifiedCutoff?: Date | null
): Promise<Date | null> {
  const result = await client.send(
    new ListObjectsCommand({
      Bucket: bucket,
      Prefix: prefix,
    })
  )
  if (!result.Contents?.length) {
    return null
  }

  // find the newest object in this prefix
  let maxLastModified: Date | null = null
  for (const c of result.Contents) {
    if (c.LastModified && (!maxLastModified || c.LastModified > maxLastModified)) {
      maxLastModified = c.LastModified
    }
  }

  // skip if nothing is newer than our cutoff
  if (lastModifiedCutoff && maxLastModified && maxLastModified <= lastModifiedCutoff) {
    return null
  }

  await processS3Contents(source, client, bucket, result.Contents)
  return maxLastModified
}

//
// s3 file helper
//
export async function readAssetWithCaching(
  xmlUrl: string,
  filePath: string,
  fileName: string,
  imageSize: string = '',
  skipRead?: boolean
) {
  const pathPart = filePath ? `${filePath}${fileName}` : fileName // empty filePath = current dir
  // read from s3 + cache to local disk
  if (xmlUrl.startsWith('s3:')) {
    const cacheBaseDir = `/tmp/ddex_cache`
    const s3url = new URL(pathPart, xmlUrl)
    const Bucket = s3url.host
    const Key = decodeURIComponent(s3url.pathname.substring(1))
    const destinationPath = join(
      ...[cacheBaseDir, Bucket, imageSize, Key].filter(Boolean)
    )

    // fetch if needed. a 0-byte file on disk indicates a prior failed/partial
    // write and must be treated as a cache miss, otherwise the SDK rejects the
    // empty buffer with "Audio file has invalid file type".
    let cached = await fileExists(destinationPath)
    if (cached) {
      const st = await stat(destinationPath)
      if (st.size === 0) cached = false
    }
    if (!cached) {
      const source = sources.findByXmlUrl(xmlUrl)
      const s3 = dialS3(source)
      await mkdir(dirname(destinationPath), { recursive: true })
      const { Body, ContentLength } = await s3.send(
        new GetObjectCommand({ Bucket, Key })
      )
      const parsedSize = parseInt(imageSize)
      if (parsedSize) {
        try {
          console.log(`resizing ${destinationPath}`)
          await sharp(await Body!.transformToByteArray())
            .resize(parsedSize, parsedSize)
            .toFile(destinationPath)
        } catch (e) {
          console.log(
            `failed to resize image`,
            xmlUrl,
            filePath,
            fileName,
            imageSize
          )
          return {
            name: '',
            buffer: new Uint8Array(),
          }
        }
      } else {
        // write to a sibling .part file then atomically rename, so a partial
        // download never poisons the cache for subsequent reads
        const tmpPath = `${destinationPath}.part`
        try {
          await writeFile(tmpPath, Body as any)
          if (typeof ContentLength === 'number') {
            const written = (await stat(tmpPath)).size
            if (written !== ContentLength) {
              throw new Error(
                `s3 download size mismatch for ${Bucket}/${Key}: expected ${ContentLength}, got ${written}`
              )
            }
          }
          await rename(tmpPath, destinationPath)
        } catch (e) {
          await unlink(tmpPath).catch(() => {})
          throw e
        }
      }
    }

    if (skipRead)
      return {
        name: '',
        buffer: new Uint8Array(),
      }

    return readFileToBuffer(destinationPath)
  }

  // read from local disk
  const fileUrl = resolve(xmlUrl, '..', pathPart)
  return readFileToBuffer(fileUrl)
}

// sdk helpers
async function readFileToBuffer(filePath: string) {
  const buffer = await readFile(filePath)
  const name = basename(filePath)
  return { buffer, name }
}

async function fileExists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function parseS3Url(s3Url: string): { bucket: string; key: string } {
  const match = s3Url.match(/^s3:\/\/([^\/]+)\/(.+)$/)
  if (!match) throw new Error('Invalid S3 URL format')
  return { bucket: match[1], key: match[2] }
}

// Delete all S3 media (images + sound recordings) for a release, clear local
// /tmp cache copies, and mark the release as mediaDeletedAt = now.
// Safe to call repeatedly: missing assets / S3 keys are tolerated.
export async function deleteReleaseMedia(release: ReleaseRow) {
  if (release.mediaDeletedAt) return

  const refs = [
    ...release.images.map((r) => r.ref),
    ...release.soundRecordings.map((r) => r.ref),
  ]
  for (const ref of refs) {
    if (!ref) continue
    const asset = await assetRepo.get(release.source, release.key, ref)
    if (!asset) continue
    if (!asset.xmlUrl.startsWith('s3:')) continue

    const pathPart = asset.filePath
      ? `${asset.filePath}${asset.fileName}`
      : asset.fileName
    const s3url = new URL(pathPart, asset.xmlUrl)
    const Bucket = s3url.host
    const Key = decodeURIComponent(s3url.pathname.substring(1))

    try {
      const source = sources.findByXmlUrl(asset.xmlUrl)
      const s3 = dialS3(source)
      await s3.send(new DeleteObjectCommand({ Bucket, Key }))
    } catch (e) {
      console.log(`deleteReleaseMedia: s3 delete failed for ${Bucket}/${Key}`, e)
    }

    // also drop any local cache copies (full + resized variants)
    const cacheRoot = `/tmp/ddex_cache/${Bucket}`
    try {
      const fullPath = join(cacheRoot, Key)
      await rm(fullPath, { force: true })
    } catch {}
    // resized variants live at /tmp/ddex_cache/<bucket>/<size>/<key>;
    // we only know sizes when callers request them, so nuke any sibling
    // size directories that contain the same Key path.
    try {
      const sizeDirs = ['200', '480', '1000']
      for (const s of sizeDirs) {
        await rm(join(cacheRoot, s, Key), { force: true })
      }
    } catch {}
  }

  await releaseRepo.markMediaDeleted(release.key)
}

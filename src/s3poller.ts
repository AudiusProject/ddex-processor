import {
  GetObjectCommand,
  ListObjectsCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import sharp from 'sharp'
import { s3markerRepo } from './db'
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

  // detect structure once if not yet set
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
    await s3markerRepo.upsert(bucket, '', listingPrefix)
  }

  let nextMarker: string | undefined = ''
  let pageCount = 0

  while (true) {
    const result = await client.send(
      new ListObjectsCommand({
        Bucket: bucket,
        Delimiter: '/',
        Prefix: listingPrefix || undefined,
        Marker: nextMarker || undefined,
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
        await Promise.all(
          batch.map((prefix) => scanS3Prefix(sourceName, client, bucket, prefix))
        )
      }
    } else if (contents.length > 0) {
      await processS3Contents(sourceName, client, bucket, contents)
    }

    // paginate with NextMarker; do not persist across polls so we re-scan for new releases next time
    if (!result.IsTruncated) break
    nextMarker =
      result.NextMarker ||
      prefixes.at(-1) ||
      contents.at(-1)?.Key ||
      undefined
    if (!nextMarker) break
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
      const releases = (await parseDdexXml(source, xmlUrl, xml)) || []
    }
  }
}

// recursively scan a prefix for xml files
async function scanS3Prefix(
  source: string,
  client: S3Client,
  bucket: string,
  prefix: string
) {
  const result = await client.send(
    new ListObjectsCommand({
      Bucket: bucket,
      Prefix: prefix,
    })
  )
  if (!result.Contents?.length) {
    return
  }

  await processS3Contents(source, client, bucket, result.Contents)
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

    // fetch if needed
    const exists = await fileExists(destinationPath)
    if (!exists) {
      const source = sources.findByXmlUrl(xmlUrl)
      const s3 = dialS3(source)
      await mkdir(dirname(destinationPath), { recursive: true })
      const { Body } = await s3.send(new GetObjectCommand({ Bucket, Key }))
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
        await writeFile(destinationPath, Body as any)
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

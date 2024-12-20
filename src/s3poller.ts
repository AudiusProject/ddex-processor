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
import { BucketConfig, sources } from './sources'

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

export async function pollS3(reset?: boolean) {
  for (const sourceConfig of sources.all()) {
    if (!sourceConfig.awsBucket) {
      console.log(`skipping non-s3 source: ${sourceConfig.name}`)
      continue
    }

    const client = dialS3(sourceConfig)
    const bucket = sourceConfig.awsBucket
    const sourceName = sourceConfig.name

    let Marker = ''

    // load prior marker
    if (!reset) {
      Marker = s3markerRepo.get(bucket)
    }

    // list top level prefixes after marker
    const result = await client.send(
      new ListObjectsCommand({
        Bucket: bucket,
        Delimiter: '/',
        Marker,
      })
    )
    const prefixes = result.CommonPrefixes?.map((p) => p.Prefix) as string[]
    console.log(
      `polling s3 ${bucket} from ${Marker} got ${prefixes?.length} items`
    )
    if (!prefixes) {
      continue
    }

    for (const prefix of prefixes) {
      await scanS3Prefix(sourceName, client, bucket, prefix)
      Marker = prefix
    }

    // save marker
    if (Marker) {
      console.log('update marker', { bucket, Marker })
      s3markerRepo.upsert(bucket, Marker)
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

  for (const c of result.Contents) {
    if (!c.Key) continue

    if (c.Key.toLowerCase().endsWith('.xml')) {
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
        const releases = parseDdexXml(source, xmlUrl, xml) || []

        // seed resized images so server doesn't have to do at request time
        for (const release of releases) {
          for (const img of release.images) {
            if (img.fileName && img.filePath) {
              await readAssetWithCaching(
                xmlUrl,
                img.filePath,
                img.fileName,
                '200',
                true
              )
            }
          }
        }
      }
    }
  }
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
  // read from s3 + cache to local disk
  if (xmlUrl.startsWith('s3:')) {
    const cacheBaseDir = `/tmp/ddex_cache`
    const s3url = new URL(`${filePath}${fileName}`, xmlUrl)
    const Bucket = s3url.host
    const Key = s3url.pathname.substring(1)
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
  const fileUrl = resolve(xmlUrl, '..', filePath, fileName)
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

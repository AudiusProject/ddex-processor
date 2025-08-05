import {
  GetObjectCommand,
  ListObjectsCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3'
import * as cheerio from 'cheerio'
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

export async function pollS3(reset?: boolean) {
  for (const sourceConfig of sources.all()) {
    if (!sourceConfig.awsBucket) {
      console.log(`skipping non-s3 source: ${sourceConfig.name}`)
      continue
    }
    await pollS3Source(sourceConfig, reset)
  }
}

export async function pollS3Source(
  sourceConfig: SourceConfig,
  reset?: boolean
) {
  while (true) {
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
      Marker = await s3markerRepo.get(bucket)
    }

    // list top level prefixes after marker
    const result = await client.send(
      new ListObjectsCommand({
        Bucket: bucket,
        Delimiter: '/',
        Marker,
      })
    )
    
    const prefixes = result.CommonPrefixes?.map((p) => p.Prefix).filter(
      Boolean
    ) as string[]
    
    console.log(
      `polling s3 ${bucket} from ${Marker} got ${prefixes?.length || 0} prefixes and ${result.Contents?.length || 0} files`
    )

    // Handle case where there are common prefixes (folder structure)
    if (prefixes && prefixes.length > 0) {
      const batchSize = 100
      for (let i = 0; i < prefixes.length; i += batchSize) {
        const batch = prefixes.slice(i, i + batchSize)
        
        // Collect all files from all prefixes in this batch
        const allFiles: any[] = []
        
        // Fetch files from all prefixes in parallel for efficiency
        await Promise.all(
          batch.map(async (prefix) => {
            const prefixResult = await client.send(
              new ListObjectsCommand({
                Bucket: bucket,
                Prefix: prefix,
              })
            )
            if (prefixResult.Contents) {
              allFiles.push(...prefixResult.Contents)
            }
          })
        )

        // Process all files in chronological order
        if (allFiles.length > 0) {
          await processS3Contents(sourceName, client, bucket, allFiles)
        }
      }
      
      // save marker for prefixes
      Marker = prefixes.at(-1)!
      console.log('update marker', { bucket, Marker })
      await s3markerRepo.upsert(bucket, Marker)
    }
    // Handle case where files are at root level (no prefixes)
    else if (result.Contents && result.Contents.length > 0) {
      // Process files directly at root level using the same logic
      await processS3Contents(sourceName, client, bucket, result.Contents)

      // Update marker to last processed file key
      const lastKey = result.Contents.at(-1)?.Key
      if (lastKey) {
        console.log('update marker', { bucket, Marker: lastKey })
        await s3markerRepo.upsert(bucket, lastKey)
      }

      // Break if not truncated (no more files)
      if (!result.IsTruncated) {
        break
      }
    }
    else {
      // No prefixes and no contents, we're done
      break
    }
  }
}

// Helper function to process S3 objects (XML files)
async function processS3Contents(
  source: string,
  client: S3Client,
  bucket: string,
  contents: any[]
) {
  // First, fetch and parse all XML files to get their timestamps
  const filesWithTimestamps = await Promise.all(
    contents
      .filter(c => c.Key?.toLowerCase().endsWith('.xml') && !c.Key.includes('batchcomplete'))
      .map(async (c) => {
        try {
          const { Body } = await client.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: c.Key,
            })
          )
          const xml = await Body?.transformToString()
          if (xml) {
            const $ = cheerio.load(xml, { xmlMode: true })
            const messageTimestamp = $('MessageCreatedDateTime').first().text()
            return { key: c.Key, xml, messageTimestamp }
          }
        } catch (error) {
          console.error(`Failed to fetch/parse ${c.Key}:`, error)
        }
        return null
      })
  )

  // Sort by messageTimestamp, handling cases where timestamp might be missing
  const sortedFiles = filesWithTimestamps
    .filter(Boolean)
    .sort((a, b) => {
      const timestampA = a!.messageTimestamp || ''
      const timestampB = b!.messageTimestamp || ''
      return timestampA.localeCompare(timestampB)
    })

  // Process in chronological order
  for (const file of sortedFiles) {
    const xmlUrl = `s3://` + join(bucket, file!.key)
    console.log('parsing', xmlUrl, 'timestamp:', file!.messageTimestamp)
    const releases = (await parseDdexXml(source, xmlUrl, file!.xml)) || []
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

export function parseS3Url(s3Url: string): { bucket: string; key: string } {
  const match = s3Url.match(/^s3:\/\/([^\/]+)\/(.+)$/)
  if (!match) throw new Error('Invalid S3 URL format')
  return { bucket: match[1], key: match[2] }
}

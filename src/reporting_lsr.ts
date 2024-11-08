import { GetObjectCommand, ListObjectsCommand } from '@aws-sdk/client-s3'
import { parse } from 'csv-parse/sync'
import { readdir, readFile } from 'fs/promises'
import { gunzip } from 'zlib'
import { isClearedRepo } from './db'
import { dialS3 } from './s3poller'
import { sources } from './sources'

sources.load()

type LsrRow = {
  client_catalog_id: string
  is_matched: string
  is_cleared: string
  pct_identified: string
  vol_coverage: string
  public_domain: string
  is_non_music: string
}

async function fromS3() {
  const { mri } = sources.reporting()
  const client = dialS3(mri)
  const bucket = mri.awsBucket
  const result = await client.send(
    new ListObjectsCommand({
      Bucket: bucket,
      Prefix: 'outputs/lsr',
    })
  )
  if (!result.Contents?.length) {
    return
  }

  for (const c of result.Contents) {
    if (!c.Key) continue

    console.log(c.Key)

    if (c.Key.toLowerCase().includes('.csv')) {
      const { Body } = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: c.Key,
        })
      )

      if (c.Key.toLowerCase().endsWith('.csv.gz')) {
        const data = await Body!.transformToByteArray()
        gunzip(data!, (err, ok) => {
          if (err) throw err
          readLsrFile(ok)
        })
      } else {
        const data = await Body!.transformToString()
        readLsrFile(data!)
      }

      // todo: mark key as done... skip next time
    }
  }
}

async function fromDisk() {
  const files = await readdir('reports/outputs/lsr')
  for (const file of files) {
    if (file.includes('csv')) {
      console.log('read', file)

      const data = await readFile('reports/outputs/lsr/' + file)
      if (file.endsWith('.csv.gz')) {
        gunzip(data, (err, ok) => {
          if (err) throw err
          readLsrFile(ok)
        })
      } else {
        readLsrFile(data)
      }
    }
  }
}

async function readLsrFile(csv: string | Buffer) {
  const rows = parse(csv, { columns: true }) as LsrRow[]
  for (const row of rows) {
    if (!row.client_catalog_id.startsWith('ddex')) {
      continue
    }

    const [_ddex, source, releaseId, isrc] = row.client_catalog_id.split('_')

    console.log(source, row)

    isClearedRepo.upsert({
      releaseId,
      trackId: isrc,
      isCleared: row.is_cleared,
      isMatched: row.is_matched,
    })
  }
}

fromS3()

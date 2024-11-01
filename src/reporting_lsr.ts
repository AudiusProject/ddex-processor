import { parse } from 'csv'
import fs from 'fs'
import zlib from 'zlib'

type LsrRow = {
  client_catalog_id: string
  is_matched: string
  is_cleared: string
  pct_identified: string
  vol_coverage: string
  public_domain: string
  is_non_music: string
}

async function lsrDemo() {
  // const filePath = `reports/lsr/Audius_LSR_20241014021419.csv.gz`
  // const filePath = `reports/lsr/Audius_LSR_20241022040824.csv`
  const filePath = process.argv[2]
  console.log(filePath)

  if (!filePath) {
    throw new Error(`filpath is required`)
  }

  let readStream = fs.createReadStream(filePath) as any
  if (filePath.endsWith('.csv.gz')) {
    readStream = readStream.pipe(zlib.createGunzip())
  }
  readStream
    .pipe(
      parse({
        columns: true,
      })
    )
    .on('data', (row: LsrRow) => {
      if (!row.client_catalog_id.startsWith('ddex')) {
        return
      }
      const [_ddex, source, releaseId, isrc] = row.client_catalog_id.split('_')
      if (row.is_cleared == 't') {
        console.log('todo: mark track cleared', source, releaseId, isrc)
      }
    })
    .on('end', () => {
      console.log('File successfully processed')
    })
    .on('error', (err: Error) => {
      console.error('Error reading the file:', err)
    })
}

lsrDemo()

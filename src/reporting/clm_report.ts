import { PutObjectCommand } from '@aws-sdk/client-s3'
import sql from '@radically-straightforward/sqlite'
import { stringify } from 'csv-stringify/sync'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { releaseRepo, s3markerRepo } from '../db'
import { dialS3 } from '../s3poller'
import { sources } from '../sources'

export async function clmReport() {
  const markerKey = 'report_clm'
  let marker = s3markerRepo.get(markerKey) || '2024-10-26'

  // don't run twice on same day
  const todayDate = new Date().toISOString().substring(0, 10)
  const markerDate = marker.substring(0, 10)
  if (markerDate == todayDate) {
    console.log('Skipping CLM report (marker too recent)')
    return
  } else {
    console.log('Running CLM report')
  }

  const releases = releaseRepo.rawSelect(sql`
    select * from releases
    where releaseType != 'TrackRelease'
    and messageTimestamp > ${marker}
    order by messageTimestamp asc
  `)
  if (releases.length == 0) {
    console.log('no new CLM releases')
    return
  }

  const rows = releases.flatMap((releaseRow) => {
    marker = releaseRow.messageTimestamp
    const r = releaseRow._parsed!
    return r.soundRecordings.map((track) => {
      if (!track.isrc) {
        throw new Error(
          `track without isrc.  source=${releaseRow.source} id=${releaseRow.key}`
        )
      }
      return {
        UniqueTrackIdentifier: [
          'ddex',
          releaseRow.source,
          releaseRow.key,
          track.isrc,
        ].join('_'),
        TrackTitle: track.title,
        Artist: r.artists
          .filter((a) => a.role == 'MainArtist')
          .map((a) => a.name)
          .join(', '),
        AlbumTitle: r.title,
        AlbumId: releaseRepo.chooseReleaseId(r.releaseIds),
        ReleaseLabel: r.labelName,
        ISRC: track.isrc,
        UPC: '',
        Composer: track.indirectContributors
          .filter((a) => a.role == 'Composer')
          .map((a) => a.name)
          .join(', '),
        Duration: track.duration,
        ResourceType: 'Audio',
      }
    })
  })

  const result = stringify(rows, { header: true })
  const fileName = `Audius_CLM_${formatDate(new Date())}.csv`

  // console.log(result)
  await mkdir('reports', { recursive: true })
  await writeFile(path.join('reports', fileName), result)
  console.log(`wrote reports/${fileName}`)

  // push to S3
  const doWrite = true
  if (doWrite) {
    const { mri } = sources.reporting()
    const s3Client = dialS3(mri)
    const key = `inputs/clm/${fileName}`
    await s3Client.send(
      new PutObjectCommand({
        Bucket: mri.awsBucket,
        Key: key,
        Body: result,
        ContentType: 'text/csv',
      })
    )
    console.log(`wrote to s3. bucket=${mri.awsBucket} key=${key}`)
  }

  // update marker
  console.log(`Update marker ${markerKey}=${marker}`)
  s3markerRepo.upsert(markerKey, marker)
}

function padToTwoDigits(num: number) {
  return num.toString().padStart(2, '0')
}

function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = padToTwoDigits(date.getMonth() + 1)
  const day = padToTwoDigits(date.getDate())
  const hours = padToTwoDigits(date.getHours())
  const minutes = padToTwoDigits(date.getMinutes())
  const seconds = padToTwoDigits(date.getSeconds())
  return `${year}${month}${day}${hours}${minutes}${seconds}`
}

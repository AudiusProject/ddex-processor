import { stringify } from 'csv-stringify/sync'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { releaseRepo } from './db'

async function clmReport() {
  // todo: load cursors to only do new / updated releases for each source

  const releases = releaseRepo.all()
  const rows = releases.flatMap((releaseRow) => {
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
  const fileName = `Audius_DDEX_CLM_${formatDate(new Date())}.csv`

  // console.log(result)
  await mkdir('reports', { recursive: true })
  await writeFile(path.join('reports', fileName), result)

  // todo: add ability to specify a clm report destination in sources.json
  //       this should put the CSV into that bucket
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

// run manually:
// tsx src/reporting.ts
clmReport()

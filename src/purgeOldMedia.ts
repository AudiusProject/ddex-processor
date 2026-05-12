import { releaseRepo } from './db'
import { deleteReleaseMedia } from './s3poller'

// Releases delivered more than this long ago that never published get
// their S3 media reclaimed. XML stays around so we can still inspect.
const STALE_AFTER_DAYS = 180

export async function purgeOldUnpublishedMedia() {
  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000)
  const rows = await releaseRepo.findStaleUnpublishedWithMedia(cutoff)
  if (!rows.length) return
  console.log(
    `purgeOldUnpublishedMedia: ${rows.length} releases older than ${STALE_AFTER_DAYS}d still hold media`
  )
  for (const row of rows) {
    try {
      await deleteReleaseMedia(row)
      console.log(`purgeOldUnpublishedMedia: cleared media for ${row.key}`)
    } catch (e) {
      console.log(`purgeOldUnpublishedMedia: failed for ${row.key}`, e)
    }
  }
}

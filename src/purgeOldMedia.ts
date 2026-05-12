import { releaseRepo } from './db'
import { deleteReleaseMedia } from './s3poller'

// Releases delivered more than this long ago that never published get
// their S3 media reclaimed. XML stays around so we can still inspect.
const UNPUBLISHED_STALE_AFTER_DAYS = 180

// Successfully-published releases keep their S3 media for this long after
// publication (grace window for retries / debugging) before being purged.
const PUBLISHED_STALE_AFTER_DAYS = 7

export async function purgeOldUnpublishedMedia() {
  const cutoff = new Date(
    Date.now() - UNPUBLISHED_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000
  )
  const rows = await releaseRepo.findStaleUnpublishedWithMedia(cutoff)
  if (!rows.length) return
  console.log(
    `purgeOldUnpublishedMedia: ${rows.length} releases older than ${UNPUBLISHED_STALE_AFTER_DAYS}d still hold media`
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

export async function purgeOldPublishedMedia() {
  const cutoff = new Date(
    Date.now() - PUBLISHED_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000
  )
  const rows = await releaseRepo.findStalePublishedWithMedia(cutoff)
  if (!rows.length) return
  console.log(
    `purgeOldPublishedMedia: ${rows.length} releases published > ${PUBLISHED_STALE_AFTER_DAYS}d ago still hold media`
  )
  for (const row of rows) {
    try {
      await deleteReleaseMedia(row)
      console.log(`purgeOldPublishedMedia: cleared media for ${row.key}`)
    } catch (e) {
      console.log(`purgeOldPublishedMedia: failed for ${row.key}`, e)
    }
  }
}

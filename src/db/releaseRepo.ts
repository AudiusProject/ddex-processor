//
// release repo
//

import { assetRepo, ReleaseProcessingStatus, ReleaseRow } from '../db'
import { DDEXRelease, DDEXReleaseIds } from '../parseDelivery'
import { omitEmpty } from '../util'
import { ifdef, pgUpdate, pgUpsert, sql } from './sql'

type FindReleaseParams = {
  pendingPublish?: boolean
  status?: string
  source?: string
  limit?: number
  offset?: number
  search?: string
  cleared?: boolean
  labelName?: string
  genre?: string
}

type StatsRow = {
  source: string
  count: number
}

export const releaseRepo = {
  // todo: this is incomplete, and I'm not sure how to order which ID to use first.
  //   go version used xml file name
  //   but a single file can contain multiple releases
  //   so still need a way to pick an identifier, right?
  chooseReleaseId(releaseIds: DDEXReleaseIds) {
    const key = releaseIds.isrc || releaseIds.icpn || releaseIds.grid
    if (!key) {
      const msg = `failed to chooseReleaseId: ${JSON.stringify(releaseIds)}`
      console.log(msg)
      throw new Error(msg)
    }
    return key
  },

  async stats() {
    const stats: StatsRow[] =
      await sql`select source, count(*) count from releases group by 1`
    return stats
  },

  async all(params?: FindReleaseParams) {
    params ||= {}
    const rows: ReleaseRow[] = await sql`
      select * from releases
      where 1=1

      -- pending publish
      ${ifdef(
        params.pendingPublish,
        sql`
          and status in (
            ${ReleaseProcessingStatus.PublishPending},
            ${ReleaseProcessingStatus.Failed},
            ${ReleaseProcessingStatus.DeletePending}
          )
          and "publishErrorCount" < 5 `
      )}

      ${ifdef(params.status, sql` and "status" = ${params.status!} `)}
      ${ifdef(params.source, sql` and "source" = ${params.source!} `)}
      ${ifdef(params.labelName, sql`and "labelName" = ${params.labelName!}`)}
      ${ifdef(params.genre, sql`and "genre" = ${params.genre!}`)}

      ${ifdef(
        params.search,
        sql`
        and (
          "artists"::text ilike '%' || ${params.search!} || '%'
          OR "contributors"::text ilike '%' || ${params.search!} || '%'
          OR "indirectContributors"::text ilike '%' || ${params.search!} || '%'
          OR "title" ilike '%' || ${params.search!} || '%'
          OR "labelName" ilike '%' || ${params.search!} || '%'
          OR "genre" ilike '%' || ${params.search!} || '%'
          OR "subGenre" ilike '%' || ${params.search!} || '%'
          OR "source" like '%' || ${params.search!} || '%'
        )
      `
      )}

      ${ifdef(params.cleared, sql` and "numCleared" > 0 `)}

      order by "messageTimestamp" desc

      ${ifdef(params.limit, sql` limit ${params.limit!} `)}
      ${ifdef(params.offset, sql` offset ${params.offset!} `)}
    `

    return rows
  },

  async get(key: string) {
    const rows = await sql`select * from releases where "key" = ${key}`
    const row = rows[0]
    if (!row) return
    return row as ReleaseRow
  },

  async update(r: Partial<ReleaseRow>) {
    await pgUpdate('releases', 'key', r)
  },

  upsert: async (
    source: string,
    xmlUrl: string,
    messageTimestamp: string,
    release: DDEXRelease
  ) => {
    const key = releaseRepo.chooseReleaseId(release.releaseIds)
    const prior = await releaseRepo.get(key)

    // skip TrackRelease, since we only want main releases
    if (release.releaseType == 'TrackRelease') {
      return
    }

    // if prior exists and is newer, skip
    if (prior && prior.messageTimestamp > messageTimestamp) {
      console.log(`skipping ${xmlUrl} because ${key} is newer`)
      return
    }

    let status: ReleaseRow['status'] = release.problems.length
      ? ReleaseProcessingStatus.Blocked
      : ReleaseProcessingStatus.PublishPending

    // if prior is published and latest version has no deal,
    // treat as takedown
    if (prior?.entityId && release.deals.length == 0) {
      status = ReleaseProcessingStatus.DeletePending
    }

    // pull out original resource URLs
    // so if an update comes in we can still resolve the original file
    for (const r of [...release.soundRecordings, ...release.images]) {
      if (r.ref && r.filePath && r.fileName) {
        await assetRepo.upsert({
          source: source,
          releaseId: key,
          ref: r.ref,
          xmlUrl: xmlUrl,
          filePath: r.filePath,
          fileName: r.fileName,
        })
      }
    }

    const data = {
      source,
      key,
      status,
      xmlUrl,
      messageTimestamp,
      updatedAt: new Date().toISOString(),
      ...release,
    } as Partial<ReleaseRow>

    await pgUpsert('releases', 'key', omitEmpty(data))
  },

  async markPrependArtist(key: string, prependArtist: boolean) {
    await sql`
      update releases set
      "prependArtist"=${prependArtist}
      where key = ${key}
    `
  },

  async markForDelete(
    source: string,
    xmlUrl: string,
    messageTimestamp: string,
    releaseIds: DDEXReleaseIds
  ) {
    // here we do PK lookup using the "best" id
    // but we may need to try to find by all the different releaseIds
    // if it's not consistent
    const key = releaseRepo.chooseReleaseId(releaseIds)
    const prior = await releaseRepo.get(key)

    if (!prior) {
      console.log(`got purge release but no prior ${key}`)
      return
    }

    await releaseRepo.update({
      key,
      status: ReleaseProcessingStatus.DeletePending,
      source,
      xmlUrl,
      messageTimestamp,
    })
  },

  async addPublishError(key: string, err: Error) {
    const status = ReleaseProcessingStatus.Failed
    const errText = err.stack || err.toString()
    await sql`
      update releases set
        status=${status},
        lastPublishError=${errText},
        publishErrorCount=publishErrorCount+1
      where key = ${key}
    `
  },
}

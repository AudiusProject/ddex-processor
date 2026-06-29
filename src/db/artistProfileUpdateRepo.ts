import { ArtistProfileUpdateRow, ArtistProfileUpdateStatus } from '../db'
import { DDEXArtistProfileUpdate } from '../parseDelivery'
import { omitEmpty } from '../util'
import { ifdef, pgUpdate, pgUpsert, sql } from './sql'

type FindArtistProfileUpdateParams = {
  pendingPublish?: boolean
  source?: string
  limit?: number
}

export const artistProfileUpdateRepo = {
  chooseKey(source: string, xmlUrl: string, update: DDEXArtistProfileUpdate) {
    const id =
      update.audiusUser ||
      update.artistHandle ||
      update.artistName ||
      update.partyRef
    if (!id) {
      const msg = `failed to chooseArtistProfileUpdateKey: ${JSON.stringify(
        update
      )}`
      console.log(msg)
      throw new Error(msg)
    }
    return [source, xmlUrl, id].join(':')
  },

  async all(params?: FindArtistProfileUpdateParams) {
    params ||= {}
    const rows: ArtistProfileUpdateRow[] = await sql`
      select * from artist_profile_updates
      where 1=1

      ${ifdef(
        params.pendingPublish,
        sql`
          and status in (
            ${ArtistProfileUpdateStatus.PublishPending},
            ${ArtistProfileUpdateStatus.Failed}
          )
          and "publishErrorCount" < 5
        `
      )}

      ${ifdef(params.source, sql` and "source" = ${params.source!} `)}

      order by "messageTimestamp" asc

      ${ifdef(params.limit, sql` limit ${params.limit!} `)}
    `

    return rows
  },

  async get(key: string) {
    const rows =
      await sql`select * from artist_profile_updates where "key" = ${key}`
    const row = rows[0]
    if (!row) return
    return row as ArtistProfileUpdateRow
  },

  async update(r: Partial<ArtistProfileUpdateRow>) {
    await pgUpdate('artist_profile_updates', 'key', r)
  },

  async upsert(
    source: string,
    xmlUrl: string,
    messageTimestamp: string,
    update: DDEXArtistProfileUpdate
  ) {
    const key = artistProfileUpdateRepo.chooseKey(source, xmlUrl, update)
    const prior = await artistProfileUpdateRepo.get(key)

    if (
      prior &&
      (prior.messageTimestamp > messageTimestamp ||
        (prior.messageTimestamp == messageTimestamp &&
          prior.status == ArtistProfileUpdateStatus.Published))
    ) {
      console.log(`skipping ${xmlUrl} because ${key} is newer`)
      return
    }

    const status = update.problems.length
      ? ArtistProfileUpdateStatus.Blocked
      : ArtistProfileUpdateStatus.PublishPending

    const data = {
      source,
      key,
      status,
      xmlUrl,
      messageTimestamp,
      updatedAt: new Date().toISOString(),
      ...update,
    } as Partial<ArtistProfileUpdateRow>

    await pgUpsert('artist_profile_updates', 'key', omitEmpty(data))
  },

  async addPublishError(key: string, err: Error) {
    const status = ArtistProfileUpdateStatus.Failed
    const errText = err.stack || err.toString()
    await sql`
      update artist_profile_updates set
        status=${status},
        "lastPublishError"=${errText},
        "publishErrorCount" = "publishErrorCount" + 1
      where "key" = ${key}
    `
  },

  async addPublishBlock(key: string, err: Error) {
    const status = ArtistProfileUpdateStatus.Blocked
    const errText = err.stack || err.toString()
    await sql`
      update artist_profile_updates set
        status=${status},
        "lastPublishError"=${errText},
        "publishErrorCount" = "publishErrorCount" + 1
      where "key" = ${key}
    `
  },
}

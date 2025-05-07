import postgres from 'postgres'
import { ReleaseProcessingStatus, ReleaseRow, XmlRow } from './db'
import { DDEXRelease, DDEXReleaseIds } from './parseDelivery'

const sql = postgres({
  port: 40111,
  user: 'postgres',
  pass: 'example',
})

export async function pgMigrate() {
  await sql`
  CREATE TABLE IF NOT EXISTS xmls (
    "source" text not null,
    "xmlUrl" text primary key,
    "messageTimestamp" text not null,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP
  );`

  await sql`
  CREATE TABLE IF NOT EXISTS releases (
    "source" text not null,
    "key" text primary key,
    "ref" text,
    "xmlUrl" text,
    "messageTimestamp" text,
    "json" jsonb,
    "status" text not null,

    "entityType" text,
    "entityId" text,
    "blockHash" text,
    "blockNumber" integer,
    "publishedAt" timestamptz,

    "publishErrorCount" integer default 0,
    "lastPublishError" text,

    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamptz,
    "releaseType" text,
    "releaseDate" text,
    "numCleared" int,
    "numNotCleared" int,
    "prependArtist" boolean
  );
  `

  await sql`
  create table if not exists assets (
    "source" text not null,
    "releaseId" text not null,
    "ref" text not null,
    "xmlUrl" text not null,
    "filePath" text not null,
    "fileName" text not null,
    PRIMARY KEY ("source", "releaseId", "ref")
  );
  `
}

//
// xml repo
//

export const xmlRepo = {
  async all(cursor: string) {
    const rows: XmlRow[] = await sql`
      select * from xmls
      where "xmlUrl" > ${cursor}
      order by "xmlUrl"
      limit 1000`
    return rows
  },

  async get(xmlUrl: string) {
    const rows = await sql`select * from xmls where "xmlUrl" = ${xmlUrl}`
    return rows[0]
  },

  async find(query: string) {
    const xmls: XmlRow[] = await sql`
        select * from xmls
        where "xmlUrl" like '%' || ${query} || '%'
        order by "messageTimestamp" desc`
    return xmls
  },

  async upsert(row: Partial<XmlRow>) {
    await pgUpsert('xmls', 'xmlUrl', row)
  },
}

//
//
//

//
// release repo
//

type FindReleaseParams = {
  pendingPublish?: boolean
  status?: string
  source?: string
  limit?: number
  offset?: number
  search?: string
  cleared?: boolean
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
    const stats =
      await sql`select source, count(*) count from releases group by 1`
    return stats[0] as StatsRow
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

      ${ifdef(params.search, sql` and "json" like '%' || ${params.search!} || '%' `)}

      ${ifdef(params.cleared, sql` and "numCleared" > 0 `)}

      order by "messageTimestamp" desc

      ${ifdef(params.limit, sql` limit ${params.limit!} `)}
      ${ifdef(params.offset, sql` offset ${params.offset!} `)}
    `

    for (const row of rows) {
      if (row.json) row._parsed = JSON.parse(row.json)
    }
    return rows
  },

  // rawSelect(q: Query) {
  //   const rows = db.all<ReleaseRow>(q)
  //   for (const row of rows) {
  //     if (row.json) row._parsed = JSON.parse(row.json)
  //   }
  //   return rows
  // },

  async get(key: string) {
    const rows = await sql`select * from releases where "key" = ${key}`
    const row = rows[0]
    if (!row) return
    if (row.json) row._parsed = JSON.parse(row.json)
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

    if (!release.audiusUser) {
      release.problems.push(`NoUser`)
    } else {
      const idx = release.problems.indexOf(`NoUser`)
      if (idx != -1) {
        release.problems.splice(idx, 1)
      }
    }

    const json = JSON.stringify(release)

    // if same xmlUrl + json, skip
    // may want some smarter json compare here
    // if this is causing spurious sdk updates to be issued
    // if (prior && prior.xmlUrl == xmlUrl && prior.json == json) {
    //   return
    // }

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
        await pgInsert('assets', {
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
      ref: release.ref,
      releaseType: release.releaseType,
      releaseDate: release.releaseDate,
      xmlUrl,
      messageTimestamp,
      json,
      updatedAt: new Date().toISOString(),
    } as Partial<ReleaseRow>

    await pgUpsert('releases', 'key', data)
  },

  async markPrependArtist(key: string, prependArtist: boolean) {
    await sql`
      update releases set
      prependArtist=${prependArtist ? 'TRUE' : ''}
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

//
// Resource repo
//

export type AssetRow = {
  releaseId: string
  ref: string
  xmlUrl: string
  filePath: string
  fileName: string
}

export const assetRepo = {
  async get(source: string, releaseId: string, ref: string) {
    const rows =
      await sql`select * from assets where source = ${source} and "releaseId" = ${releaseId} and ref = ${ref}`
    return rows[0] as AssetRow
  },
}

//
//
//

export async function pgInsert(table: string, data: Record<string, any>) {
  await sql`insert into ${sql.unsafe(table)} ${sql(data)} on conflict do nothing`
}

export async function pgUpsert(
  table: string,
  pkField: string,
  data: Record<string, any>
) {
  await sql.begin(async (tx) => {
    await tx`delete from ${tx(table)} where ${tx(pkField)} = ${data[pkField]}`
    await tx`insert into ${sql.unsafe(table)} ${sql(data)}`
  })
}

export async function pgUpdate(
  table: string,
  pkField: string,
  data: Record<string, any>
) {
  await sql`update ${sql.unsafe(table)} set ${sql(data)} where ${sql.unsafe(pkField)} = ${data[pkField]}`
}

function ifdef(cond: any, stmt: any) {
  return cond ? stmt : sql``
}

//

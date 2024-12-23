import sql, { Database, Query } from '@radically-straightforward/sqlite'
import { Statement } from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { DDEXRelease, DDEXReleaseIds } from './parseDelivery'
import { dataDir } from './sources'
import { lowerAscii } from './util'

const dbLocation = process.env.SQLITE_URL || `${dataDir}/ddex.db`
const db = new Database(dbLocation)

db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('busy_timeout = 5000')
db.pragma('cache_size = -20000')
db.pragma('auto_vacuum = INCREMENTAL')
db.pragma('temp_store = MEMORY')
db.pragma('mmap_size = 2147483648')
db.pragma('page_size = 8192')

db.migrate(
  sql`

create table if not exists xmls (
  source text not null,
  xmlUrl text primary key,
  xmlText text not null,
  messageTimestamp text not null,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

create table if not exists users (
  apiKey text, -- app that user authorized
  id text,
  handle text not null,
  name text not null,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  primary key (apiKey, id)
);

create table if not exists releases (
  source text not null,
  key text primary key,
  ref text,
  xmlUrl text,
  messageTimestamp text,
  json jsonb,
  status text not null,

  entityType text,
  entityId text,
  blockHash text,
  blockNumber integer,
  publishedAt datetime,

  publishErrorCount integer default 0,
  lastPublishError text,

  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME
);

create index if not exists releasesStatusIndex on releases(status);

create table if not exists s3markers (
  bucket text primary key,
  marker text not null
);
`,
  sql`
  create table if not exists kv (
    key text primary key,
    val text not null
  );
  `,
  sql`alter table releases add column releaseType text;`,
  sql`alter table releases add column releaseDate text;`,
  sql`
    create table if not exists assets (
      source text not null,
      releaseId text not null,
      ref text not null,
      xmlUrl text not null,
      filePath text not null,
      fileName text not null,
      PRIMARY KEY (source, releaseId, ref)
    );
  `,
  sql`
    create table isCleared (
      releaseId text not null,
      trackId text not null,
      isMatched boolean,
      isCleared boolean,
      PRIMARY KEY (releaseId, trackId)
    );
  `,
  sql`alter table releases add column numCleared int`,
  sql`alter table releases add column numNotCleared int`,
  sql`delete from releases where releaseType = 'TrackRelease'`,
  sql`create index releaseDateIdx on releases(releaseDate)`
)

export type XmlRow = {
  source: string
  xmlText: string
  xmlUrl: string
  messageTimestamp: string
  createdAt: string
}

export type UserRow = {
  apiKey: string
  id: string
  handle: string
  name: string
  createdAt: string
}

export enum ReleaseProcessingStatus {
  Blocked = 'Blocked',
  PublishPending = 'PublishPending',
  Published = 'Published',
  Failed = 'Failed',
  DeletePending = 'DeletePending',
  Deleted = 'Deleted',
}

export type ReleaseRow = {
  source: string
  key: string
  xmlUrl: string
  messageTimestamp: string
  releaseType: string
  releaseDate: string
  json: string
  status: ReleaseProcessingStatus
  createdAt: string
  numCleared: number
  numNotCleared: number

  entityType?: 'track' | 'album'
  entityId?: string
  blockHash?: string
  blockNumber?: number
  publishedAt?: string

  publishErrorCount: number
  lastPublishError: string

  _parsed?: DDEXRelease
}

export type S3MarkerRow = {
  bucket: string
  marker: string
}

export type KVRow = {
  key: string
  val: string
}

//
// s3cursor repo
//
export const s3markerRepo = {
  get(bucket: string) {
    const markerRow = db.get<S3MarkerRow>(
      sql`select marker from s3markers where bucket = ${bucket}`
    )
    return markerRow?.marker || ''
  },

  upsert(bucket: string, marker: string) {
    db.run(sql`replace into s3markers values (${bucket}, ${marker})`)
  },
}

//
// user repo
//

export const userRepo = {
  all() {
    return db.all<UserRow>(sql`select * from users`)
  },

  find(example: Partial<UserRow>) {
    return dbSelect('users', example) as UserRow[]
  },

  findOne(example: Partial<UserRow>) {
    return dbSelectOne('users', example) as UserRow | undefined
  },

  upsert(user: Partial<UserRow>) {
    dbUpsert('users', user)
  },

  match(apiKey: string, artistNames: string[]) {
    const artistSet = new Set(artistNames.map(lowerAscii))
    const users = db.all<UserRow>(
      sql`select * from users where apiKey = ${apiKey}`
    )
    for (const u of users) {
      if (
        artistSet.has(lowerAscii(u.name)) ||
        artistSet.has(lowerAscii(u.handle))
      ) {
        return u.id
      }
    }
  },
}

//
// xml repo
//

export const xmlRepo = {
  all() {
    return db.all<XmlRow>(sql`select * from xmls order by xmlUrl`)
  },

  get(xmlUrl: string) {
    return db.get<XmlRow>(sql`select * from xmls where xmlUrl = ${xmlUrl}`)
  },

  find(query: string) {
    const xmls = db.all<XmlRow>(
      sql`
        select * from xmls
        where xmlUrl like '%' || ${query} || '%'
        order by messageTimestamp desc`
    )
    return xmls
  },

  upsert(row: Partial<XmlRow>) {
    dbUpsert('xmls', row)
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
  get(releaseId: string, ref: string) {
    return db.get<AssetRow>(
      sql`select * from assets where releaseId = ${releaseId} and ref = ${ref}`
    )
  },
}

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

  stats() {
    return db.all<StatsRow>(
      sql`select source, count(*) count from releases group by 1`
    )
  },

  all(params?: FindReleaseParams) {
    params ||= {}
    const rows = db.all<ReleaseRow>(sql`
      select * from releases
      where 1=1

      -- pending publish
      $${ifdef(
        params.pendingPublish,
        sql`
          and status in (
            ${ReleaseProcessingStatus.PublishPending},
            ${ReleaseProcessingStatus.Failed},
            ${ReleaseProcessingStatus.DeletePending}
          )
          and publishErrorCount < 5 `
      )}

      $${ifdef(params.status, sql` and status = ${params.status} `)}

      $${ifdef(params.source, sql` and source = ${params.source} `)}

      $${ifdef(params.search, sql` and json like '%' || ${params.search} || '%' `)}

      $${ifdef(params.cleared, sql` and numCleared > 0 `)}

      order by messageTimestamp desc

      $${ifdef(params.limit, sql` limit ${params.limit} `)}
      $${ifdef(params.offset, sql` offset ${params.offset} `)}
    `)

    for (const row of rows) {
      if (row.json) row._parsed = JSON.parse(row.json)
    }
    return rows
  },

  rawSelect(q: Query) {
    const rows = db.all<ReleaseRow>(q)
    for (const row of rows) {
      if (row.json) row._parsed = JSON.parse(row.json)
    }
    return rows
  },

  get(key: string) {
    const row = db.get<ReleaseRow>(
      sql`select * from releases where key = ${key}`
    )
    if (!row) return
    if (row.json) row._parsed = JSON.parse(row.json)
    return row
  },

  update(r: Partial<ReleaseRow>) {
    dbUpdate('releases', 'key', r)
  },

  upsert: db.transaction(
    (
      source: string,
      xmlUrl: string,
      messageTimestamp: string,
      release: DDEXRelease
    ) => {
      const key = releaseRepo.chooseReleaseId(release.releaseIds)
      const prior = releaseRepo.get(key)
      const json = JSON.stringify(release)

      // skip TrackRelease, since we only want main releases
      if (release.releaseType == 'TrackRelease') {
        return
      }

      // if prior exists and is newer, skip
      if (prior && prior.messageTimestamp > messageTimestamp) {
        console.log(`skipping ${xmlUrl} because ${key} is newer`)
        return
      }

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
          dbUpsert('assets', {
            source: source,
            releaseId: key,
            ref: r.ref,
            xmlUrl: xmlUrl,
            filePath: r.filePath,
            fileName: r.fileName,
          })
        }
      }

      dbUpsert('releases', {
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
      } as Partial<ReleaseRow>)
    }
  ),

  markForDelete: db.transaction(
    (
      source: string,
      xmlUrl: string,
      messageTimestamp: string,
      releaseIds: DDEXReleaseIds
    ) => {
      // here we do PK lookup using the "best" id
      // but we may need to try to find by all the different releaseIds
      // if it's not consistent
      const key = releaseRepo.chooseReleaseId(releaseIds)
      const prior = releaseRepo.get(key)

      if (!prior) {
        console.log(`got purge release but no prior ${key}`)
        return
      }

      if (prior.messageTimestamp >= messageTimestamp) {
        console.log(`skipping delete ${key}`)
        return
      }

      releaseRepo.update({
        key,
        status: ReleaseProcessingStatus.DeletePending,
        source,
        xmlUrl,
        messageTimestamp,
      })
    }
  ),

  addPublishError(key: string, err: Error) {
    const status = ReleaseProcessingStatus.Failed
    const errText = err.stack || err.toString()
    db.run(sql`
      update releases set
        status=${status},
        lastPublishError=${errText},
        publishErrorCount=publishErrorCount+1
      where key = ${key}
    `)
  },
}

//
// kv repo
//

export const kvRepo = {
  getCookieSecret() {
    const keyName = 'cookieSecret'
    const row = db.get<KVRow>(sql`select val from kv where key = ${keyName}`)
    if (row && row.val) return row.val

    console.log('generating cookieSecret')
    const buf = randomBytes(32)
    const val = buf.toString('hex')
    db.run(sql`insert into kv values (${keyName}, ${val})`)
    return val
  },
}

//
// isCleared repo
//

export type IsClearedRow = {
  releaseId: string
  trackId: string
  isMatched: string
  isCleared: string
}

export const isClearedRepo = {
  upsert(c: IsClearedRow) {
    dbUpsert('isCleared', c)
  },

  listForRelease(releaseId: string) {
    const rows = dbSelect<IsClearedRow>('isCleared', { releaseId })
    const t: Record<string, boolean> = {}
    for (const row of rows) {
      t[row.trackId] = row.isCleared == 't'
    }
    return t
  },

  updateCounts() {
    db.exec(`
      with clearCount as (
        select
          releaseId,
          SUM(CASE WHEN isCleared = 't' THEN 1 ELSE 0 END) as cleared,
          SUM(CASE WHEN isCleared = 'f' THEN 1 ELSE 0 END) as notCleared
        from isCleared
        group by 1
      )
      update releases
      set numCleared = cleared,
          numNotCleared = notCleared
      from clearCount
      where releases.key = clearCount.releaseId
    `)
  },

  isLsrDone(s3url: string) {
    const row = db.get<KVRow>(sql`select val from kv where key = ${s3url}`)
    return !!row
  },

  markLsrDone(s3url: string) {
    const val = new Date().toString()
    db.run(sql`insert into kv values (${s3url}, ${val}) on conflict do nothing`)
  },
}

//
// db utils
//

const stmtCache: Record<string, Statement> = {}

function toStmt(rawSql: string) {
  if (!stmtCache[rawSql]) {
    stmtCache[rawSql] = db.prepare(rawSql)
  }
  return stmtCache[rawSql]
}

function dbSelect<T>(table: string, data: Partial<T>) {
  const wheres = Object.keys(data)
    .map((k) => ` ${k} = ? `)
    .join(' AND ')
  const rawSql = `select * from ${table} where ${wheres}`
  return toStmt(rawSql).all(...Object.values(data)) as T[]
}

function dbSelectOne<T>(table: string, data: Partial<T>) {
  const wheres = Object.keys(data)
    .map((k) => ` ${k} = ? `)
    .join(' AND ')
  const rawSql = `select * from ${table} where ${wheres}`
  return toStmt(rawSql).get(...Object.values(data)) as T | undefined
}

function dbUpdate(table: string, pkField: string, data: Record<string, any>) {
  if (!data[pkField]) {
    throw new Error(`must provide ${pkField} to update ${table}`)
  }
  const qs = Object.keys(data)
    .map((k) => ` ${k}=? `)
    .join(',')

  // if everything used integer pks, we could just use rowid
  // ... if we wanted compound pks, pkField should be an array
  const rawSql = `update ${table} set ${qs} where ${pkField} = ?`

  return toStmt(rawSql).run(...Object.values(data), data[pkField])
}

function dbUpsert(table: string, data: Record<string, any>) {
  const fields = Object.keys(data).join(',')
  const qs = Object.keys(data)
    .map(() => '?')
    .join(',')
  const excludes = Object.keys(data)
    .map((f) => `${f} = excluded.${f}`)
    .join(',')
  const rawSql = `
    insert into ${table} (${fields}) values (${qs})
    on conflict do update set ${excludes}`
  return toStmt(rawSql).run(...Object.values(data))
}

function ifdef(obj: any, snippet: any, fallback?: any) {
  fallback ||= sql``
  return obj ? snippet : fallback
}

// shutdown
process.once('SIGTERM', () => {
  db.close()
})
process.once('SIGINT', () => {
  db.close()
})

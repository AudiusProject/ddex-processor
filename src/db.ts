import sql, { Database } from '@radically-straightforward/sqlite'
import { Statement } from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { DDEXRelease } from './parseDelivery'
import { dataDir } from './sources'

export { assetRepo } from './db/assetRepo'
export { releaseRepo } from './db/releaseRepo'
export { s3markerRepo } from './db/s3markerRepo'
export { userRepo } from './db/userRepo'
export { xmlRepo } from './db/xmlRepo'

// export { assetRepo, releaseRepo, xmlRepo } from './pg'

const dbLocation = process.env.SQLITE_URL || `${dataDir}/ddex.db`
const db = new Database(dbLocation)

db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
// db.pragma('busy_timeout = 5000')
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
  sql`alter table releases add column IF NOT EXISTS releaseType text;`,
  sql`alter table releases add column IF NOT EXISTS releaseDate text;`,
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
  sql`create index releaseDateIdx on releases(releaseDate)`,
  sql`create index messageTimestampIdx on releases(messageTimestamp)`,
  sql`alter table releases add column prependArtist boolean`,
  sql`alter table users add column password text`,

  sql`create index sourceIdx on releases(source)`,
  sql`create index numClearedIdx on releases(numCleared)`,
  sql`delete from users where id = 'yy8w9Zr'`,
  sql`delete from users where id = 'lzAWJyO'`,
  sql`alter table xmls drop column xmlText`
)

export type XmlRow = {
  source: string
  xmlUrl: string
  messageTimestamp: string
  createdAt: string
}

export type UserRow = {
  apiKey: string
  id: string
  handle: string
  name: string
  createdAt: Date
  password?: string
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
  prependArtist: string

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

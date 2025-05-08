import { sql } from './sql'

// migrations.
// migration will re-run if the text changes at all
// make migration idempotent
// see: https://github.com/graphile/migrate?tab=readme-ov-file#idempotency
const steps = [
  sql`
  CREATE TABLE IF NOT EXISTS xmls (
    "source" text not null,
    "xmlUrl" text primary key,
    "messageTimestamp" text not null,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP
  );`,

  sql`
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
  `,

  sql`
  create table if not exists assets (
    "source" text not null,
    "releaseId" text not null,
    "ref" text not null,
    "xmlUrl" text not null,
    "filePath" text not null,
    "fileName" text not null,
    PRIMARY KEY ("source", "releaseId", "ref")
  );
  `,

  sql`
  CREATE TABLE IF NOT EXISTS users (
    "apiKey" text, -- app that user authorized
    "id" text,
    "handle" text not null,
    "name" text not null,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
    "password" text,
    primary key ("apiKey", "id")
  );
  `,

  sql`
  create table if not exists "s3markers" (
    "bucket" text primary key,
    "marker" text not null
  );
  `,

  sql`
  create table if not exists "isCleared" (
    "releaseId" text not null,
    "trackId" text not null,
    "isMatched" boolean,
    "isCleared" boolean,
    PRIMARY KEY ("releaseId", "trackId")
  );
  `,

  sql`
  create table if not exists "lsrLog" (
    "file" text primary key,
    "ts" timestamptz not null
  );
  `,

  sql`create table if not exists cats (
    "name" text primary key,
    "breed" text,
    "good_cat" boolean
  )`,
]

// poor man's migrate
export async function pgMigrate() {
  await sql`
  create table if not exists pmigrate (
    raw text primary key,
    ran_at timestamptz default now()
  )
  `

  for (const step of steps) {
    const describe = await step.describe()
    const raw = describe.string
    const [exists] = await sql`select ran_at from pmigrate where raw = ${raw}`
    if (!exists) {
      console.log('running', raw)
      await sql.begin(async (tx) => {
        await tx.unsafe(raw)
        await tx`insert into pmigrate values (${raw}, now())`
      })
    }
  }
}

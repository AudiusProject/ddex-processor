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
  create table if not exists "lsrLog" (
    "file" text primary key,
    "ts" timestamptz default now()
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

  sql`ALTER TABLE releases ADD COLUMN IF NOT EXISTS "ref" text;`,
  sql`ALTER TABLE releases ADD COLUMN IF NOT EXISTS "genre" text;`,
  sql`ALTER TABLE releases ADD COLUMN IF NOT EXISTS "subGenre" text;`,
  sql`ALTER TABLE releases ADD COLUMN IF NOT EXISTS "labelName" text;`,
  sql`ALTER TABLE releases ADD COLUMN IF NOT EXISTS "title" text;`,
  sql`ALTER TABLE releases ADD COLUMN IF NOT EXISTS "subTitle" text;`,
  sql`ALTER TABLE releases ADD COLUMN IF NOT EXISTS "artists" jsonb;`,
  sql`ALTER TABLE releases ADD COLUMN IF NOT EXISTS "contributors" jsonb;`,
  sql`ALTER TABLE releases ADD COLUMN IF NOT EXISTS "indirectContributors" jsonb;`,

  sql`
  ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS "releaseIds" jsonb,
  ADD COLUMN IF NOT EXISTS "isMainRelease" boolean,
  ADD COLUMN IF NOT EXISTS "audiusGenre" text,
  ADD COLUMN IF NOT EXISTS "audiusUser" text,
  ADD COLUMN IF NOT EXISTS "problems" jsonb,
  ADD COLUMN IF NOT EXISTS "soundRecordings" jsonb,
  ADD COLUMN IF NOT EXISTS "images" jsonb,
  ADD COLUMN IF NOT EXISTS "deals" jsonb,
  ADD COLUMN IF NOT EXISTS "copyrightLine" jsonb,
  ADD COLUMN IF NOT EXISTS "producerCopyrightLine" jsonb,
  ADD COLUMN IF NOT EXISTS "parentalWarningType" text;
  `,

  sql`
  CREATE INDEX IF NOT EXISTS idx_release_source_label_genre
  ON releases ("source", "labelName", "genre", "subGenre");
  `,

  sql`CREATE INDEX IF NOT EXISTS idx_release_timestamp ON releases ("messageTimestamp");`,
  sql`alter table releases drop column if exists "json"`,

  sql`
  create table if not exists publog (
    release_id text,
    actor text,
    ts timestamptz default now(),
    msg text,
    extra jsonb
  );`,
]

// poor man's migrate
export async function pgMigrate() {
  const [probe] =
    await sql`SELECT to_regclass('public.pmigrate') IS NOT NULL AS exists;`
  if (!probe!.exists) {
    await sql`
    create table if not exists pmigrate (
      raw text primary key,
      file_name text,
      ran_at timestamptz default now()
    )
    `
  }

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

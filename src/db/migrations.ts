import { sql } from './sql'

// todo: just do each item once
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

  await sql`
  CREATE TABLE IF NOT EXISTS users (
    "apiKey" text, -- app that user authorized
    "id" text,
    "handle" text not null,
    "name" text not null,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
    "password" text,
    primary key ("apiKey", "id")
  );
  `

  await sql`
  create table if not exists "s3markers" (
    "bucket" text primary key,
    "marker" text not null
  );
  `

  await sql`
  create table if not exists "isCleared" (
    "releaseId" text not null,
    "trackId" text not null,
    "isMatched" boolean,
    "isCleared" boolean,
    PRIMARY KEY ("releaseId", "trackId")
  );
  `

  await sql`
  create table if not exists "lsrLog" (
    "file" text primary key,
    "ts" timestamptz not null
  );
  `
}

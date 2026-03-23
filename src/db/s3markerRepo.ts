import { sql } from './sql'

export const s3markerRepo = {
  async get(bucket: string) {
    const [markerRow] =
      await sql`select marker from "s3markers" where bucket = ${bucket}`

    return markerRow?.marker || ''
  },

  async getListingPrefix(bucket: string): Promise<string | null> {
    const [row] =
      await sql`select listing_prefix from "s3markers" where bucket = ${bucket}`
    return row?.listing_prefix ?? null
  },

  async getLastModified(bucket: string): Promise<Date | null> {
    const [row] =
      await sql`select last_modified from "s3markers" where bucket = ${bucket}`
    return row?.last_modified ?? null
  },

  async upsert(bucket: string, marker: string, listingPrefix?: string | null, lastModified?: Date | null) {
    await sql`
      insert into "s3markers" (bucket, marker, listing_prefix, last_modified)
      values (${bucket}, ${marker}, ${listingPrefix ?? null}, ${lastModified ?? null})
      on conflict (bucket) do update set
        marker = ${marker},
        listing_prefix = coalesce(${listingPrefix ?? null}, s3markers.listing_prefix),
        last_modified = coalesce(${lastModified ?? null}, s3markers.last_modified)
    `
  },

  async reset(bucket: string) {
    await sql`delete from "s3markers" where bucket = ${bucket}`
  },
}

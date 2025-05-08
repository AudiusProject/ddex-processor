import { sql } from './sql'

export const s3markerRepo = {
  async get(bucket: string) {
    const [markerRow] =
      await sql`select marker from "s3markers" where bucket = ${bucket}`

    return markerRow?.marker || ''
  },

  async upsert(bucket: string, marker: string) {
    await sql`insert into "s3markers" values (${bucket}, ${marker}) on conflict (bucket) do update set marker = ${marker}`
  },
}

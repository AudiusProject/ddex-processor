import { IsClearedRow } from '../db'
import { sql } from './sql'

export const isClearedRepo = {
  async upsert(c: IsClearedRow) {
    await sql`
    insert into "isCleared" ${sql(c)}
    on conflict ("releaseId", "trackId") do update set
    "isMatched" = ${c.isMatched},
    "isCleared" = ${c.isCleared}
    `
  },

  async listForRelease(releaseId: string) {
    const rows: IsClearedRow[] =
      await sql`select * from "isCleared" where "releaseId" = ${releaseId}`
    const t: Record<string, boolean> = {}
    for (const row of rows) {
      t[row.trackId] = row.isCleared
    }
    return t
  },

  async updateCounts() {
    await sql`
      with "clearCount" as (
        select
          "releaseId",
          SUM(CASE WHEN "isCleared" THEN 1 ELSE 0 END) as "cleared",
          SUM(CASE WHEN "isCleared" THEN 1 ELSE 0 END) as "notCleared"
        from "isCleared"
        group by 1
      )
      update releases
      set "numCleared" = "cleared",
          "numNotCleared" = "notCleared"
      from "clearCount"
      where "releases"."key" = "clearCount"."releaseId"
    `
  },

  async isLsrDone(fileName: string) {
    const [row] = await sql`select ts from "lsrLog" where "file" = ${fileName}`
    return Boolean(row)
  },

  async markLsrDone(fileName: string) {
    const ts = new Date().toString()
    await sql`insert into "lsrLog" values (${fileName}, ${ts}) on conflict do nothing`
  },
}

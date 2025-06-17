//
// Resource repo
//

import { sql } from './sql'

export type AssetRow = {
  source: string
  releaseId: string
  ref: string
  xmlUrl: string
  filePath: string
  fileName: string
}

export const assetRepo = {
  async upsert(row: AssetRow) {
    await sql`
    insert into assets ${sql(row)}
    on conflict ("source", "releaseId", "ref") do update set
    "xmlUrl" = excluded."xmlUrl",
    "filePath" = excluded."filePath",
    "fileName" = excluded."fileName"
    `
  },

  async get(source: string, releaseId: string, ref: string) {
    const rows =
      await sql`select * from assets where source = ${source} and "releaseId" = ${releaseId} and ref = ${ref}`
    return rows[0] as AssetRow
  },
}

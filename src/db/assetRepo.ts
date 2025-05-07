//
// Resource repo
//

import { sql } from './sql'

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

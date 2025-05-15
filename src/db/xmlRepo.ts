import { XmlRow } from '../db'
import { pgUpsert, sql } from './sql'

export const xmlRepo = {
  async all(cursor: string) {
    const rows: XmlRow[] = await sql`
      select * from xmls
      where "xmlUrl" > ${cursor}
      order by "xmlUrl"
      limit 1000`
    return rows
  },

  async get(xmlUrl: string) {
    const rows = await sql`select * from xmls where "xmlUrl" = ${xmlUrl}`
    return rows[0]
  },

  async find(query: string) {
    const xmls: XmlRow[] = await sql`
        select * from xmls
        where "xmlUrl" like '%' || ${query} || '%'
        order by "messageTimestamp" desc`
    return xmls
  },

  async upsert(row: Partial<XmlRow>) {
    await pgUpsert('xmls', 'xmlUrl', row)
  },
}

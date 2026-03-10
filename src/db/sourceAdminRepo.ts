//
// source admin repo
//

import { sql } from './sql'

export const sourceAdminRepo = {
  async listSourcesForHandle(handle: string): Promise<string[]> {
    const rows = await sql`
      select source_name from source_admins
      where lower(handle) = lower(${handle})
    `
    return (rows as unknown as { source_name: string }[]).map((r) => r.source_name)
  },

  async add(handle: string, sourceName: string): Promise<void> {
    await sql`
      insert into source_admins (handle, source_name)
      values (${handle.toLowerCase().trim()}, ${sourceName})
      on conflict (handle, source_name) do nothing
    `
  },

  async remove(handle: string, sourceName: string): Promise<void> {
    await sql`
      delete from source_admins
      where lower(handle) = lower(${handle}) and source_name = ${sourceName}
    `
  },

  async listForSource(sourceName: string): Promise<string[]> {
    const rows = await sql`
      select handle from source_admins where source_name = ${sourceName}
    `
    return (rows as unknown as { handle: string }[]).map((r) => r.handle)
  },

  async all(): Promise<{ handle: string; source_name: string }[]> {
    const rows =
      await sql`select handle, source_name from source_admins order by source_name, handle`
    return rows as unknown as { handle: string; source_name: string }[]
  },
}

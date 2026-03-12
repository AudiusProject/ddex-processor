//
// user repo
//

import { UserRow } from '../db'
import { lowerAscii } from '../util'
import { sql } from './sql'

export const userRepo = {
  async all() {
    const users: UserRow[] = await sql`select * from users`
    return users
  },

  async findById(id: string) {
    const users: UserRow[] = await sql`select * from users where id = ${id}`
    return users[0]
  },

  async findByIdAndApiKey(id: string, apiKey: string) {
    const users: UserRow[] =
      await sql`select * from users where id = ${id} and "apiKey" = ${apiKey}`
    return users[0]
  },

  async upsert(user: UserRow) {
    await sql`
      insert into users ${sql(user)}
      on conflict ("id", "apiKey") do update set
      "name" = excluded."name",
      "login" = coalesce(excluded."login", users."login"),
      "lookupKey" = coalesce(excluded."lookupKey", users."lookupKey")
    `
  },

  async byApiKeys(apiKeys: string[]): Promise<UserRow[]> {
    if (apiKeys.length === 0) return []
    const users: UserRow[] =
      await sql`select * from users where "apiKey" = any(${apiKeys})`
    return users
  },

  async match(apiKey: string, artistNames: string[]) {
    const artistSet = new Set(artistNames.map(lowerAscii))
    const users = await sql`
      select * from users where "apiKey" = ${apiKey}
    `
    for (const u of users) {
      if (
        artistSet.has(lowerAscii(u.name)) ||
        artistSet.has(lowerAscii(u.handle))
      ) {
        return u.id
      }
    }
  },
}

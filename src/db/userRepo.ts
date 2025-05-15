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

  async upsert(user: UserRow) {
    await sql`
      insert into users ${sql(user)}
      on conflict ("id", "apiKey") do update set
      "name" = excluded."name"
    `
  },

  async match(apiKey: string, artistNames: string[]) {
    const artistSet = new Set(artistNames.map(lowerAscii))
    const users = await this.all()
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

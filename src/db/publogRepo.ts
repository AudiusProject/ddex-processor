import { sql } from './sql'

export type Publog = {
  release_id: string
  actor: string
  ts: Date
  msg: string
  extra: any
}

export const publogRepo = {
  async log(line: Partial<Publog>) {
    await sql`insert into publog ${sql(line)}`
  },
}

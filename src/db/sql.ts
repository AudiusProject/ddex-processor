import postgres from 'postgres'

export const sql = postgres({
  port: 40111,
  user: 'postgres',
  pass: 'example',
  database: 'ddex1',
})

//
//
//

export async function pgInsert(table: string, data: Record<string, any>) {
  await sql`insert into ${sql.unsafe(table)} ${sql(data)} on conflict do nothing`
}

export async function pgUpsert(
  table: string,
  pkField: string,
  data: Record<string, any>
) {
  await sql.begin(async (tx) => {
    const [prior] =
      await tx`select * from ${tx(table)} where ${tx(pkField)} = ${data[pkField]}`

    if (prior) data = Object.assign(prior, data)

    await tx`delete from ${tx(table)} where ${tx(pkField)} = ${data[pkField]}`
    await tx`insert into ${sql.unsafe(table)} ${sql(data)}`
  })
}

export async function pgUpdate(
  table: string,
  pkField: string,
  data: Record<string, any>
) {
  await sql`update ${sql.unsafe(table)} set ${sql(data)} where ${sql.unsafe(pkField)} = ${data[pkField]}`
}

export function ifdef(cond: any, stmt: any) {
  return cond ? stmt : sql``
}

//
// shutdown
process.once('SIGTERM', () => {
  sql.end()
})

process.once('SIGINT', () => {
  sql.end()
})

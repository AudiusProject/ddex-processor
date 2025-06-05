import postgres from 'postgres'

const conn =
  process.env.DB_URL || 'postgresql://postgres:example@127.0.0.1:40111/ddex1'

export const sql = postgres(conn)

//
//
//

export async function pgUpdate(
  table: string,
  pkField: string,
  data: Record<string, any>
) {
  await sql`update ${sql.unsafe(table)} set ${sql(data)} where ${sql.unsafe(pkField)} = ${data[pkField]}`
}

export async function pgUpsert(
  table: string,
  pkField: string,
  data: Record<string, any>
) {
  await sql`
    insert into ${sql(table)} ${sql(data)}
    ON CONFLICT (${sql(pkField)}) DO UPDATE
    SET ${Object.keys(data).map(
      (x, i) => sql`${i ? sql`,` : sql``}${sql(x)} = excluded.${sql(x)}`
    )}
  `
}

export function ifdef(cond: any, stmt: any) {
  return cond ? stmt : sql``
}

import { Hono } from 'hono'
import { html } from 'hono/html'
import { PropsWithChildren } from 'hono/jsx'
import { sql } from '../db/sql'

export const app = new Hono()

type StatsRow = {
  source: string
  count: number
}

app.get('/', async (c) => {
  const stats =
    await sql`select source, count(*) count from releases group by 1`.values()

  return c.html(
    <Layout title="stats">
      <h1>Stats</h1>

      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Release Count</th>
          </tr>
        </thead>
        {stats.map(([source, count]) => (
          <tr>
            <td>
              <a href={`/stats/${source}`}>{source}</a>
            </td>
            <td>{count}</td>
          </tr>
        ))}
      </table>
    </Layout>
  )
})

app.get('/:source', async (c) => {
  const source = c.req.param('source')
  const after = c.req.query('after')
  const stats = await sql`
    select
      "labelName",
      count(*) count,
      array_agg(distinct genre) genres
    from releases
    where source = ${source}
    ${after ? sql`and "labelName" > ${after}` : sql``}
    group by 1
    order by 2 desc
    limit 100
    `.values()

  return c.html(
    <Layout title={`stats: ${source}`}>
      <h1>Source: {source}</h1>

      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Release Count</th>
            <th>Genres</th>
          </tr>
        </thead>
        <tbody>
          {stats.map(([val, count, genres]) => (
            <tr>
              <td>
                <a href={`/releases?search=${encodeURIComponent(val)}`}>
                  {val}
                </a>
              </td>
              <td>{count}</td>
              <td>
                <div>
                  {genres.map((g: string) => (
                    <a
                      style="font-size: 80%; background: lightyellow; margin: 3px; padding: 3px;"
                      href={`/releases?search=${encodeURIComponent(g)}`}
                    >
                      {g}
                    </a>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {stats.length > 0 && (
        <div style="padding: 20px 0 40px 0">
          <a href={`?after=${encodeURIComponent(stats.at(-1)![0])}`}>NEXT</a>
        </div>
      )}
    </Layout>
  )
})

function Layout({ title, children }: PropsWithChildren<{ title: string }>) {
  return html`<!doctype html>
    <html>
      <head>
        <title>${title}</title>

        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css"
        />
      </head>
      <body>
        <div style="padding: 20px;">
          <a href="/releases">back to releases</a>
        </div>
        <div class="container">${children}</div>
      </body>
    </html>`
}

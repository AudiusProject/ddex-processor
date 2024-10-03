import * as cheerio from 'cheerio'
import { Hono } from 'hono'
import { FC } from 'hono/jsx'
import { releaseRepo, userRepo, xmlRepo } from './db'
import { parseDdexXml } from './parseDelivery'
import { JwtUser, Variables } from './server'
import { sources } from './sources'

export const cool = new Hono<{ Variables: Variables }>()

const Layout: FC = (props: {
  title?: string
  children?: any
  me?: JwtUser
  class?: string
}) => {
  const { me } = props
  return (
    <html lang="en-US">
      <head>
        <title>{props.title || 'DDEX'}</title>
        <link rel="stylesheet" href="/static/font.css" />
        <link rel="stylesheet" href="/static/output.css" />
      </head>
      <body class="bg-base-300">
        {me && (
          <div class="p-4 bg-purple-800 color-white">
            {me.handle} - {me.isAdmin ? 'admin' : 'user'}
          </div>
        )}
        <div class={props.class || ''}>{props.children}</div>
      </body>
    </html>
  )
}

cool.get('/users', (c) => {
  const users = userRepo.all()

  return c.html(
    <Layout me={c.get('me')}>
      <table class="table table-pin-rows">
        <thead>
          <tr>
            <th>id</th>
            <th>handle</th>
            <th>name</th>
            <th>api key</th>
            <th>created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr>
              <th>{user.id}</th>
              <th>{user.handle}</th>
              <th>{user.name}</th>
              <th>
                <b>{sources.findByApiKey(user.apiKey)?.name}</b>
              </th>
              <th>{user.createdAt}</th>
              <th>{user.createdAt}</th>
              <th></th>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  )
})

cool.get('/xmls', (c) => {
  const me = c.get('me')
  const xmls = xmlRepo.all()
  const x2 = xmls
    .filter((x) => !x.xmlUrl.includes('Batch'))
    .map((x) => {
      const $ = cheerio.load(x.xmlText, { xmlMode: true })
      return {
        ...x,
        onBehalfOf: $('SentOnBehalfOf FullName').text(),
        updateIndicator: $('UpdateIndicator').text(),
      }
    })
  return c.html(
    <Layout me={c.get('me')} class="m-4">
      <table class="table table-pin-rows">
        <thead>
          <tr>
            <th>Source</th>
            <th>URL</th>
            <th>Behalf Of</th>
            <th>Update?</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {x2.map((x) => (
            <tr>
              <td>{x.source}</td>
              <td>
                <a
                  class="link"
                  href={`/cool/xmls/${encodeURIComponent(x.xmlUrl)}`}
                >
                  {x.xmlUrl}
                </a>
              </td>
              <td>{x.onBehalfOf}</td>
              <td>{x.updateIndicator}</td>
              <td>{x.messageTimestamp}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  )
})

cool.get('/releases', (c) => {
  const rows = releaseRepo.all()
  return c.html(
    <Layout me={c.get('me')}>
      <div class="">
        <table class="table table-pin-rows">
          <thead>
            <tr>
              <th>Source</th>
              <th>Title</th>
              <th>Behalf Of</th>
              <th>Update?</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>{r.source}</td>
                <td>
                  <b>{r._parsed?.title}</b>
                  <br />
                  {r._parsed?.artists[0]?.name}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  )
})

cool.get('/xmls/:xmlUrl', (c) => {
  const xmlUrl = c.req.param('xmlUrl')
  const row = xmlRepo.get(xmlUrl)
  if (!row) return c.json({ error: 'not found' }, 404)

  let releases = parseDdexXml(row.source, row.xmlUrl, row.xmlText)
  if (!releases) return c.text('no release', 404)
  releases = releases.filter((r) => r.releaseType != 'TrackRelease')
  const mainRelease = releases.find((r) => r.isMainRelease) || releases[0]

  return c.html(
    <Layout
      title={`${mainRelease.title} - ${mainRelease.artists[0].name}`}
      me={c.get('me')}
    >
      <a href={`/xmls/${encodeURIComponent(xmlUrl)}`}>view xml</a>
      {releases.map((release) => (
        <>
          <div>
            {release.images.map((i) => (
              <img
                src={`/release/${release.releaseIds.icpn}/images/${i.ref}`}
                style="width: 200px; height: 200px; display: block; margin-bottom: 10px"
              />
            ))}
          </div>
          <div class="m-4 p-4 border">
            <h2 class="text-2xl font-[800]">{release.title}</h2>
            <div class="badge">{release.releaseType}</div>
            {release.soundRecordings.map((track) => (
              <div>
                {track.title} <em> by </em>
                {track.artists[0].name}
                <audio
                  src={`/release/${release.releaseIds.icpn}/soundRecordings/${track.ref}`}
                  controls
                />
              </div>
            ))}
          </div>
        </>
      ))}
    </Layout>
  )
})

cool.get('/button', (c) => {
  return c.html(
    <Layout>
      <div class="max-w-md bg-base-100 mx-auto my-8 rounded shadow p-8">
        <button class="btn btn-primary">Button!</button>
      </div>
    </Layout>
  )
})

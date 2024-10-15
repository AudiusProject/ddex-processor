import 'dotenv/config'

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { fromBuffer as fileTypeFromBuffer } from 'file-type'
import { Context, Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { html } from 'hono/html'
import { decode } from 'hono/jwt'
import { prettyJSON } from 'hono/pretty-json'
import { HtmlEscapedString } from 'hono/utils/html'
import { cool } from './_cool'
import {
  ReleaseProcessingStatus,
  kvRepo,
  releaseRepo,
  userRepo,
  xmlRepo,
} from './db'
import {
  DDEXContributor,
  DDEXRelease,
  parseDdexXml,
  reParsePastXml,
} from './parseDelivery'
import { prepareAlbumMetadata, prepareTrackMetadatas } from './publishRelease'
import { readAssetWithCaching } from './s3poller'
import { sources } from './sources'
import { parseBool, simulateDeliveryForUserName } from './util'

// read env
const { NODE_ENV, DDEX_URL } = process.env
const ADMIN_HANDLES = (process.env.ADMIN_HANDLES || '')
  .split(',')
  .map((h) => h.toLowerCase().trim())

// validate ENV
if (!DDEX_URL) console.warn('DDEX_URL not defined')

// globals
const COOKIE_NAME = 'audiusUser'
const COOKIE_SECRET = kvRepo.getCookieSecret()

const IS_PROD = NODE_ENV == 'production'
const API_HOST = IS_PROD
  ? 'https://discoveryprovider2.audius.co'
  : 'https://discoveryprovider2.staging.audius.co'
const AUDIUS_HOST = IS_PROD ? 'https://audius.co' : 'https://staging.audius.co'

export type Variables = {
  me: Awaited<ReturnType<typeof getAudiusUser>>
}
const app = new Hono<{ Variables: Variables }>()
app.use(prettyJSON({ space: 4 }))
app.use('/static/*', serveStatic({ root: './' }))

app.use(async (c, next) => {
  c.set('me', await getAudiusUser(c))
  await next()
})

app.get('/', async (c) => {
  const me = c.get('me')

  return c.html(
    Layout(html`
      <div class="container">
        <h1>Audius DDEX</h1>

        ${c.req.query('loginRequired')
          ? html`<mark>Please login to continue</mark><br />`
          : ''}
        ${me
          ? html`
              <h4>Welcome back @${me.handle}</h4>
              <a href="/auth/logout" role="button">log out</a>
            `
          : html`
              <div>
                ${sources
                  .all()
                  .map(
                    (s) => html`
                      <a role="button" href="/auth/source/${s.name}"
                        >${s.name}</a
                      >
                    `
                  )}
              </div>
            `}
      </div>
    `)
  )
})

app.get('/auth/source/:sourceName', (c) => {
  const sourceName = c.req.param('sourceName')
  const source = sources.findByName(sourceName)
  if (!source) {
    return c.text(`no source named: ${sourceName}`, 400)
  }
  const myUrl = DDEX_URL || 'http://localhost:8989'
  const base = IS_PROD
    ? 'https://audius.co/oauth/auth?'
    : 'https://staging.audius.co/oauth/auth?'
  const params = new URLSearchParams({
    scope: 'write',
    redirect_uri: `${myUrl}/auth/redirect`,
    api_key: source.ddexKey,
    response_mode: 'query',
  })
  const u = base + params.toString()
  return c.redirect(u)
})

app.get('/auth/redirect', async (c) => {
  try {
    const uri = c.req.query('redirect_uri') || ''
    const token = c.req.query('token')
    if (!token) {
      throw new Error('no token')
    }

    const jwt = decode(token!)
    const payload = jwt.payload as JwtUser
    if (!payload.userId) {
      throw new Error('invalid payload')
    }

    // upsert user record
    userRepo.upsert({
      apiKey: payload.apiKey,
      id: payload.userId,
      handle: payload.handle,
      name: payload.name,
    })

    // after user upsert, rescan for matches
    setTimeout(() => reParsePastXml(), 10)

    // set cookie
    const j = JSON.stringify(payload)
    await setSignedCookie(c, COOKIE_NAME, j, COOKIE_SECRET!)

    const params = new URLSearchParams({ token })
    return c.redirect(`${uri}/?` + params.toString())
  } catch (e) {
    console.log(e)
    return c.body('invalid jwt', 400)
  }
})

// ====================== AUTH REQUIRED ======================

app.use('*', async (c, next) => {
  const me = c.get('me')
  if (!me) return c.redirect('/?loginRequired=true')
  await next()
})

app.get('/auth/whoami', async (c) => {
  const me = c.get('me')
  return c.json({ me })
})

app.get('/auth/logout', async (c) => {
  deleteCookie(c, COOKIE_NAME)
  return c.redirect('/')
})

// ====================== ADMIN REQUIRED ======================

app.use('*', async (c, next) => {
  const me = c.get('me')
  if (!me?.isAdmin) {
    return c.text('you are not admin')
  }
  await next()
})

app.get('/releases', (c) => {
  const queryStatus = c.req.query('status')
  const querySource = c.req.query('source')
  const rows = releaseRepo.all({
    status: queryStatus,
    source: querySource,
    pendingPublish: parseBool(c.req.query('pendingPublish')),
  })

  return c.html(
    Layout(
      html`
        <h1>Releases</h1>

        <div style="display: flex; gap: 10px;">
          <!-- filters -->
          <form style="display: flex; gap: 10px;">
            <select name="status" onchange="this.form.submit()">
              <option selected value="">Status</option>
              ${Object.values(ReleaseProcessingStatus).map(
                (s) =>
                  html`<option ${queryStatus == s ? 'selected' : ''}>
                    ${s}
                  </option>`
              )}
            </select>
            <select name="source" onchange="this.form.submit()">
              <option selected value="">Source</option>
              ${sources
                .all()
                .map(
                  (s) =>
                    html`<option ${querySource == s.name ? 'selected' : ''}>
                      ${s.name}
                    </option>`
                )}
            </select>
          </form>

          <div style="flex-grow: 1"></div>

          <!-- actions -->
          <form method="POST" action="/releases/reparse">
            <button class="outline">re-parse</button>
          </form>
        </div>

        <table>
          <thead>
            <tr>
              <th></th>
              <th>Artist</th>
              <th>Genre</th>
              <th>Release</th>
              <th>Status</th>
              <th></th>
              <th></th>
              <th>debug</th>
            </tr>
          </thead>
          <tbody style="line-height: 1; white-space: nowrap;">
            ${rows.map(
              (row) =>
                html` <tr>
                  <td style="min-width: 80px;">
                    <img
                      src="/release/${row.key}/images/${row._parsed?.images[0]
                        ?.ref}/200"
                      width="80"
                      height="80"
                    />
                  </td>
                  <td class="truncate">
                    <a
                      href="/releases/${encodeURIComponent(row.key)}"
                      style="font-weight: bold; text-decoration: none;"
                    >
                      ${row._parsed?.title}
                    </a>
                    <div>
                      ${row._parsed?.audiusUser
                        ? audiusUserLink(row._parsed?.audiusUser)
                        : row._parsed?.artists[0]?.name}
                    </div>
                    <small>
                      <em
                        title="${row.messageTimestamp}"
                        class="pico-color-grey-500"
                      >
                        ${row._parsed?.labelName} via ${row.source}
                      </em>
                    </small>
                  </td>

                  <td>
                    ${row._parsed?.genre} <br />
                    <small>${row._parsed?.subGenre}</small>
                  </td>
                  <td>
                    ${row.releaseType}
                    <small> (${row._parsed?.soundRecordings.length})</small>
                    <br />
                    <small>${row.releaseDate}</small>
                  </td>
                  <td>
                    ${row.status}<br />
                    ${row._parsed?.problems?.map(
                      (p) => html`<small>${p} </small>`
                    )}
                  </td>
                  <td>
                    ${row.publishErrorCount > 0 &&
                    html`<a
                      href="/releases/${encodeURIComponent(row.key)}/error"
                      >${row.publishErrorCount}</a
                    >`}
                  </td>
                  <td>
                    ${row.entityType == 'track' &&
                    html` <a href="${API_HOST}/v1/full/tracks/${row.entityId}">
                      ${row.entityId}
                    </a>`}
                    ${row.entityType == 'album' &&
                    html` <a
                      href="${API_HOST}/v1/full/playlists/${row.entityId}"
                    >
                      ${row.entityId}
                    </a>`}
                  </td>
                  <td>
                    <a
                      href="/xmls/${encodeURIComponent(row.xmlUrl)}"
                      target="_blank"
                      >xml</a
                    >

                    <a
                      href="/releases/${encodeURIComponent(
                        row.key
                      )}/json?pretty"
                      target="_blank"
                      >parsed</a
                    >

                    <a href="/xmls/${encodeURIComponent(row.xmlUrl)}?parse=sdk"
                      >sdk</a
                    >
                  </td>
                </tr>`
            )}
          </tbody>
        </table>
      `,
      'Releases'
    )
  )
})

app.post('/releases/reparse', async (c) => {
  reParsePastXml()
  return c.redirect('/releases')
})

app.get('/releases/:key', (c) => {
  const row = releaseRepo.get(c.req.param('key'))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (c.req.query('json') != undefined) {
    return c.json(row)
  }

  const parsedRelease = row._parsed!

  const mapArtist = (c: DDEXContributor) =>
    html`<li><span>${c.name}</span>: <em>${c.role}</em></li>`

  return c.html(
    Layout(
      html`
        <div style="display: flex; gap: 20px">
          <div style="text-align: center">
            <img
              src="/release/${row.key}/images/${parsedRelease.images[0]
                ?.ref}/200"
              style="width: 200px; height: 200px; display: block; margin-bottom: 10px"
            />
            <mark>${parsedRelease.parentalWarningType}</mark>
          </div>

          <div style="flex-grow: 1">
            <h3 style="margin-bottom: 0">${parsedRelease.title}</h3>
            <h5>
              ${parsedRelease.artists
                .slice(0, 1)
                .map(
                  (a) =>
                    html`<em style="margin-right: 5px" data-tooltip="${a.role}"
                      >${a.name}</em
                    >`
                )}
            </h5>
            ${parsedRelease.soundRecordings.map(
              (sr) => html`
                <article style="display: flex; gap: 20px">
                  <div>
                    <button
                      class="outline contrast"
                      onClick="play('/release/${row.key}/soundRecordings/${sr.ref}')"
                    >
                      play
                    </button>
                  </div>
                  <div style="flex-grow: 1">
                    <div>
                      <h4 style="margin-bottom: 0">${sr.title}</h4>
                      <em>${sr.artists[0]?.name}</em>
                    </div>

                    <div style="margin-left: 10px; display: none">
                      <h6>Artists</h6>
                      <ul>
                        ${sr.artists.map(mapArtist)}
                      </ul>
                      <h6>Contributors</h6>
                      <ul>
                        ${sr.contributors.map(mapArtist)}
                      </ul>
                      <h6>Indirect Contributors</h6>
                      <ul>
                        ${sr.indirectContributors.map(mapArtist)}
                      </ul>
                    </div>
                  </div>
                </article>
              `
            )}

            <audio id="playa" controls />
          </div>
        </div>
        <script>
          function play(url) {
            playa.onloadstart = () => {
              console.log('loading...')
            }
            playa.oncanplay = () => {
              console.log('OK')
            }
            if (playa.src.includes(url)) {
              playa.paused ? playa.play() : playa.pause()
            } else {
              playa.src = url
              playa.play()
            }
          }
        </script>
      `,
      parsedRelease.title
    )
  )
})

app.get('/release/:key/:type/:ref/:size?', async (c) => {
  const key = c.req.param('key')!
  const type = c.req.param('type')
  const ref = c.req.param('ref')
  const size = c.req.param('size')
  const row = releaseRepo.get(key)
  if (!row) return c.json({ error: 'not found' }, 404)

  const collection =
    type == 'images' ? row._parsed?.images : row._parsed?.soundRecordings
  const asset = collection!.find((i) => i.ref == ref)
  if (!asset) return c.json({ error: 'not found' }, 404)

  const ok = await readAssetWithCaching(
    row.xmlUrl,
    asset.filePath,
    asset.fileName,
    size
  )

  // some mime stuff
  if (asset.fileName.endsWith('flac')) {
    c.header('Content-Type', 'audio/flac')
  } else {
    const ft = await fileTypeFromBuffer(ok.buffer)
    if (ft) {
      c.header('Content-Type', ft.mime)
    }
  }
  return c.body(ok.buffer)
})

app.get('/xmls/:xmlUrl', (c) => {
  const xmlUrl = c.req.param('xmlUrl')
  const row = xmlRepo.get(xmlUrl)
  if (!row) return c.json({ error: 'not found' }, 404)

  // parse=true will parse the xml to internal representation
  if (parseBool(c.req.query('parse'))) {
    const parsed = parseDdexXml(
      row.source,
      row.xmlUrl,
      row.xmlText
    ) as DDEXRelease[]

    // parse=sdk will convert internal representation to SDK friendly format
    if (c.req.query('parse') == 'sdk') {
      const sdkReleases = parsed.map((release) => {
        const tracks = prepareTrackMetadatas(release)
        if (tracks.length > 1) {
          const album = prepareAlbumMetadata(release)
          return {
            ref: release.ref,
            album,
            tracks,
          }
        } else {
          return {
            ref: release.ref,
            track: tracks[0],
          }
        }
      })
      return c.json(sdkReleases)
    }
    return c.json(parsed)
  }
  c.header('Content-Type', 'text/xml')
  return c.body(row.xmlText)
})

app.get('/releases/:key/json', (c) => {
  const row = releaseRepo.get(c.req.param('key'))
  if (!row) return c.json({ error: 'not found' }, 404)
  c.header('Content-Type', 'application/json')
  return c.body(row?.json)
})

app.get('/releases/:key/error', (c) => {
  const row = releaseRepo.get(c.req.param('key'))
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.text(row.lastPublishError)
})

app.get('/users', (c) => {
  const users = userRepo.all()
  return c.html(
    Layout(
      html`<h1>Users</h1>

        <table>
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
            ${users.map(
              (user) =>
                html`<tr>
                  <td>${user.id}</td>
                  <td>${user.handle}</td>
                  <td>${user.name}</td>
                  <td>
                    <b title="${user.apiKey}"
                      >${sources.findByApiKey(user.apiKey)?.name}</b
                    >
                  </td>
                  <td>${user.createdAt}</td>
                  <td>
                    ${!IS_PROD &&
                    html`
                      <form action="/users/simulate/${user.apiKey}/${user.id}">
                        <select
                          name="exampleFileName"
                          required
                          onchange="this.form.submit()"
                        >
                          <option selected disabled value="">
                            Simulate Delivery
                          </option>
                          <optgroup label="Track">
                            <option value="track_basic.xml">Basic</option>
                            <option value="track_follow_gated.xml">
                              Follow Gated Stream / Tip Gated Download
                            </option>
                            <option value="track_pay_gated.xml">
                              Pay Gated
                            </option>
                          </optgroup>
                          <optgroup label="Album">
                            <option value="album_basic.xml">Basic</option>
                          </optgroup>
                        </select>
                      </form>
                    `}
                  </td>
                </tr>`
            )}
          </tbody>
        </table> `
    )
  )
})

app.route('/cool', cool)

app.get('/users/simulate/:apiKey/:id', async (c) => {
  if (IS_PROD) {
    return c.text(`simulate delivery is disabled in prod`, 400)
  }

  // find source
  const source = sources.all().find((s) => s.ddexKey == c.req.param('apiKey'))
  const user = userRepo.findOne({
    id: c.req.param('id'),
    apiKey: c.req.param('apiKey'),
  })
  const exampleFileName = c.req.query('exampleFileName')

  if (!source || !user || !exampleFileName) {
    return c.text(`invalid simulate request`, 400)
  }

  // simulate delivery
  await simulateDeliveryForUserName(source, exampleFileName, user.name)

  return c.redirect('/releases')
})

export type JwtUser = {
  userId: string
  email: string
  name: string
  handle: string
  verified: boolean
  profilePicture: {
    '150x150': string
    '480x480': string
    '1000x1000': string
  }
  apiKey: string

  // added stuff
  isAdmin: boolean
}

async function getAudiusUser(c: Context) {
  const j = await getSignedCookie(c, COOKIE_SECRET!, COOKIE_NAME)
  if (!j) return
  const me = JSON.parse(j) as JwtUser
  me.isAdmin = ADMIN_HANDLES.includes(me.handle.toLowerCase())
  return me
}

function audiusUserLink(id: string) {
  const user = userRepo.findOne({ id })
  if (!user) {
    return html`User ${id} not in database`
  }
  return html`<a
    href="${AUDIUS_HOST}/${user.handle}"
    title="${user.handle}"
    target="_blank"
    >${user.name}</a
  >`
}

function Layout(
  inner: HtmlEscapedString | Promise<HtmlEscapedString>,
  title?: string
) {
  return html`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title ? title : 'ddex'}</title>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css"
        />
        <style>
          :root {
            --pico-font-size: 16px;
            --pico-line-height: 1.3;
            // --pico-border-radius: 1rem;
            // --pico-spacing: 0.5rem;
            // --pico-form-element-spacing-vertical: 0.5rem;
          }
          h1 {
            --pico-typography-spacing-vertical: 0.5rem;
          }
          button {
            --pico-font-weight: 700;
          }
          mark {
            margin-right: 3px;
          }
          .bold {
            font-weight: bold;
          }
          .topbar {
            display: flex; gap: 10px; padding: 10px;
          }
          .topbar a {
            text-decoration: none;
          }
          .truncate {
            max-width: 300px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
        </style>
      </head>
      <body>
        <div class="topbar">
          <a href="/"><b>ddex</b></a>
          <a href="/releases">releases</a>
          <a href="/users">users</a>
        </div>
        <div style="padding: 50px;">${inner}</div>
      </body>
    </html>
  `
}

export function startServer() {
  const port = 8989
  console.log(`Server is running on port ${port}`)

  const server = serve({
    fetch: app.fetch,
    port,
  })

  // shutdown
  process.once('SIGTERM', () => server.close())
  process.once('SIGINT', () => server.close())
}

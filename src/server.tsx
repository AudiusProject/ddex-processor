import 'dotenv/config'

import { GetObjectCommand } from '@aws-sdk/client-s3'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { fromBuffer as fileTypeFromBuffer } from 'file-type'
import { Context, Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { html } from 'hono/html'
import { decode } from 'hono/jwt'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { HtmlEscapedString } from 'hono/utils/html'
import { publishToClaimableAccount } from './claimable/createUserPublish'
import {
  ReleaseProcessingStatus,
  assetRepo,
  isClearedRepo,
  kvRepo,
  releaseRepo,
  userRepo,
  xmlRepo,
} from './db'
import { DDEXContributor, DDEXRelease, parseDdexXml } from './parseDelivery'
import { prepareAlbumMetadata, prepareTrackMetadatas } from './publishRelease'
import { formatDateToYYYYMMDD, getPriorMonth } from './reporting/date_utils'
import { generateSalesReport } from './reporting/sales_report'
import { dialS3, parseS3Url, readAssetWithCaching } from './s3poller'
import { sources } from './sources'
import { parseBool } from './util'

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
app.use(logger())
app.use(prettyJSON({ space: 4 }))
app.use('/static/*', serveStatic({ root: './' }))

app.use(async (c, next) => {
  c.set('me', await getAudiusUser(c))
  await next()
})

app.get('/', async (c) => {
  const me = c.get('me')
  const authSources = sources.all().filter((s) => s.ddexKey && s.ddexSecret)
  const firstSource = authSources[0]
  if (!firstSource) {
    return c.text(
      'No valid sources found.  Check data/sources.json is configured correctly',
      500
    )
  }

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
                <div>
                  <a role="button" href="/auth/source/${firstSource.name}">
                    Login
                  </a>
                </div>

                <div style="margin-top: 50px">
                  <div>Or Choose Auth Provider (Advanced)</div>
                  <div>
                    ${authSources.map(
                      (s) => html`
                        <a style="padding: 4px" href="/auth/source/${s.name}">
                          ${s.name}
                        </a>
                      `
                    )}
                  </div>
                </div>
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
    // todo: reparsing all actually takes a while now
    // and blocks up the webserver for multiple seconds
    // so probably need to move worker to a separate process...
    // setTimeout(() => reParsePastXml(), 10)

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
  const queryCleared = c.req.query('cleared') == 'on'
  const querySearch = c.req.query('search')
  const queryStatus = c.req.query('status')
  const querySource = c.req.query('source')
  const limit = parseInt(c.req.query('limit') || '100')
  const offset = parseInt(c.req.query('offset') || '0')
  const rows = releaseRepo.all({
    status: queryStatus,
    source: querySource,
    pendingPublish: parseBool(c.req.query('pendingPublish')),
    limit,
    offset,
    search: querySearch,
    cleared: queryCleared,
  })

  const showPagination = offset || rows.length == limit

  function withQueryParam(k: string, v: any) {
    const u = new URL(c.req.url)
    u.searchParams.set(k, v)
    if (k != 'offset') {
      u.searchParams.delete('offset')
    }
    return u.toString()
  }

  function searchLink(val?: string) {
    if (!val) return
    return html`<a
      class="plain contrast"
      href="${withQueryParam('search', `"${val}"`)}"
    >
      ${val}
    </a>`
  }

  c.header('Cache-Control', 'max-age=300')
  return c.html(
    Layout(
      html`
        <h1>Releases</h1>

        <div style="display: flex; gap: 10px;">
          <!-- filters -->
          <form style="display: flex; flex-grow: 1; gap: 10px;">
            <input name="search" placeholder="Search" value="${querySearch}" />
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
            <label style="display: flex; align-items: center;">
              <input
                name="cleared"
                type="checkbox"
                role="switch"
                ${queryCleared ? 'checked' : ''}
                onchange="this.form.submit()"
              />
              Cleared
            </label>
          </form>

          ${showPagination &&
          html`<div>
            <a
              role="button"
              class="outline contrast"
              href="${withQueryParam('offset', offset - limit)}"
              ${offset == 0 ? 'disabled' : ''}
            >
              ⫷
            </a>
            <a
              role="button"
              class="outline contrast"
              href="${withQueryParam('offset', limit + offset)}"
            >
              ⫸
            </a>
          </div>`}
        </div>

        <table>
          <thead>
            <tr>
              <th></th>
              <th>Artist</th>
              <th>Genre</th>
              <th>Release</th>
              <th>Status</th>
              <th>Clear</th>
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
                      src="/release/${row.source}/${row.key}/${row._parsed
                        ?.images[0]?.ref}/200"
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
                        : searchLink(row._parsed?.artists[0]?.name)}
                    </div>
                    <small>
                      <em
                        title="${row.messageTimestamp}"
                        class="pico-color-grey-500"
                      >
                        ${searchLink(row._parsed?.labelName)} via ${row.source}
                      </em>
                    </small>
                  </td>

                  <td>
                    ${searchLink(row._parsed?.genre)}
                    <br />
                    <small>${searchLink(row._parsed?.subGenre)}</small>
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
                    ${row.numCleared != undefined &&
                    html`<div>
                      <b
                        title="${row.numCleared} cleared
${row.numNotCleared} not cleared
${row._parsed?.soundRecordings.length} tracks"
                      >
                        ${(
                          (row.numCleared /
                            (row._parsed?.soundRecordings.length || 1)) *
                          100
                        ).toFixed() + '%'}
                      </b>
                    </div>`}
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
                  <td>${debugLinks(row.xmlUrl, row.key)}</td>
                </tr>`
            )}
          </tbody>
        </table>
      `,
      querySearch || 'Releases'
    )
  )
})

app.get('/releases/:key', (c) => {
  const releaseId = c.req.param('key')
  const row = releaseRepo.get(releaseId)
  if (!row) return c.json({ error: 'not found' }, 404)
  if (c.req.query('json') != undefined) {
    return c.json(row)
  }

  function searchLink(val?: string) {
    if (!val) return
    const u = new URL('/releases', c.req.url)
    u.searchParams.set('search', `"${val}"`)
    return html`<a class="plain contrast" href="${u.toString()}"> ${val} </a>`
  }

  function infoRowLink(key: string, val: string) {
    if (!val) return
    return html` <tr>
      <td class="key">${key}</td>
      <td>${searchLink(val)}</td>
    </tr>`
  }

  const parsedRelease = row._parsed!
  const clears = isClearedRepo.listForRelease(releaseId)

  const allUsers = userRepo.all()

  const associatedUser = parsedRelease.audiusUser
    ? allUsers.find((u) => u.id == parsedRelease.audiusUser)
    : undefined

  const mapArtist = (section: string) => (c: DDEXContributor) =>
    html`<tr>
      <td>${searchLink(c.name)}</td>
      <td>${c.role}</td>
      <td>${section}</td>
    </tr>`

  return c.html(
    Layout(
      html`
        <div style="display: flex; gap: 20px">
          <div>
            <img
              src="/release/${row.source}/${row.key}/${parsedRelease.images[0]
                ?.ref}/200"
              style="width: 200px; height: 200px; display: block; margin-bottom: 10px"
            />

            <mark>${parsedRelease.parentalWarningType}</mark>
          </div>

          <div style="flex-grow: 1">
            <h3 style="margin-bottom: 0">
              ${parsedRelease.title} ${parsedRelease.subTitle}
            </h3>
            <h6>
              ${parsedRelease.artists
                .slice(0, 1)
                .map((a) => searchLink(a.name))}
            </h6>

            ${parsedRelease.soundRecordings.map(
              (sr) => html`
                <article style="display: flex; gap: 20px">
                  <div>
                    <button
                      class="outline contrast"
                      onClick="play('/release/${row.source}/${row.key}/${sr.ref}')"
                    >
                      play
                    </button>
                  </div>
                  <div style="flex-grow: 1">
                    <div style="padding: 10px 0">
                      <div style="float: right">
                        ${clears[sr.isrc!] === true && (
                          <mark class="cleared">Cleared</mark>
                        )}
                        ${clears[sr.isrc!] === false && (
                          <mark class="not-cleared">Not Cleared</mark>
                        )}
                      </div>
                      <h4>${sr.title} ${sr.subTitle}</h4>
                    </div>

                    <table style="display: block; font-size: 90%;">
                      <tbody>
                        ${sr.artists.map(mapArtist('Artist'))}
                        ${sr.contributors.map(mapArtist('Contributor'))}
                        ${sr.indirectContributors.map(
                          mapArtist('Indicrect Contributor')
                        )}
                      </tbody>
                    </table>
                  </div>
                </article>
              `
            )}

            <audio id="playa" controls></audio>
          </div>
          <hr />

          <div>
            <div style="padding: 4px">
              ${debugLinks(row.xmlUrl, row.key)}
              <hr />
              ${row.status}<br />
              ${row._parsed?.problems?.map((p) => html`<small>${p} </small>`)}
              <hr />
            </div>

            <table style="width: 100%; font-size: 90%;" class="compact">
              ${infoRowLink('Source', row.source)}
              ${infoRowLink('Label', parsedRelease.labelName)}
              ${infoRowLink('Genre', parsedRelease.genre)}
              ${infoRowLink('SubGenre', parsedRelease.subGenre)}
              ${infoRowLink('Release', parsedRelease.releaseDate)}
            </table>

            ${row.entityType == 'track' &&
            html` <article>
              <header>Audius Track</header>
              <a href="${API_HOST}/v1/full/tracks/${row.entityId}">
                ${row.entityId}
              </a>
            </article>`}
            ${row.entityType == 'album' &&
            html` <article>
              <header>Audius Album</header>
              <a href="${API_HOST}/v1/full/playlists/${row.entityId}">
                ${row.entityId}
              </a>
            </article>`}

            <article>
              <header>Audius User</header>

              ${associatedUser && (
                <div>
                  <b>{associatedUser.handle}</b>
                  <br />
                  {row.prependArtist && <mark>Label Account</mark>}
                </div>
              )}

              <details style="margin-top: 20px">
                <summary>Edit</summary>
                <form action="/associate/${releaseId}">
                  <fieldset>
                    <select name="userId" required>
                      <option value="">Select User</option>
                      ${allUsers.map(
                        (u) => html`<option value="${u.id}">${u.name}</option>`
                      )}
                    </select>

                    <label
                      title="Checking label account will prepend artist to track title."
                    >
                      <input type="checkbox" name="prependArtist" />
                      Label Account
                    </label>

                    <button>Associate</button>
                  </fieldset>
                </form>
              </details>
            </article>

            <hr />

            <details>
              <summary>Publish</summary>
              <mark>Warning!</mark>
              <ul>
                <li>
                  This will publish this release. Please verify release date +
                  cleared status.
                </li>
                ${!associatedUser &&
                html`<li>
                  This will create a claimable Audius account if no artist is
                  associated
                </li>`}
              </ul>
              <form action="/publish/${releaseId}" method="POST">
                <button>Publish</button>
              </form>
            </details>
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
        <style>
          .cleared {
            background: lightgreen;
          }
          .not-cleared {
            background: lightpink;
          }
        </style>
      `,
      parsedRelease.title
    )
  )
})

app.get('/stats', async (c) => {
  const stats = releaseRepo.stats()
  return c.json(stats)
})

app.get('/history/:key', async (c) => {
  const xmls = xmlRepo.find(c.req.param('key'))
  return c.html(
    Layout(html`
      <table>
        <thead>
          <tr>
            <th>S3</th>
            <th>Message Timestamp</th>
            <th>Created At</th>
            <th>Debug</th>
          </tr>
        </thead>

        <tbody>
          ${xmls.map((x) => (
            <tr>
              <td>
                <a href="">{x.xmlUrl}</a>
              </td>
              <td>{x.messageTimestamp}</td>
              <td>{x.createdAt}</td>
              <td>{debugLinks(x.xmlUrl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    `)
  )
})

app.get('/release/:source/:key/:ref/:size?', async (c) => {
  const source = c.req.param('source')
  const key = c.req.param('key')!
  const ref = c.req.param('ref')
  const size = c.req.param('size')

  const asset = assetRepo.get(source, key, ref)
  if (!asset) return c.json({ error: 'not found' }, 404)

  const ok = await readAssetWithCaching(
    asset.xmlUrl,
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
  c.header('Cache-Control', 'max-age=7200')
  return c.body(ok.buffer as any)
})

app.get('/xmls/:xmlUrl', async (c) => {
  const xmlUrl = c.req.param('xmlUrl')
  const row = xmlRepo.get(xmlUrl)
  if (!row) return c.json({ error: 'not found' }, 404)

  const source = sources.findByXmlUrl(xmlUrl)

  const client = dialS3(source)
  const { bucket, key } = parseS3Url(xmlUrl)
  const { Body } = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  )
  const xmlText = await Body!.transformToString()

  // parse=true will parse the xml to internal representation
  if (parseBool(c.req.query('parse'))) {
    const parsed = parseDdexXml(
      row.source,
      row.xmlUrl,
      xmlText
    ) as DDEXRelease[]

    // parse=sdk will convert internal representation to SDK friendly format
    if (c.req.query('parse') == 'sdk') {
      const sdkReleases = parsed.map((release) => {
        const tracks = prepareTrackMetadatas(source, {} as any, release)
        if (tracks.length > 1) {
          const album = prepareAlbumMetadata(source, {} as any, release)
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
  return c.body(xmlText)
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
              <th>password</th>
              <th>created</th>
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
                  <td>${user.password}</td>
                  <td>${user.createdAt}</td>
                </tr>`
            )}
          </tbody>
        </table> `
    )
  )
})

app.get('/associate/:releaseId', async (c) => {
  const releaseId = c.req.param('releaseId')
  const releaseRow = releaseRepo.get(releaseId)
  const release = releaseRow?._parsed
  const user = userRepo.findOne({ id: c.req.query('userId') })
  const source = sources.findByName(releaseRow?.source || '')
  if (!releaseRow || !user || !source || !release) {
    return c.text('not found', 404)
  }

  release.audiusUser = user.id

  releaseRepo.upsert(
    releaseRow.source,
    releaseRow.xmlUrl,
    releaseRow.messageTimestamp,
    release
  )

  releaseRepo.markPrependArtist(releaseId, c.req.query('prependArtist') == 'on')
  return c.redirect(`/releases/${releaseId}`)
})

app.post('/publish/:releaseId', async (c) => {
  const releaseId = c.req.param('releaseId')
  const releaseRow = releaseRepo.get(releaseId)
  const release = releaseRow?._parsed
  const source = sources.findByName(releaseRow?.source || '')
  if (!releaseRow || !source || !release) {
    return c.text('not found', 404)
  }

  // can exceed 60s request timeout, so fire and forget
  publishToClaimableAccount(releaseId)
  return c.html(
    Layout(html`
      <h2>Publishing ${release.title}</h2>
      <ul>
        <li>Publishing can take a minute or two.</li>
        <li>When complete the release will Published status.</li>
        <li>
          You can return to the release page and refresh to check the status.
        </li>
      </ul>
      <p>
        <a href=${`/releases/${releaseId}`}>Back to release</a>
      </p>
    `)
  )

  // return c.redirect(`/releases/${releaseId}`)
})

app.get('/report', (c) => {
  const [start, end] = getPriorMonth()
  return c.html(
    Layout(
      html`
        <h2>Sales Report</h2>
        <form method="POST">
          <fieldset class="grid">
            <label>
              Source
              <select name="sourceName" required>
                <option selected disabled value="">Source</option>
                ${sources.all().map((s) => html`<option>${s.name}</option>`)}
              </select>
            </label>

            <label>
              Start Date
              <input
                type="date"
                name="start"
                required
                value="${formatDateToYYYYMMDD(start)}"
              />
            </label>

            <label>
              End Date
              <input
                type="date"
                name="end"
                required
                value="${formatDateToYYYYMMDD(end)}"
              />
            </label>
          </fieldset>
          <button>Generate</button>
        </form>
      `,
      'Sales Report'
    )
  )
})

app.post('/report', async (c) => {
  const body = await c.req.formData()
  const sourceName = body.get('sourceName')?.toString()
  const start = body.get('start')?.toString()
  const end = body.get('end')?.toString()
  if (!sourceName || !start || !end) {
    return c.text('missing required form value', 400)
  }
  const [fileName, result] = await generateSalesReport(sourceName, start, end)
  return c.body(result, 200, {
    'Content-Disposition': `attachment; filename="${fileName}"`,
  })
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

function debugLinks(xmlUrl: string, releaseId?: string) {
  return html`
    <a
      class="plain secondary"
      href="/xmls/${encodeURIComponent(xmlUrl)}"
      target="_blank"
      >xml</a
    >

    <a
      class="plain secondary"
      href="/xmls/${encodeURIComponent(xmlUrl)}?parse=true"
      target="_blank"
    >
      parsed
    </a>

    <a
      class="plain secondary"
      href="/xmls/${encodeURIComponent(xmlUrl)}?parse=sdk"
      >sdk</a
    >

    ${releaseId &&
    html`<a class="plain secondary" href="/history/${releaseId}">history</a>`}
  `
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
          .hidden {
            display: none;
          }
          a.plain {
            text-decoration: none;
          }

          table.compact td {
            padding: 8px;
            font-size: 95%;
          }
          table.compact td.key {
            text-transform: uppercase;
            font-size: 80%;
          }
        </style>
      </head>
      <body>
        <div class="topbar">
          <a href="/"><b>ddex</b></a>
          <a href="/releases">releases</a>
          <a href="/users">users</a>
          <a href="/stats" target="_blank">stats</a>
          <a href="/report">report</a>
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

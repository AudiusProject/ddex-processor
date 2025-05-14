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
  releaseRepo,
  userRepo,
  xmlRepo,
} from './db'
import { DDEXContributor, DDEXRelease, parseDdexXml } from './parseDelivery'
import { prepareAlbumMetadata, prepareTrackMetadatas } from './publishRelease'
import { generateSalesReport } from './reporting/sales_report'
import { dialS3, parseS3Url, readAssetWithCaching } from './s3poller'
import { sources } from './sources'
import { parseBool } from './util'

// read env
const { NODE_ENV, DDEX_URL, COOKIE_SECRET } = process.env
const ADMIN_HANDLES = (process.env.ADMIN_HANDLES || '')
  .split(',')
  .map((h) => h.toLowerCase().trim())

// validate ENV
if (!DDEX_URL) console.warn('DDEX_URL not defined')
if (!COOKIE_SECRET) {
  console.warn('COOKIE_SECRET env var missing')
  process.exit(1)
}

// globals
const COOKIE_NAME = 'audiusUser'

const IS_PROD = NODE_ENV == 'production'
const API_HOST = IS_PROD
  ? 'https://api.audius.co'
  : 'https://api.staging.audius.co'
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
    await userRepo.upsert({
      apiKey: payload.apiKey,
      id: payload.userId,
      handle: payload.handle,
      name: payload.name,
      createdAt: new Date(),
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

app.get('/releases', async (c) => {
  const queryCleared = c.req.query('cleared') == 'on'
  const querySearch = c.req.query('search')
  const queryStatus = c.req.query('status')
  const querySource = c.req.query('source')
  const limit = parseInt(c.req.query('limit') || '100')
  const offset = parseInt(c.req.query('offset') || '0')
  console.log('query', c.req.query())
  const rows = await releaseRepo.all({
    ...c.req.query(),
    pendingPublish: parseBool(c.req.query('pendingPublish')),
    cleared: queryCleared,
    limit: limit,
    offset: offset,
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
      href="${withQueryParam('search', `${val}`)}"
    >
      ${val}
    </a>`
  }

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
                      src="/release/${row.source}/${row.key}/${row.images[0]
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
                      ${row.title}
                    </a>
                    <div>
                      ${row.audiusUser
                        ? audiusUserLink(row.audiusUser)
                        : searchLink(row.artists[0]?.name)}
                    </div>
                    <small>
                      <em
                        title="${row.messageTimestamp}"
                        class="pico-color-grey-500"
                      >
                        ${searchLink(row.labelName)} via
                        <a
                          class="plain contrast"
                          href=${`?source=${row.source}`}
                        >
                          ${row.source}
                        </a>
                      </em>
                    </small>
                  </td>

                  <td>
                    ${searchLink(row.genre)}
                    <br />
                    <small>${searchLink(row.subGenre)}</small>
                  </td>
                  <td>
                    ${row.releaseType}
                    <small> (${row.soundRecordings.length})</small>
                    <br />
                    <small>${row.releaseDate}</small>
                  </td>
                  <td>
                    ${row.numCleared != undefined &&
                    html`<div>
                      <b
                        title="${row.numCleared} cleared
${row.numNotCleared} not cleared
${row.soundRecordings.length} tracks"
                      >
                        ${(
                          (row.numCleared / (row.soundRecordings.length || 1)) *
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

app.get('/releases/:key', async (c) => {
  const releaseId = c.req.param('key')
  const row = await releaseRepo.get(releaseId)
  if (!row) return c.json({ error: 'not found' }, 404)
  if (c.req.query('json') != undefined) {
    return c.json(row)
  }

  function searchLink(val?: string) {
    if (!val) return
    const u = new URL('/releases', c.req.url)
    u.searchParams.set('search', `${val}`)
    return html`<a class="plain contrast" href="${u.toString()}"> ${val} </a>`
  }

  function infoRowLink(key: string, val: string) {
    if (!val) return
    return html` <tr>
      <td class="key">${key}</td>
      <td>${searchLink(val)}</td>
    </tr>`
  }

  const parsedRelease = row
  const clears = await isClearedRepo.listForRelease(releaseId)
  const isFutureRelease = new Date(parsedRelease.releaseDate) > new Date()
  const isNoDeal = parsedRelease.deals.length == 0

  const allUsers = await userRepo.all()

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
        <div style="display: flex; align-items: center;">
          <div style="flex-grow: 1">
            <h1 style="margin-bottom: 0">
              ${parsedRelease.title} ${parsedRelease.subTitle}
            </h1>
            <h3>
              ${parsedRelease.artists
                .slice(0, 1)
                .map((a) => searchLink(a.name))}
            </h3>
          </div>
          <div>${debugLinks(row.xmlUrl, row.key)}</div>
        </div>

        <div style="display: flex; gap: 20px">
          <div>
            <img
              src="/release/${row.source}/${row.key}/${parsedRelease.images[0]
                ?.ref}/200"
              style="width: 200px; height: 200px; display: block; margin-bottom: 10px"
            />

            <table style="width: 100%; font-size: 90%;" class="compact">
              ${infoRowLink('Source', row.source)}
              ${infoRowLink('Label', parsedRelease.labelName)}
              ${infoRowLink('Genre', parsedRelease.genre)}
              ${infoRowLink('SubGenre', parsedRelease.subGenre)}
              ${infoRowLink('Release', parsedRelease.releaseDate)}
              ${infoRowLink(
                'Parental',
                parsedRelease.parentalWarningType || ''
              )}
            </table>
          </div>

          <div style="flex-grow: 1">
            ${parsedRelease.soundRecordings.map(
              (sr) => html`
                <article style="border-radius: 8px; display: flex; gap: 20px">
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
          </div>
          <hr />

          <div>
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
            ${associatedUser && (
              <article>
                <header>Audius User</header>
                <div>
                  {audiusUserLink(associatedUser.id)}
                  {row.prependArtist && (
                    <div>
                      <mark>Label Account</mark>
                    </div>
                  )}
                </div>
              </article>
            )}
            ${isFutureRelease && (
              <div>
                <mark>Future Release</mark>
              </div>
            )}
            ${isNoDeal && (
              <div>
                <mark>No Compatible Deal</mark>
              </div>
            )}
            <button
              ${isFutureRelease || isNoDeal ? 'disabled' : ''}
              onClick="PublishModal.showModal()"
            >
              Publish
            </button>
          </div>
        </div>

        <dialog id="PublishModal">
          <form action="/publish/${releaseId}" method="POST">
            <article>
              <h2>Publish</h2>
              <p>
                <mark>Warning!</mark>
                Please verify release date + cleared status.
              </p>

              <div>
                <fieldset>
                  <label>Audius User</label>
                  <select name="userId">
                    <option value="">Create claimable account</option>
                    ${allUsers.map((u) => (
                      <option
                        value={u.id}
                        selected={u.id == parsedRelease.audiusUser}
                      >
                        {u.name}
                      </option>
                    ))}
                  </select>

                  <label
                    title="Checking label account will prepend artist to track title."
                  >
                    <input type="checkbox" name="prependArtist" />
                    Label Account
                  </label>
                  <small>
                    Checking Label Account will prepend artist name to release
                    title.
                  </small>
                </fieldset>

                <fieldset>
                  <label>Audius Genre</label>
                  <select name="audiusGenre" required>
                    <option value="">Select Genre</option>
                    ${Object.values(Genre)
                      .filter((g) => g != 'All Genres')
                      .map((g) => (
                        <option selected={g == parsedRelease.audiusGenre}>
                          {g}
                        </option>
                      ))}
                  </select>
                </fieldset>
              </div>
              <footer>
                <div style="display: flex; gap: 10px">
                  <button
                    type="button"
                    class="secondary"
                    onClick="PublishModal.close()"
                  >
                    Cancel
                  </button>
                  <button type="submit">Publish</button>
                </div>
              </footer>
            </article>
          </form>
        </dialog>

        <div style="margin-top: 100px;"></div>
        <div class="playa-wrap">
          <audio id="playa" controls></audio>
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
          .playa-wrap {
            position: fixed;
            bottom: 0px;
            left: 0px;
            width: 100%;
            padding: 10px;
          }
          .playa-wrap audio {
            width: 100%;
          }
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

// app.get('/stats', async (c) => {
//   const stats = await releaseRepo.stats()
//   return c.json(stats)
// })

import { Genre } from '@audius/sdk'
import { formatDateToYYYYMMDD, getPriorMonth } from './reporting/date_utils'
import { app as stats } from './views/stats'
app.route('/stats', stats)

app.get('/history/:key', async (c) => {
  const xmls = await xmlRepo.find(c.req.param('key'))
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

  const asset = await assetRepo.get(source, key, ref)
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
  const row = await xmlRepo.get(xmlUrl)
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
    const parsed = (await parseDdexXml(
      row.source,
      row.xmlUrl,
      xmlText
    )) as DDEXRelease[]

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

app.get('/releases/:key/json', async (c) => {
  const row = await releaseRepo.get(c.req.param('key'))
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(row)
})

app.get('/releases/:key/error', async (c) => {
  const row = await releaseRepo.get(c.req.param('key'))
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.text(row.lastPublishError)
})

app.get('/users', async (c) => {
  const users = await userRepo.all()
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

app.post('/publish/:releaseId', async (c) => {
  const releaseId = c.req.param('releaseId')
  const releaseRow = await releaseRepo.get(releaseId)
  const release = releaseRow
  const source = sources.findByName(releaseRow?.source || '')
  if (!releaseRow || !source || !release) {
    return c.text('not found', 404)
  }

  const body = await c.req.parseBody()

  if (body.prependArtist == 'on') {
    await releaseRepo.markPrependArtist(releaseId, true)
  }

  if (body.userId) {
    release.audiusUser = body.userId as string
  }

  release.audiusGenre = body.audiusGenre as Genre

  await releaseRepo.upsert(
    releaseRow.source,
    releaseRow.xmlUrl,
    releaseRow.messageTimestamp,
    release
  )

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

async function audiusUserLink(id: string) {
  const user = await userRepo.findById(id)
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
          <a href="/stats">stats</a>
          <a href="/report">report</a>
        </div>
        <div style="padding: 20px 40px;">${inner}</div>
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
}

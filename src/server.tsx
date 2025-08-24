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
import { publishToClaimableAccount } from './claimable/createUserPublish'
import {
  ReleaseProcessingStatus,
  ReleaseRow,
  assetRepo,
  isClearedRepo,
  releaseRepo,
  userRepo,
  xmlRepo,
} from './db'
import { DDEXContributor, DDEXRelease, parseDdexXml } from './parseDelivery'
import { prepareAlbumMetadata, prepareTrackMetadatas } from './publishRelease'
import { generateSalesReport } from './reporting/sales_report'
import {
  dialS3,
  getPresignedAssetUrl,
  parseS3Url,
  readAssetWithCaching,
} from './s3poller'
import { sources } from './sources'
import { parseBool } from './util'

import { Genre } from '@audius/sdk'
import { stringify } from 'csv-stringify/sync'
import { publogRepo } from './db/publogRepo'
import { formatDateToYYYYMMDD, getPriorMonth } from './reporting/date_utils'
import { Layout2 } from './views/layout2'
import { app as stats } from './views/stats'

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
    <Layout2 title="DDEX">
      <div class="container">
        <h1>Audius DDEX</h1>

        {c.req.query('loginRequired') && (
          <>
            <mark>Please login to continue</mark>
            <br />
          </>
        )}

        {me ? (
          <>
            <h4>Welcome back @{me.handle}</h4>
            <a href="/auth/logout" role="button">
              log out
            </a>
          </>
        ) : (
          <div>
            <div>
              <a role="button" href={`/auth/source/${firstSource.name}`}>
                Login
              </a>
            </div>

            <div style="margin-top: 50px">
              <div>Or Choose Auth Provider (Advanced)</div>
              <div>
                {authSources.map((s) => (
                  <a style="padding: 4px" href={`/auth/source/${s.name}`}>
                    {s.name}
                  </a>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout2>
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
  let limit = parseInt(c.req.query('limit') || '100')
  let offset = parseInt(c.req.query('offset') || '0')
  console.log('query', c.req.query())

  const csvExport = parseBool(c.req.query('csv'))
  if (csvExport) {
    limit = 10000
    offset = 0
  }

  const rows = await releaseRepo.all({
    ...c.req.query(),
    pendingPublish: parseBool(c.req.query('pendingPublish')),
    cleared: queryCleared,
    limit: limit,
    offset: offset,
  })

  if (csvExport) {
    const csv = stringify(rows, {
      header: true,
      columns: Object.keys(rows[0] || {}),
    })
    c.header('Content-Type', 'text/csv')
    return c.body(csv)
  }

  const showPagination = offset || rows.length == limit

  function withQueryParam(k: string, v: any) {
    const u = requestUrl(c)
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
    <Layout2 title={querySearch || 'Releases'}>
      <h1>Releases</h1>

      <div style="display: flex; gap: 10px;">
        {/* <!-- filters --> */}
        <form style="display: flex; flex-grow: 1; gap: 10px;">
          <input name="search" placeholder="Search" value={querySearch} />
          <select name="status" onchange="this.form.submit()">
            <option selected value="">
              Status
            </option>
            {Object.values(ReleaseProcessingStatus).map((s) => (
              <option selected={queryStatus == s}>{s}</option>
            ))}
          </select>
          <select name="source" onchange="this.form.submit()">
            <option selected value="">
              Source
            </option>

            {sources.all().map((s) => (
              <option selected={querySource == s.name}>{s.name}</option>
            ))}
          </select>
          <label style="display: flex; align-items: center;">
            <input
              name="cleared"
              type="checkbox"
              role="switch"
              checked={queryCleared}
              onchange="this.form.submit()"
            />
            Cleared
          </label>
        </form>

        {showPagination && (
          <div>
            <a
              role="button"
              class="outline contrast"
              href={withQueryParam('offset', offset - limit)}
              disabled={offset == 0}
            >
              ⫷
            </a>
            <a
              role="button"
              class="outline contrast"
              href={withQueryParam('offset', limit + offset)}
            >
              ⫸
            </a>
          </div>
        )}

        <div>
          <a
            role="button"
            class="outline contrast"
            href={withQueryParam('csv', 'true')}
          >
            Export CSV
          </a>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th></th>
            <th>Artist</th>
            <th>Genre</th>
            <th>Release</th>
            <th>Clear</th>
            <th>Status</th>
            <th></th>
            <th></th>
            <th>debug</th>
          </tr>
        </thead>
        <tbody style="line-height: 1; white-space: nowrap;">
          {rows.map((row) => (
            <tr>
              <td style="min-width: 80px; width: 120px;">
                <img
                  src={`/release/${row.source}/${row.key}/${row.images[0]?.ref}/200`}
                  width="80"
                  height="80"
                />
              </td>
              <td class="truncate">
                <a
                  href={`/releases/${encodeURIComponent(row.key)}`}
                  style={{ fontWeight: 'bold', textDecoration: 'none' }}
                >
                  {row.title}
                </a>
                <div>
                  {row.audiusUser
                    ? audiusUserLink(row.audiusUser)
                    : searchLink(row.artists[0]?.name)}
                </div>
                <small>
                  <em title={row.messageTimestamp} class="pico-color-grey-500">
                    {searchLink(row.labelName)} via{' '}
                    <a class="plain contrast" href={`?source=${row.source}`}>
                      {row.source}
                    </a>
                  </em>
                </small>
              </td>

              <td>
                {searchLink(row.genre)}
                <br />
                <small>{searchLink(row.subGenre)}</small>
              </td>
              <td>
                {row.releaseType}
                <small> ({row.soundRecordings.length})</small>
                <br />
                <small>{row.releaseDate}</small>
              </td>
              <td>
                {row.numCleared != undefined && (
                  <div>
                    <b
                      title={`${row.numCleared} cleared
${row.numNotCleared} not cleared
${row.soundRecordings.length} tracks`}
                    >
                      {(
                        (row.numCleared / (row.soundRecordings.length || 1)) *
                        100
                      ).toFixed() + '%'}
                    </b>
                  </div>
                )}
              </td>
              <td>
                {row.status}
                {row.problems?.length > 0 && (
                  <div style={{ marginTop: '4px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {row.problems.map((p) => (
                      <span
                        style={{
                          display: 'inline-block',
                          border: '1px solid var(--pico-muted-border-color, #ccc)',
                          borderRadius: '4px',
                          padding: '1px 4px',
                          fontSize: '11px',
                          lineHeight: 1.4,
                        }}
                        title={p}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              <td>
                {row.publishErrorCount > 0 && (
                  <a href={`/releases/${encodeURIComponent(row.key)}/error`}>
                    {row.publishErrorCount}
                  </a>
                )}
              </td>
              <td>
                {row.entityType == 'track' && (
                  <a href={`${API_HOST}/v1/full/tracks/${row.entityId}`}>
                    {row.entityId}
                  </a>
                )}
                {row.entityType == 'album' && (
                  <a href={`${API_HOST}/v1/full/playlists/${row.entityId}`}>
                    {row.entityId}
                  </a>
                )}
              </td>
              <td>{debugLinks(row.xmlUrl, row.key)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout2>
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
    return (
      <a class="plain contrast" href={u.toString()}>
        {val}
      </a>
    )
  }

  function infoRowLink(key: string, val: string) {
    if (!val) return
    return (
      <tr>
        <td class="key">{key}</td>
        <td>{searchLink(val)}</td>
      </tr>
    )
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
    <Layout2 title={parsedRelease.title}>
      <>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ flexGrow: 1 }}>
            <h1 style={{ marginBottom: 0 }}>
              {parsedRelease.title} {parsedRelease.subTitle}
            </h1>
            <h3>{searchLink(parsedRelease.artists[0]?.name)}</h3>
          </div>
          <div>{debugLinks(row.xmlUrl, row.key)}</div>
        </div>

        <div style={{ display: 'flex', gap: '20px' }}>
          <div>
            <img
              src={`/release/${row.source}/${row.key}/${parsedRelease.images[0]?.ref}/200`}
              style={{
                width: '200px',
                height: '200px',
                display: 'block',
                marginBottom: '10px',
              }}
            />

            <table style={{ width: '100%', fontSize: '90%' }} class="compact">
              {infoRowLink('Source', row.source)}
              {infoRowLink('Label', parsedRelease.labelName)}
              {infoRowLink('Genre', parsedRelease.genre)}
              {infoRowLink('SubGenre', parsedRelease.subGenre)}
              {infoRowLink('Release', parsedRelease.releaseDate)}
              {infoRowLink('Parental', parsedRelease.parentalWarningType || '')}
            </table>
          </div>

          <div style={{ flexGrow: 1 }}>
            {parsedRelease.soundRecordings.map((sr) => (
              <article
                style={{ borderRadius: '8px', display: 'flex', gap: '20px' }}
              >
                <div>
                  <button
                    class="outline contrast"
                    onclick={`play("/release/${row.source}/${row.key}/${sr.ref}")`}
                  >
                    play
                  </button>
                </div>
                <div style={{ flexGrow: 1 }}>
                  <div style={{ padding: '10px 0' }}>
                    <div style={{ float: 'right', textAlign: 'right' }}>
                      <pre style="padding: 3px">{sr.isrc}</pre>
                      {clears[sr.isrc!] === true && (
                        <mark class="cleared">Cleared</mark>
                      )}
                      {clears[sr.isrc!] === false && (
                        <mark class="not-cleared">Not Cleared</mark>
                      )}
                    </div>
                    <h4>
                      {sr.title} {sr.subTitle}
                    </h4>
                  </div>
                  <table style={{ display: 'block', fontSize: '90%' }}>
                    <tbody>
                      {sr.artists.map(mapArtist('Artist'))}
                      {sr.contributors.map(mapArtist('Contributor'))}
                      {sr.indirectContributors.map(
                        mapArtist('Indirect Contributor')
                      )}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>

          <hr />

          <div>
            {row.entityType === 'track' && (
              <article>
                <header>Audius Track</header>
                <a href={`${API_HOST}/v1/full/tracks/${row.entityId}`}>
                  {row.entityId}
                </a>
              </article>
            )}

            {row.entityType === 'album' && (
              <article>
                <header>Audius Album</header>
                <a href={`${API_HOST}/v1/full/playlists/${row.entityId}`}>
                  {row.entityId}
                </a>
              </article>
            )}

            {associatedUser && (
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

            {isFutureRelease && (
              <div>
                <mark>Future Release</mark>
              </div>
            )}

            {isNoDeal && (
              <div style={{ margin: '8px 0' }}>
                <mark>No Compatible Deal</mark>
              </div>
            )}

            <button
              disabled={isFutureRelease || isNoDeal}
              onclick="PublishModal.showModal()"
            >
              Publish
            </button>
            {(isFutureRelease || isNoDeal) && (
              <div style={{ margin: '8px 0' }}>
                <a
                  href="#"
                  onclick="PublishModal.showModal(); return false;"
                >
                  Override
                </a>
              </div>
            )}
          </div>
        </div>

        <dialog id="PublishModal">
          <form action={`/publish/${releaseId}`} method="post">
            <article>
              <h2>Publish</h2>
              <p>
                <mark>Warning!</mark> Please verify release date + cleared
                status.
              </p>

              <div>
                <fieldset>
                  <label>Audius User</label>
                  <select name="userId">
                    <option value="">Create claimable account</option>
                    {allUsers.map((u) => (
                      <option
                        value={u.id}
                        selected={u.id === parsedRelease.audiusUser}
                      >
                        {u.name}
                      </option>
                    ))}
                  </select>

                  <label title="Checking label account will prepend artist to track title.">
                    <input type="checkbox" name="prependArtist" />
                    Label Account
                  </label>
                  <label title="Checking default deal will add default deal information to the release. Use with caution.">
                    <input type="checkbox" name="useDefaultDeal" />
                    Default Deal
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
                    {Object.values(Genre)
                      .filter((g) => g !== 'All Genres')
                      .map((g) => (
                        <option selected={g === parsedRelease.audiusGenre}>
                          {g}
                        </option>
                      ))}
                  </select>
                </fieldset>
              </div>

              <footer>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    type="button"
                    class="secondary"
                    onclick="PublishModal.close()"
                  >
                    Cancel
                  </button>
                  <button type="submit">Publish</button>
                </div>
              </footer>
            </article>
          </form>
        </dialog>

        <div style={{ marginTop: '100px' }}></div>
        <div class="playa-wrap">
          <audio id="playa" controls></audio>
        </div>

        {html`
          <script>
            function play(url) {
              playa.onloadstart = () => console.log('loading...')
              playa.oncanplay = () => console.log('OK')
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
        `}
      </>
    </Layout2>
  )
})

app.route('/stats', stats)

app.get('/history/:key', async (c) => {
  const xmls = await xmlRepo.find(c.req.param('key'))
  return c.html(
    <Layout2 title="XML History">
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
          {xmls.map((x) => (
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
    </Layout2>
  )
})

app.get('/release/:source/:key/:ref/:size?', async (c) => {
  const source = c.req.param('source')
  const key = c.req.param('key')!
  const ref = c.req.param('ref')
  const size = c.req.param('size')

  const asset = await assetRepo.get(source, key, ref)
  if (!asset) return c.json({ error: 'not found' }, 404)

  // If no resizing requested (a stream instead of an image),
  // redirect to presigned S3 URL to avoid proxying bytes
  if (!size) {
    const url = await getPresignedAssetUrl({
      xmlUrl: asset.xmlUrl,
      filePath: asset.filePath,
      fileName: asset.fileName,
      expiresInSeconds: 600
    })
    return c.redirect(url, 302)
  }

  // Resize requested: keep existing behavior (read, resize via cache helper) for now
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
    <Layout2 title="users">
      <h1>Users</h1>

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
          {users.map((user) => (
            <tr>
              <td>{user.id}</td>
              <td>{user.handle}</td>
              <td>{user.name}</td>
              <td>
                <b title="${user.apiKey}">
                  {sources.findByApiKey(user.apiKey)?.name}
                </b>
              </td>
              <td>{user.password}</td>
              <td>{user.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout2>
  )
})

app.post('/publish/:releaseId', async (c) => {
  const me = await getAudiusUser(c)
  const releaseId = c.req.param('releaseId')
  const releaseRow = await releaseRepo.get(releaseId)
  const release = releaseRow
  const source = sources.findByName(releaseRow?.source || '')
  if (!releaseRow || !source || !release || !me) {
    return c.text('not found', 404)
  }

  const body = await c.req.parseBody()

  if (body.prependArtist == 'on') {
    await releaseRepo.markPrependArtist(releaseId, true)
  }

  if (body.useDefaultDeal == 'on') {
    await releaseRepo.markUseDefaultDeal(releaseId, true)
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

  await publogRepo.log({
    actor: me.handle,
    msg: 'Pressed Publish',
    release_id: releaseRow.key,
    extra: body,
  })

  // can exceed 60s request timeout, so fire and forget
  // TODO: this will always publish new release
  // need to add conditional update logic
  publishToClaimableAccount(releaseId)

  return c.redirect(`/releases/${releaseId}/publog?poll=1`)
})

function ReleaseBanner({ release }: { release: ReleaseRow }) {
  return (
    <div style="display: flex; align-items: center;">
      <div style="flex-grow: 1">
        <h1 style="margin-bottom: 0">
          {release.title} {release.subTitle}
        </h1>
        <h3>
          {release.artists.slice(0, 1).map((a) => (
            <div>{a.name}</div>
          ))}
        </h3>
      </div>
      <div>{debugLinks(release.xmlUrl, release.key)}</div>
    </div>
  )
}

app.get('/releases/:releaseId/publog', async (c) => {
  const release = await releaseRepo.get(c.req.param('releaseId'))
  if (!release) {
    return c.text('not found', 404)
  }
  const logs = await publogRepo.forRelease(c.req.param('releaseId'))
  if (parseBool(c.req.query('json'))) {
    return c.json(logs)
  }
  return c.html(
    <Layout2 title="publog">
      <ReleaseBanner release={release} />
      <h4>Publish Log</h4>

      <table style="white-space: nowrap;">
        <tbody>
          {logs.map((log) => (
            <tr>
              <td>{log.ts.toLocaleString()}</td>
              <td>{log.actor}</td>
              <td>{log.msg}</td>
              <td>
                <pre style="margin: 0">{JSON.stringify(log.extra)}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style="display: flex; gap: 16px; font-size: 90%;">
        <a href={`/releases/${release.key}`}>Back to Release</a>
        <a href="?json=1">View as JSON</a>
      </div>

      {c.req.query('poll') &&
        html`
          <script>
            setTimeout(function () {
              window.location.reload(1)
            }, 5000)
          </script>
        `}
    </Layout2>
  )
})

app.get('/report', (c) => {
  const [start, end] = getPriorMonth()
  return c.html(
    <Layout2 title="Sales Report">
      <h2>Sales Report</h2>
      <form method="post">
        <fieldset class="grid">
          <label>
            Source
            <select name="sourceName" required>
              <option selected disabled value="">
                Source
              </option>
              {sources.all().map((s) => (
                <option>{s.name}</option>
              ))}
            </select>
          </label>

          <label>
            Start Date
            <input
              type="date"
              name="start"
              required
              value={formatDateToYYYYMMDD(start)}
            />
          </label>

          <label>
            End Date
            <input
              type="date"
              name="end"
              required
              value={formatDateToYYYYMMDD(end)}
            />
          </label>
        </fieldset>
        <button>Generate</button>
      </form>
    </Layout2>
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

app.get('/debug', async (c) => {
  const forwardedProto = c.req.header('x-forwarded-proto')
  const u = requestUrl(c)
  return c.json({
    rawUrl: c.req.url,
    url: u.toString(),
    forwardedProto,
  })
})

function requestUrl(c: Context): URL {
  const u = new URL(c.req.url)
  const forwardedProto = c.req.header('x-forwarded-proto')
  if (forwardedProto) {
    u.protocol = forwardedProto
  }
  return u
}

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
    html`
      <a class="plain secondary" href="/history/${releaseId}">history</a>
      <a class="plain secondary" href="/releases/${releaseId}/publog">publog</a>
    `}
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

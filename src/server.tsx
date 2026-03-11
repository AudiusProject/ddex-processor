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
import { sourceAdminRepo } from './db/sourceAdminRepo'
import { DDEXContributor, DDEXRelease, parseDdexXml } from './parseDelivery'
import { prepareAlbumMetadata, prepareTrackMetadatas } from './publishRelease'
import { generateSalesReport } from './reporting/sales_report'
import { dialS3, parseS3Url, readAssetWithCaching } from './s3poller'
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

const DDEX_API_KEY = process.env.DDEX_API_KEY

// validate ENV
if (!DDEX_URL) console.warn('DDEX_URL not defined')
if (!COOKIE_SECRET) {
  console.warn('COOKIE_SECRET env var missing')
  process.exit(1)
}
if (!DDEX_API_KEY) {
  console.warn('DDEX_API_KEY env var missing - login will not work')
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

function getNavMode(me: ResolvedUser | undefined): 'full' | 'source_admin' | 'none' {
  if (!me) return 'none'
  if (me.isSuperAdmin) return 'full'
  if (me.sourceAdminSources.length > 0) return 'source_admin'
  return 'none'
}

app.get('/', async (c) => {
  const me = c.get('me')
  const navMode = getNavMode(me)

  return c.html(
    <Layout2 title="DDEX" navMode={navMode}>
      <div class="container">
        <h1>Audius DDEX</h1>

        {c.req.query('loginRequired') && (
          <div style={{ marginBottom: '1.5rem' }}>
            <mark>Please login to continue</mark>
          </div>
        )}

        {me ? (
          <>
            <h4>Welcome back @{me.handle}</h4>
            <a href="/auth/logout" class="btn-secondary">
              Log out
            </a>
          </>
        ) : (
          DDEX_API_KEY ? (
            <a class="btn-secondary" href="/auth/login">
              Login
            </a>
          ) : (
            <mark>DDEX_API_KEY not configured. Set DDEX_API_KEY in env.</mark>
          )
        )}
      </div>
    </Layout2>
  )
})

app.get('/auth/login', (c) => {
  if (!DDEX_API_KEY) {
    return c.text('DDEX_API_KEY not configured', 500)
  }
  const myUrl = DDEX_URL || 'http://localhost:8989'
  const base = IS_PROD
    ? 'https://audius.co/oauth/auth?'
    : 'https://staging.audius.co/oauth/auth?'
  const params = new URLSearchParams({
    scope: 'write',
    redirect_uri: `${myUrl}/auth/redirect`,
    api_key: DDEX_API_KEY,
    response_mode: 'query',
  })
  return c.redirect(base + params.toString())
})

app.get('/auth/redirect', async (c) => {
  try {
    const uri = c.req.query('redirect_uri') || '/'
    const token = c.req.query('token')
    if (!token) {
      throw new Error('no token')
    }

    const jwt = decode(token!)
    const payload = jwt.payload as JwtUser
    if (!payload.userId) {
      throw new Error('invalid payload')
    }

    // set cookie (logged-in user; userRepo is for distribution users who authorized sources)
    const j = JSON.stringify(payload)
    await setSignedCookie(c, COOKIE_NAME, j, COOKIE_SECRET!)

    return c.redirect(uri)
  } catch (e) {
    console.log(e)
    return c.body('invalid jwt', 400)
  }
})

// ====================== AUTH REQUIRED (exclude /, /auth/*, /static/*) ======================

app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (path === '/' || path.startsWith('/auth/') || path.startsWith('/static/')) {
    return next()
  }
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

// ---------------------- Access helpers ----------------------

function requireSuperAdmin(c: Context): boolean {
  const me = c.get('me') as ResolvedUser | undefined
  if (!me?.isSuperAdmin) {
    return false
  }
  return true
}

function requireSourceAdminOrSuper(c: Context): boolean {
  const me = c.get('me') as ResolvedUser | undefined
  if (!me?.hasAnyAccess) {
    return false
  }
  return true
}

app.get('/releases', async (c) => {
  const me = c.get('me') as ResolvedUser
  if (!requireSourceAdminOrSuper(c)) {
    return c.text('Access denied', 403)
  }

  const queryCleared = c.req.query('cleared') == 'on'
  const querySearch = c.req.query('search')
  const queryStatus = c.req.query('status')
  let querySource = c.req.query('source')
  let limit = parseInt(c.req.query('limit') || '100')
  let offset = parseInt(c.req.query('offset') || '0')
  console.log('query', c.req.query())

  const allowedSources = me.isSuperAdmin
    ? sources.all().map((s) => s.name)
    : me.sourceAdminSources
  if (!me.isSuperAdmin && querySource && !allowedSources.includes(querySource)) {
    querySource = allowedSources[0] ?? ''
  }

  const csvExport = parseBool(c.req.query('csv'))
  if (csvExport) {
    limit = 10000
    offset = 0
  }

  const releaseParams: Parameters<typeof releaseRepo.all>[0] = {
    pendingPublish: parseBool(c.req.query('pendingPublish')),
    cleared: me.isSuperAdmin ? queryCleared : undefined,
    limit: limit,
    offset: offset,
    status: queryStatus || undefined,
    search: querySearch || undefined,
  }
  if (me.isSuperAdmin) {
    releaseParams.source = querySource || undefined
  } else {
    releaseParams.sources = allowedSources
  }

  const rows = await releaseRepo.all(releaseParams)

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

  const navMode = getNavMode(me)

  return c.html(
    <Layout2 title={querySearch || 'Releases'} navMode={navMode}>
      <h1>Releases</h1>

      <div class="releases-filter-bar">
        <form class="releases-filters-form">
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

            {allowedSources.map((name) => (
              <option selected={querySource == name}>{name}</option>
            ))}
          </select>
          {me.isSuperAdmin && (
            <label class="filter-toggle">
              <input
                name="cleared"
                type="checkbox"
                checked={queryCleared}
                onchange="this.form.submit()"
              />
              Cleared
            </label>
          )}
        </form>

        {showPagination && (
          <div class="releases-filter-bar-pagination">
            {offset == 0 ? (
              <span class="btn-secondary" aria-disabled="true">
                ← Prev
              </span>
            ) : (
              <a
                class="btn-secondary"
                href={withQueryParam('offset', offset - limit)}
              >
                ← Prev
              </a>
            )}
            <a
              class="btn-secondary"
              href={withQueryParam('offset', limit + offset)}
            >
              Next →
            </a>
          </div>
        )}

        <div class="releases-filter-bar-export">
          <a class="btn-export" href={withQueryParam('csv', 'true')}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="2"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" x2="12" y1="15" y2="3" />
            </svg>
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
                  <em title={row.messageTimestamp} class="text-muted">
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
  const me = c.get('me') as ResolvedUser
  if (!requireSourceAdminOrSuper(c)) {
    return c.text('Access denied', 403)
  }
  const releaseId = c.req.param('key')
  const row = await releaseRepo.get(releaseId)
  if (!row) return c.json({ error: 'not found' }, 404)
  if (
    !me.isSuperAdmin &&
    !me.sourceAdminSources.includes(row.source)
  ) {
    return c.text('Access denied', 403)
  }
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

  const navMode = getNavMode(me)
  return c.html(
    <Layout2 title={parsedRelease.title} navMode={navMode}>
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
                    type="button"
                    class="btn-secondary"
                    onclick={`play("/release/${row.source}/${row.key}/${sr.ref}")`}
                  >
                    Play
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
              type="button"
              class="btn-primary"
              disabled={isFutureRelease || isNoDeal}
              onclick="PublishModal.showModal()"
            >
              Publish
            </button>
            {(isFutureRelease || isNoDeal) && (
              <div style={{ margin: '8px 0' }}>
                <a href="#" onclick="PublishModal.showModal(); return false;">
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
                    class="btn-secondary"
                    onclick="PublishModal.close()"
                  >
                    Cancel
                  </button>
                  <button type="submit" class="btn-primary">
                    Publish
                  </button>
                </div>
              </footer>
            </article>
          </form>
        </dialog>

        <div style={{ marginTop: '100px' }}></div>
        <div class="playa-wrap" data-tracks={JSON.stringify(parsedRelease.soundRecordings.map((sr) => ({ url: `/release/${row.source}/${row.key}/${sr.ref}`, title: [sr.title, sr.subTitle].filter(Boolean).join(' '), artist: sr.artists[0]?.name || parsedRelease.artists[0]?.name || '' })))}>
          <audio id="playa" style="display:none"></audio>
          <div class="playa-player">
            <div class="playa-controls">
              <button type="button" class="playa-btn playa-btn-prev" id="playa-prev" aria-label="Previous" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
              </button>
              <button type="button" class="playa-btn playa-btn-play" id="playa-play" aria-label="Play">
                <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" id="playa-icon-play"><path d="M8 5v14l11-7z"/></svg>
                <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" id="playa-icon-pause" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              </button>
              <button type="button" class="playa-btn playa-btn-next" id="playa-next" aria-label="Next" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
              </button>
            </div>
            <div class="playa-track-info" id="playa-track-info">
              <span class="playa-track-title" id="playa-track-title">—</span>
              <span class="playa-track-artist" id="playa-track-artist"></span>
            </div>
            <div class="playa-progress-wrap">
              <span class="playa-time playa-time-current" id="playa-current">0:00</span>
              <div class="playa-progress-track">
                <input type="range" class="playa-progress" id="playa-progress" min="0" max="100" value="0" step="0.1" aria-label="Progress" />
              </div>
              <span class="playa-time playa-time-duration" id="playa-duration">0:00</span>
            </div>
          </div>
        </div>

        {html`
          <script>
            (function() {
              var tracksData = JSON.parse(document.querySelector('.playa-wrap').getAttribute('data-tracks') || '[]');
              var tracks = tracksData.map(function(t) { return typeof t === 'string' ? t : t.url; });
              var playa = document.getElementById('playa');
              var prevBtn = document.getElementById('playa-prev');
              var playBtn = document.getElementById('playa-play');
              var nextBtn = document.getElementById('playa-next');
              var progressEl = document.getElementById('playa-progress');
              var currentEl = document.getElementById('playa-current');
              var durationEl = document.getElementById('playa-duration');
              var iconPlay = document.getElementById('playa-icon-play');
              var iconPause = document.getElementById('playa-icon-pause');
              var trackTitleEl = document.getElementById('playa-track-title');
              var trackArtistEl = document.getElementById('playa-track-artist');
              var currentIndex = 0;
              var isSeeking = false;

              function formatTime(s) {
                var m = Math.floor(s / 60);
                var sec = Math.floor(s % 60);
                return m + ':' + (sec < 10 ? '0' : '') + sec;
              }
              function updateUI() {
                var hasTracks = tracks.length > 0;
                prevBtn.disabled = !hasTracks || currentIndex <= 0;
                nextBtn.disabled = !hasTracks || currentIndex >= tracks.length - 1;
                if (tracksData[currentIndex]) {
                  var t = tracksData[currentIndex];
                  trackTitleEl.textContent = (t.title || '—');
                  trackArtistEl.textContent = (t.artist || '');
                }
                if (!isSeeking && playa.duration && !isNaN(playa.duration)) {
                  progressEl.value = (playa.currentTime / playa.duration) * 100;
                  currentEl.textContent = formatTime(playa.currentTime);
                  durationEl.textContent = formatTime(playa.duration);
                }
                if (playa.paused) {
                  iconPlay.style.display = 'block';
                  iconPause.style.display = 'none';
                } else {
                  iconPlay.style.display = 'none';
                  iconPause.style.display = 'block';
                }
              }
              playa.addEventListener('timeupdate', updateUI);
              playa.addEventListener('loadedmetadata', function() {
                durationEl.textContent = formatTime(playa.duration);
              });
              playa.addEventListener('ended', function() {
                if (currentIndex < tracks.length - 1) {
                  currentIndex++;
                  playa.src = tracks[currentIndex];
                  playa.play();
                  updateUI();
                } else {
                  updateUI();
                }
              });
              prevBtn.onclick = function() {
                if (currentIndex > 0) {
                  currentIndex--;
                  playa.src = tracks[currentIndex];
                  playa.play();
                  updateUI();
                }
              };
              playBtn.onclick = function() {
                if (tracks.length === 0) return;
                if (playa.paused) {
                  if (!playa.src || playa.src === window.location.href) {
                    playa.src = tracks[currentIndex];
                  }
                  playa.play();
                } else {
                  playa.pause();
                }
              };
              nextBtn.onclick = function() {
                if (currentIndex < tracks.length - 1) {
                  currentIndex++;
                  playa.src = tracks[currentIndex];
                  playa.play();
                  updateUI();
                }
              };
              progressEl.addEventListener('mousedown', function() { isSeeking = true; });
              progressEl.addEventListener('mouseup', function() { isSeeking = false; });
              progressEl.addEventListener('touchstart', function() { isSeeking = true; });
              progressEl.addEventListener('touchend', function() { isSeeking = false; });
              progressEl.addEventListener('input', function() {
                if (playa.duration && !isNaN(playa.duration)) {
                  playa.currentTime = (progressEl.value / 100) * playa.duration;
                }
              });
              window.play = function(url) {
                var idx = tracks.indexOf(url);
                if (idx >= 0) {
                  currentIndex = idx;
                  playa.src = url;
                  playa.play();
                  updateUI();
                } else {
                  playa.src = url;
                  playa.play();
                }
              };
              updateUI();
            })();
          </script>
        `}
      </>
    </Layout2>
  )
})

app.use('/stats/*', async (c, next) => {
  if (!requireSuperAdmin(c)) return c.text('Super admin only', 403)
  await next()
})
app.route('/stats', stats)

function canManageSource(me: ResolvedUser, sourceName: string): boolean {
  return me.isSuperAdmin || me.sourceAdminSources.includes(sourceName)
}

app.get('/admin', async (c) => {
  if (!requireSourceAdminOrSuper(c)) return c.text('Access denied', 403)
  const me = c.get('me') as ResolvedUser
  const allAdmins = await sourceAdminRepo.all()
  const managedSources = me.isSuperAdmin
    ? sources.all().map((s) => s.name)
    : me.sourceAdminSources
  const visibleAdmins = me.isSuperAdmin
    ? allAdmins
    : allAdmins.filter((a) => managedSources.includes(a.source_name))
  const navMode = getNavMode(me)

  return c.html(
    <Layout2 title="Source Admins" navMode={navMode}>
      <h1>Source Admins</h1>
      <p>Add an Audius handle to grant them admin access to a source. They will see it on next login.</p>

      <form method="post" action="/admin/add" style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end' }}>
          <label>
            Audius Handle
            <input type="text" name="handle" placeholder="handle" required />
          </label>
          <label>
            Source
            <select name="sourceName" required>
              <option value="">Select source</option>
              {managedSources.map((name) => (
                <option value={name}>{name}</option>
              ))}
            </select>
          </label>
          <button type="submit" class="btn-primary">Add Admin</button>
        </div>
      </form>

      <table>
        <thead>
          <tr>
            <th>Handle</th>
            <th>Source</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visibleAdmins.map((a) => (
            <tr>
              <td>{a.handle}</td>
              <td>{a.source_name}</td>
              <td>
                {canManageSource(me, a.source_name) && (
                  <form method="post" action="/admin/remove" style={{ display: 'inline' }}>
                    <input type="hidden" name="handle" value={a.handle} />
                    <input type="hidden" name="sourceName" value={a.source_name} />
                    <button type="submit" class="btn-primary">Remove</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout2>
  )
})

app.post('/admin/add', async (c) => {
  if (!requireSourceAdminOrSuper(c)) return c.text('Access denied', 403)
  const me = c.get('me') as ResolvedUser
  const body = await c.req.parseBody()
  const handle = (body.handle as string)?.trim()
  const sourceName = body.sourceName as string
  if (!handle || !sourceName) {
    return c.redirect('/admin?error=missing')
  }
  if (!canManageSource(me, sourceName)) {
    return c.text('Cannot add admin for that source', 403)
  }
  await sourceAdminRepo.add(handle, sourceName)
  return c.redirect('/admin')
})

app.post('/admin/remove', async (c) => {
  if (!requireSourceAdminOrSuper(c)) return c.text('Access denied', 403)
  const me = c.get('me') as ResolvedUser
  const body = await c.req.parseBody()
  const handle = body.handle as string
  const sourceName = body.sourceName as string
  if (!handle || !sourceName) {
    return c.redirect('/admin?error=missing')
  }
  if (!canManageSource(me, sourceName)) {
    return c.text('Cannot remove admin for that source', 403)
  }
  await sourceAdminRepo.remove(handle, sourceName)
  return c.redirect('/admin')
})

app.get('/history/:key', async (c) => {
  const me = c.get('me') as ResolvedUser
  if (!requireSourceAdminOrSuper(c)) return c.text('Access denied', 403)
  const releaseId = c.req.param('key')
  const release = await releaseRepo.get(releaseId)
  if (!release) return c.json({ error: 'not found' }, 404)
  if (!me.isSuperAdmin && !me.sourceAdminSources.includes(release.source)) {
    return c.text('Access denied', 403)
  }
  const xmls = await xmlRepo.find(releaseId)
  const navMode = getNavMode(me)
  return c.html(
    <Layout2 title="XML History" navMode={navMode}>
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
  const me = c.get('me') as ResolvedUser
  if (!requireSourceAdminOrSuper(c)) return c.text('Access denied', 403)
  const source = c.req.param('source')
  const key = c.req.param('key')!
  const ref = c.req.param('ref')
  const size = c.req.param('size')

  if (!me.isSuperAdmin && !me.sourceAdminSources.includes(source)) {
    return c.text('Access denied', 403)
  }

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
  const me = c.get('me') as ResolvedUser
  if (!requireSourceAdminOrSuper(c)) return c.text('Access denied', 403)
  const xmlUrl = c.req.param('xmlUrl')
  const row = await xmlRepo.get(xmlUrl)
  if (!row) return c.json({ error: 'not found' }, 404)

  if (!me.isSuperAdmin && !me.sourceAdminSources.includes(row.source)) {
    return c.text('Access denied', 403)
  }

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
  if (!requireSourceAdminOrSuper(c)) return c.text('Access denied', 403)
  const row = await releaseRepo.get(c.req.param('key'))
  if (!row) return c.json({ error: 'not found' }, 404)
  const me = c.get('me') as ResolvedUser
  if (!me.isSuperAdmin && !me.sourceAdminSources.includes(row.source)) {
    return c.text('Access denied', 403)
  }
  return c.json(row)
})

app.get('/releases/:key/error', async (c) => {
  if (!requireSourceAdminOrSuper(c)) return c.text('Access denied', 403)
  const row = await releaseRepo.get(c.req.param('key'))
  if (!row) return c.json({ error: 'not found' }, 404)
  const me = c.get('me') as ResolvedUser
  if (!me.isSuperAdmin && !me.sourceAdminSources.includes(row.source)) {
    return c.text('Access denied', 403)
  }
  return c.text(row.lastPublishError)
})

app.get('/users', async (c) => {
  const me = c.get('me') as ResolvedUser
  if (!requireSourceAdminOrSuper(c)) {
    return c.text('Access denied', 403)
  }
  const users = me.isSuperAdmin
    ? await userRepo.all()
    : await userRepo.byApiKeys(
        me.sourceAdminSources
          .map((name) => sources.findByName(name)?.ddexKey)
          .filter((k): k is string => Boolean(k))
      )
  const navMode = getNavMode(me)
  const maskPassword = (pwd: string) =>
    pwd.length > 5 ? '•'.repeat(pwd.length - 5) + pwd.slice(-5) : '•••'

  const passwordCellCss = `
    .password-cell { display: flex; align-items: center; gap: 0.5rem; min-width: 220px; }
    .password-cell .password-display {
      font-family: var(--pico-font-family-mono, monospace);
      min-width: 3ch;
    }
    .password-cell .icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; padding: 0; border: none;
      background: transparent; color: var(--n-fg-muted); cursor: pointer;
      border-radius: 6px; transition: color 0.15s, background 0.15s;
    }
    .password-cell .icon-btn:hover { color: var(--n-primary); background: var(--n-primary-muted); }
    .password-cell .icon-btn svg { width: 16px; height: 16px; }
    #password-toast {
      position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
      padding: 0.5rem 1rem; background: var(--n-success); color: white;
      border-radius: 8px; font-weight: 500; z-index: 1000;
      opacity: 0; visibility: hidden; transition: opacity 0.2s, visibility 0.2s;
    }
    #password-toast.show { opacity: 1; visibility: visible; }
  `
  const passwordCellScript = `
document.querySelectorAll('.password-cell').forEach(function(cell) {
  var pwd = cell.getAttribute('data-password');
  var display = cell.querySelector('.password-display');
  var copyBtn = cell.querySelector('.copy-password');
  var toggleBtn = cell.querySelector('.toggle-password');
  var eyeIcon = cell.querySelector('.icon-eye');
  var eyeSlashIcon = cell.querySelector('.icon-eye-slash');

  copyBtn.addEventListener('click', function() {
    if (pwd && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(pwd).then(function() {
        var toast = document.getElementById('password-toast');
        toast.classList.add('show');
        setTimeout(function() { toast.classList.remove('show'); }, 2000);
      });
    }
  });

  toggleBtn.addEventListener('click', function() {
    var masked = display.hasAttribute('data-masked');
    if (masked) {
      display.textContent = pwd;
      display.removeAttribute('data-masked');
      eyeIcon.style.display = 'none';
      eyeSlashIcon.style.display = 'block';
      toggleBtn.setAttribute('title', 'Hide password');
      toggleBtn.setAttribute('aria-label', 'Hide password');
    } else {
      display.textContent = pwd.length > 5 ? '•'.repeat(pwd.length - 5) + pwd.slice(-5) : '•••';
      display.setAttribute('data-masked', '');
      eyeIcon.style.display = 'block';
      eyeSlashIcon.style.display = 'none';
      toggleBtn.setAttribute('title', 'Reveal password');
      toggleBtn.setAttribute('aria-label', 'Reveal password');
    }
  });
});
`
  return c.html(
    <Layout2 title="users" navMode={navMode}>
      <h1>Users</h1>

      <style dangerouslySetInnerHTML={{ __html: passwordCellCss }} />

      <div id="password-toast" role="status" aria-live="polite">Copied!</div>

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
                <b title={user.apiKey}>
                  {sources.findByApiKey(user.apiKey)?.name}
                </b>
              </td>
              <td>
                {user.password ? (
                  <div class="password-cell" data-password={user.password}>
                    <span class="password-display" data-masked>
                      {maskPassword(user.password)}
                    </span>
                    <button type="button" class="icon-btn copy-password" title="Copy password" aria-label="Copy password">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                      </svg>
                    </button>
                    <button type="button" class="icon-btn toggle-password" title="Reveal password" aria-label="Reveal password">
                      <svg class="icon-eye" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                      </svg>
                      <svg class="icon-eye-slash" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="display:none">
                        <path d="M10.585 10.587a2 2 0 0 0 2.829 2.828" />
                        <path d="M16.681 16.673a8.717 8.717 0 0 1-4.681 1.327c-3.6 0-6.6-2-9-6c1.272-2.12 2.712-3.678 4.32-4.674m2.86-1.146a9.055 9.055 0 0 1 1.82-.18c3.6 0 6.6 2 9 6c-.666 1.11-1.379 2.067-2.138 2.87" />
                        <path d="M3 3l18 18" />
                      </svg>
                    </button>
                  </div>
                ) : (
                  <span class="text-muted">—</span>
                )}
              </td>
              <td>
                {user.createdAt
                  ? formatDateToYYYYMMDD(new Date(user.createdAt))
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <script dangerouslySetInnerHTML={{ __html: passwordCellScript }} />
    </Layout2>
  )
})

app.post('/publish/:releaseId', async (c) => {
  const me = c.get('me') as ResolvedUser
  if (!requireSourceAdminOrSuper(c)) return c.text('Access denied', 403)
  const releaseId = c.req.param('releaseId')
  const releaseRow = await releaseRepo.get(releaseId)
  const release = releaseRow
  const source = sources.findByName(releaseRow?.source || '')
  if (!releaseRow || !source || !release || !me) {
    return c.text('not found', 404)
  }
  if (!me.isSuperAdmin && !me.sourceAdminSources.includes(releaseRow.source)) {
    return c.text('Access denied', 403)
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
  const me = c.get('me') as ResolvedUser
  if (!requireSourceAdminOrSuper(c)) return c.text('Access denied', 403)
  const release = await releaseRepo.get(c.req.param('releaseId'))
  if (!release) {
    return c.text('not found', 404)
  }
  if (!me.isSuperAdmin && !me.sourceAdminSources.includes(release.source)) {
    return c.text('Access denied', 403)
  }
  const logs = await publogRepo.forRelease(c.req.param('releaseId'))
  if (parseBool(c.req.query('json'))) {
    return c.json(logs)
  }
  const navMode = getNavMode(me)
  return c.html(
    <Layout2 title="publog" navMode={navMode}>
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

      <div style="display: flex; gap: 0.5rem;">
        <a class="btn-link" href={`/releases/${release.key}`}>
          Back to Release
        </a>
        <a class="btn-link" href="?json=1">
          View as JSON
        </a>
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
  if (!requireSuperAdmin(c)) return c.text('Super admin only', 403)
  const me = c.get('me') as ResolvedUser
  const [start, end] = getPriorMonth()
  const navMode = getNavMode(me)
  return c.html(
    <Layout2 title="Sales Report" navMode={navMode}>
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
        <button type="submit" class="btn-primary">
          Generate
        </button>
      </form>
    </Layout2>
  )
})

app.post('/report', async (c) => {
  if (!requireSuperAdmin(c)) return c.text('Super admin only', 403)
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
}

export type ResolvedUser = JwtUser & {
  isSuperAdmin: boolean
  sourceAdminSources: string[]
  hasAnyAccess: boolean
}

async function getAudiusUser(c: Context): Promise<ResolvedUser | undefined> {
  const j = await getSignedCookie(c, COOKIE_SECRET!, COOKIE_NAME)
  if (!j) return
  const me = JSON.parse(j) as JwtUser
  const handleLower = me.handle?.toLowerCase() ?? ''
  const isSuperAdmin = ADMIN_HANDLES.includes(handleLower)
  const sourceAdminSources = await sourceAdminRepo.listSourcesForHandle(
    handleLower
  )
  return {
    ...me,
    isSuperAdmin,
    sourceAdminSources,
    hasAnyAccess: isSuperAdmin || sourceAdminSources.length > 0,
  }
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
      class="btn-link"
      href="/xmls/${encodeURIComponent(xmlUrl)}"
      target="_blank"
      >xml</a
    >
    <a
      class="btn-link"
      href="/xmls/${encodeURIComponent(xmlUrl)}?parse=true"
      target="_blank"
    >
      parsed
    </a>
    <a class="btn-link" href="/xmls/${encodeURIComponent(xmlUrl)}?parse=sdk"
      >sdk</a
    >
    ${releaseId &&
    html`
      <a class="btn-link" href="/history/${releaseId}">history</a>
      <a class="btn-link" href="/releases/${releaseId}/publog">publog</a>
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

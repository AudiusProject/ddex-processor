#!/usr/bin/env npx tsx
/**
 * List likely duplicate tracks for a user, and optionally delete explicit ids.
 *
 * Dry-run listing:
 *   HANDLE=<handle> npx tsx scripts/cleanupDuplicateTracks.ts
 *   USER_ID=<encoded-user-id> npx tsx scripts/cleanupDuplicateTracks.ts
 *
 * Explicit deletion:
 *   USER_ID=<encoded-user-id> DELETE_TRACK_IDS=id1,id2 CONFIRM_DELETE=1 \
 *     PRIVATE_KEY=<hex> API_KEY=<api-key> npx tsx scripts/cleanupDuplicateTracks.ts
 *
 * The script never deletes inferred duplicates. It only deletes the track ids
 * passed through DELETE_TRACK_IDS after confirming each track belongs to the
 * selected user.
 */

import { sdk } from '@audius/sdk'
import 'dotenv/config'

const API_HOST = process.env.API_HOST || 'https://api.audius.co'
const APP_NAME = process.env.APP_NAME || 'ddex-duplicate-cleanup'

type ApiTrack = {
  id?: string
  title?: string
  isrc?: string
  iswc?: string
  user_id?: string
  userId?: string
  user?: {
    id?: string
    user_id?: string
  }
  isDelete?: boolean
  is_delete?: boolean
  createdAt?: string
  created_at?: string
  updatedAt?: string
  updated_at?: string
  permalink?: string
  playlistsContainingTrack?: unknown[]
  playlists_containing_track?: unknown[]
  albumBacklink?: unknown
  album_backlink?: unknown
  ddexReleaseIds?: Record<string, unknown>
  ddex_release_ids?: Record<string, unknown>
}

async function main() {
  const userId = await resolveUserId()
  const tracks = await fetchUserTracks(userId)
  const duplicateGroups = findDuplicateGroups(tracks)

  console.log(`Fetched ${tracks.length} tracks for user ${userId}`)
  if (!duplicateGroups.length) {
    console.log('No likely duplicate groups found.')
  } else {
    console.log(`Found ${duplicateGroups.length} likely duplicate group(s):`)
    for (const group of duplicateGroups) {
      printGroup(group)
    }
  }

  const deleteTrackIds = parseList(process.env.DELETE_TRACK_IDS)
  if (!deleteTrackIds.length) return

  if (process.env.CONFIRM_DELETE !== '1') {
    throw new Error('Set CONFIRM_DELETE=1 to delete explicit track ids')
  }

  const privateKey = requireEnv('PRIVATE_KEY')
  const apiKey = await resolveApiKey()
  const audiusSdk = sdk({
    apiKey,
    apiSecret: normalizePrivateKey(privateKey),
    appName: APP_NAME,
    environment: 'production',
  })

  for (const trackId of deleteTrackIds) {
    const track = await fetchTrack(trackId)
    const trackUserId = trackOwnerId(track)
    if (trackUserId !== userId) {
      throw new Error(
        `Refusing to delete ${trackId}: owner ${trackUserId || 'unknown'} does not match ${userId}`
      )
    }

    console.log(`Deleting ${trackId}: ${track.title || '(untitled)'}`)
    const result = await audiusSdk.tracks.deleteTrack({ trackId, userId })
    console.log('Deleted:', result)
  }
}

async function resolveUserId() {
  if (process.env.USER_ID) return process.env.USER_ID

  const handle = process.env.HANDLE
  if (!handle) {
    throw new Error('Set HANDLE or USER_ID')
  }

  const payload = await fetchJson(
    `${API_HOST}/v1/users/handle/${encodeURIComponent(handle)}?app_name=${APP_NAME}`
  )
  const user = Array.isArray(payload.data) ? payload.data[0] : payload.data
  const userId = user?.id || user?.user_id || user?.userId
  if (!userId) {
    throw new Error(`Could not resolve handle: ${handle}`)
  }
  return String(userId)
}

async function fetchUserTracks(userId: string) {
  const limit = 100
  const tracks: ApiTrack[] = []

  for (let offset = 0; ; offset += limit) {
    const payload = await fetchJson(
      `${API_HOST}/v1/full/users/${encodeURIComponent(
        userId
      )}/tracks?app_name=${APP_NAME}&limit=${limit}&offset=${offset}`
    )
    const page = Array.isArray(payload.data) ? payload.data : []
    tracks.push(...page)
    if (page.length < limit) return tracks
  }
}

async function fetchTrack(trackId: string) {
  const payload = await fetchJson(
    `${API_HOST}/v1/tracks/${encodeURIComponent(trackId)}?app_name=${APP_NAME}`
  )
  const track = Array.isArray(payload.data) ? payload.data[0] : payload.data
  if (!track) {
    throw new Error(`Track not found: ${trackId}`)
  }
  return track as ApiTrack
}

async function fetchJson(url: string) {
  const resp = await fetch(url, { headers: { accept: 'application/json' } })
  if (!resp.ok) {
    throw new Error(`Request failed ${resp.status}: ${await resp.text()}`)
  }
  return resp.json()
}

function findDuplicateGroups(tracks: ApiTrack[]) {
  const groups = new Map<string, ApiTrack[]>()

  for (const track of tracks) {
    if (track.isDelete || track.is_delete || !track.id) continue
    const key = duplicateKey(track)
    const group = groups.get(key) || []
    group.push(track)
    groups.set(key, group)
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) =>
      group.sort((a, b) =>
        String(a.createdAt || a.created_at).localeCompare(
          String(b.createdAt || b.created_at)
        )
      )
    )
}

function duplicateKey(track: ApiTrack) {
  return [
    normalizeText(track.title),
    normalizeText(track.isrc),
    normalizeText(track.iswc),
    normalizeDdexIds(track),
  ].join('|')
}

function normalizeText(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function normalizeDdexIds(track: ApiTrack) {
  const ids = track.ddexReleaseIds || track.ddex_release_ids || {}
  return Object.keys(ids)
    .sort()
    .map((key) => `${key}:${String(ids[key])}`)
    .join('|')
}

function printGroup(group: ApiTrack[]) {
  const title = group[0]?.title || '(untitled)'
  console.log(`\n${title}`)
  for (const track of group) {
    const locations = [
      hasAlbumBacklink(track) ? 'album' : 'standalone',
      hasPlaylistContainingTrack(track) ? 'playlist-ref' : '',
    ].filter(Boolean)

    console.log(
      [
        `  ${track.id}`,
        track.createdAt || track.created_at || 'unknown-created-at',
        locations.join(',') || 'no-collection-ref',
        track.permalink || '',
      ]
        .filter(Boolean)
        .join(' | ')
    )
  }
}

function hasAlbumBacklink(track: ApiTrack) {
  return Boolean(track.albumBacklink || track.album_backlink)
}

function hasPlaylistContainingTrack(track: ApiTrack) {
  const playlists =
    track.playlistsContainingTrack || track.playlists_containing_track
  return Array.isArray(playlists) && playlists.length > 0
}

function trackOwnerId(track: ApiTrack) {
  return String(
    track.user_id || track.userId || track.user?.id || track.user?.user_id || ''
  )
}

async function resolveApiKey() {
  if (process.env.API_KEY) return process.env.API_KEY

  const sourceName = process.env.SOURCE_NAME
  if (sourceName) {
    const { sources } = await import('../src/sources')
    sources.load()
    const source = sources.findByName(sourceName)
    if (source?.ddexKey) return source.ddexKey
  }

  throw new Error('Set API_KEY or SOURCE_NAME')
}

function parseList(value: string | undefined) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizePrivateKey(privateKey: string) {
  return privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

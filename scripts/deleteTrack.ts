#!/usr/bin/env npx tsx
/**
 * Delete an Audius track by ID.
 *
 * Usage:
 *   PRIVATE_KEY=<hex> TRACK_ID=QR17xNw npx tsx scripts/deleteTrack.ts
 *
 */

import { sdk } from '@audius/sdk'
import 'dotenv/config'

const API_HOST = 'https://api.audius.co'

async function main() {
  const trackId = process.env.TRACK_ID || 'QR17xNw'
  let privateKey = process.env.PRIVATE_KEY
  let apiKey = process.env.API_KEY

  if (!privateKey) {
    console.error('PRIVATE_KEY is required (or USE_DDEX_APP=1)')
    process.exit(1)
  }

  if (!apiKey) {
    try {
      const { sources } = await import('../src/sources')
      sources.load()
      const src = sources.findByName('onchainmusic')
      if (src) {
        apiKey = src.ddexKey
        console.log('Using API_KEY from onchainmusic source')
      }
    } catch {
      // ignore
    }
    if (!apiKey) {
      console.error(
        'API_KEY is required. Set it or ensure data/sources.json has onchainmusic.'
      )
      process.exit(1)
    }
  }

  if (!privateKey.startsWith('0x')) {
    privateKey = '0x' + privateKey
  }

  const resp = await fetch(`${API_HOST}/v1/tracks/${trackId}`)
  if (!resp.ok) {
    console.error(`Track not found: ${trackId}`, await resp.text())
    process.exit(1)
  }
  const json = await resp.json()
  const track = json.data
  const userId = track.user_id || track.user?.id
  if (!userId) {
    console.error('Could not determine track owner')
    process.exit(1)
  }

  console.log(`Deleting track "${track.title}" (${trackId}) by user ${userId}`)

  const audiusSdk = sdk({
    apiKey,
    apiSecret: privateKey,
    appName: 'ddex-delete-script',
    environment: 'production',
  })

  const result = await audiusSdk.tracks.deleteTrack({ trackId, userId })
  console.log('Deleted:', result)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

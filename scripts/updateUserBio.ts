#!/usr/bin/env npx tsx
/**
 * Update an Audius user's bio.
 *
 * Usage:
 *   PRIVATE_KEY=<hex> USER_ID=eAZl3 BIO="My new bio text" npx tsx scripts/updateUserBio.ts
 *   PRIVATE_KEY=<hex> API_KEY=<app> npx tsx scripts/updateUserBio.ts eAZl3 "My new bio"
 *
 * The PRIVATE_KEY must be the user's wallet private key (the one whose bio you're updating).
 * BIO is limited to 256 characters.
 */

import { sdk } from '@audius/sdk'
import 'dotenv/config'

const API_HOST = 'https://api.audius.co'

async function validateUserExists(userId: string): Promise<string> {
  const resp = await fetch(`${API_HOST}/v1/users/${userId}`)
  if (!resp.ok) {
    throw new Error(`User not found: ${userId}`)
  }
  const json = await resp.json()
  return (json.data?.id ?? userId).toString()
}

async function main() {
  const userId = process.env.USER_ID || process.argv[2]
  const bio =
    process.env.BIO ||
    (process.env.USER_ID ? process.argv.slice(2) : process.argv.slice(3)).join(
      ' '
    )
  let privateKey = process.env.PRIVATE_KEY
  let apiKey = process.env.API_KEY

  if (!userId) {
    console.error('USER_ID required. Use env var or first argument.')
    console.error(
      '  Example: USER_ID=eAZl3 BIO="New bio" PRIVATE_KEY=0x... npx tsx scripts/updateUserBio.ts'
    )
    process.exit(1)
  }

  if (!bio) {
    console.error('BIO required. Use env var or remaining arguments.')
    console.error('  Example: BIO="My new biography text"')
    process.exit(1)
  }

  if (bio.length > 256) {
    console.error(`BIO must be 256 characters or fewer (got ${bio.length})`)
    process.exit(1)
  }

  if (!privateKey) {
    console.error("PRIVATE_KEY is required (user's wallet private key)")
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

  const resolvedUserId = await validateUserExists(userId)
  console.log(`Updating bio for user ${resolvedUserId}`)
  console.log(`New bio: "${bio}"`)

  const audiusSdk = sdk({
    apiKey,
    apiSecret: privateKey,
    appName: 'ddex-update-bio-script',
    environment: 'production',
  })

  const result = await audiusSdk.users.updateProfile({
    userId: resolvedUserId,
    metadata: { bio },
  })
  console.log('Updated:', result)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

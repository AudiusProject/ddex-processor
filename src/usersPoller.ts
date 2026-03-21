import { userRepo } from './db'
import { getSdk } from './sdk'
import { sources, SourceConfig } from './sources'
import { encodeId } from './util'

function apiHostForSource(source: SourceConfig) {
  return source.env === 'production'
    ? 'https://api.audius.co'
    : 'https://api.staging.audius.co'
}

// Fetch users who have granted access to this source's app address
async function pollGrantees(source: SourceConfig) {
  const address = source.ddexKey.replace(/^0x/, '')
  const apiHost = apiHostForSource(source)
  const PAGE_SIZE = 100
  let offset = 0
  let total = 0

  try {
    while (true) {
      const url = `${apiHost}/v1/grantees/${address}/users?is_revoked=false&limit=${PAGE_SIZE}&offset=${offset}`
      const resp = await fetch(url, {
        headers: { accept: 'application/json' },
      })
      if (!resp.ok) {
        console.error(
          `Failed to fetch grantees for ${source.name}: ${resp.status}`
        )
        return
      }
      const json = await resp.json()
      const granteeUsers = json.data || []

      for (const user of granteeUsers) {
        const id = user.id || encodeId(user.user_id)
        await userRepo.upsert({
          apiKey: source.ddexKey,
          id,
          handle: user.handle,
          name: user.name,
          createdAt: new Date(),
        })
      }

      total += granteeUsers.length
      if (granteeUsers.length < PAGE_SIZE) break
      offset += PAGE_SIZE
    }

    if (total) {
      console.log(
        `Synced ${total} grantee user(s) for source ${source.name}`
      )
    }
  } catch (error) {
    console.error(`Error polling grantees for ${source.name}:`, error)
  }
}

export async function startUsersPoller() {
  const source = sources.all()[0]
  const sdk = getSdk(source)

  // Periodic task to fetch user data, update names, and sync grantees
  setInterval(async () => {
    // Sync grantees for all sources
    for (const s of sources.all()) {
      await pollGrantees(s)
    }

    // Update existing user names
    try {
      const users = await userRepo.all()

      for (const user of users) {
        const { data: userResponse } = await sdk.users.getUser({ id: user.id })
        if (!userResponse) {
          throw new Error(`Error fetching user ${user.id} from sdk`)
        }
        if (userResponse.name !== user.name) {
          await userRepo.upsert({
            ...user,
            name: userResponse.name,
          })
          console.log(`Updated user ${user.id}'s name`)
        }
      }
    } catch (error) {
      console.error('Failed to update user names:', error)
    }
  }, 300000) // Runs every 5 min
}

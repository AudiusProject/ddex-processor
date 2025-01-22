import { createHedgehogWalletClient, sdk } from '@audius/sdk'
import { getHedgehog, localStorage } from './hedgehog'

async function main() {
  const artistName = `Snow Dayz`

  // use attempt to handle situations where email / handle is taken.
  for (let attempt = 1; attempt < 10; attempt++) {
    const rand = `claimable_${attempt}`
    const email = `steve+${rand}@audius.co`
    const password = 'password123'
    const handle = `artist_${rand}`

    try {
      const hedgehog = getHedgehog()
      const identityResult = await hedgehog.signUp({
        username: email,
        password,
      })
      console.log('identityResult', identityResult)

      const audiusWalletClient = createHedgehogWalletClient(getHedgehog())
      const userSdk = sdk({
        appName: 'ddex',
        environment: 'staging',
        services: {
          audiusWalletClient,
        },
      })

      const metadata = {
        handle: handle,
        name: artistName,
        wallet: identityResult.getAddressString(),
      }

      const discoveryResult = await userSdk.users.createUser({ metadata })

      const entropy = localStorage.getItem('hedgehog-entropy-key')

      console.log(metadata, discoveryResult, entropy)
      // TODO: save user details to db

      break
    } catch (e) {
      console.log('attempt', attempt, e)
    }
  }

  process.exit(0)
}

main()

import 'dotenv/config'

import {
  Hedgehog,
  WalletManager,
  type GetFn,
  type SetAuthFn,
  type SetUserFn,
} from '@audius/hedgehog'

import { LocalStorage } from 'node-localstorage'
export const localStorage = new LocalStorage('./local-storage')

const IS_PROD = process.env.NODE_ENV == 'production'
const loginHost = IS_PROD
  ? 'https://audius.co'
  : 'https://staging.audius.co'
const identityHost = IS_PROD
  ? 'https://identityservice.audius.co'
  : 'https://identityservice.staging.audius.co'

export let hedgehog: Hedgehog | undefined
export const getHedgehog = () => {
  const getFn: GetFn = async (args) => {
    const res = await fetch(
      `${identityHost}/authentication?lookupKey=${args.lookupKey}`,
      {
        method: 'GET',
      }
    )
    if (!res.ok) {
      throw new Error(`get auth failed ${await res.text()}`)
    }
    return (await res.json()) as { iv: string; cipherText: string }
  }

  const setAuthFn: SetAuthFn = async (args) => {
    args.email = args.username
    const res = await fetch(`${identityHost}/authentication`, {
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify(args),
    })
    if (!res.ok) {
      throw new Error(`set auth failed ${await res.text()}`)
    }
  }

  const setUserFn: SetUserFn = async (args) => {
    args.email = args.username
    const res = await fetch(`${identityHost}/user`, {
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify(args),
    })
    if (!res.ok) {
      throw new Error(`set user failed ${await res.text()}`)
    }
  }

  if (!hedgehog) {
    hedgehog = new Hedgehog(
      getFn,
      setAuthFn,
      setUserFn,
      /* useLocalStorage */ true,
      localStorage
    )
  }
  return hedgehog
}

/** Generate recovery info (login token + host) from stored entropy. Call after signUp. */
export async function generateRecoveryInfo(): Promise<{
  login: string
  host: string
  loginUrl: string
}> {
  const entropy = await WalletManager.getEntropyFromLocalStorage(localStorage)
  if (entropy === null) {
    throw new Error('generateRecoveryInfo - missing entropy')
  }
  const btoa = (str: string) => Buffer.from(str, 'utf8').toString('base64')
  const login = btoa(entropy)
  return {
    login,
    host: loginHost,
    loginUrl: `${loginHost}/recover?login=${encodeURIComponent(login)}`,
  }
}

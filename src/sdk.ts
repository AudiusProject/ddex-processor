import type { AudiusSdk as AudiusSdkType } from '@audius/sdk'
// import { sdk } from '@audius/sdk'
import { SourceConfig } from './sources'

const sdkCache: Record<string, AudiusSdkType> = {}

export function getSdk(sourceConfig: SourceConfig) {
  let { ddexKey, ddexSecret, name, env } = sourceConfig
  // if (!sdkCache[ddexKey]) {
  //   // viem expects hex values to start with 0x
  //   if (!ddexSecret.startsWith('0x')) {
  //     ddexSecret = '0x' + ddexSecret
  //   }
  //   try {
  //     sdkCache[ddexKey] = sdk({
  //       apiKey: ddexKey,
  //       apiSecret: ddexSecret,
  //       appName: name,
  //       environment: env || 'staging',
  //     })
  //   } catch (e) {
  //     console.log('sdk dial error', e)
  //   }
  // }

  return sdkCache[ddexKey]
}

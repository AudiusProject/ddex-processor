import type { AudiusSdkWithServices } from '@audius/sdk'
import { createSdkWithServices } from '@audius/sdk'
import type { SourceConfig } from './sources'

const sdkCache: Record<string, AudiusSdkWithServices> = {}
const PINNED_STORAGE_NODE = 'https://creatornode.audius.co'

const pinnedStorageNodeSelector = {
  async getSelectedNode() {
    return PINNED_STORAGE_NODE
  },
  getNodes() {
    return [PINNED_STORAGE_NODE]
  },
  triedSelectingAllNodes() {
    return false
  },
}

export function getSdkNetworkConfig(env: SourceConfig['env']) {
  if (!env) {
    throw new Error(
      'source env is required for DDEX publishing with @audius/sdk v15'
    )
  }
  if (env === 'development') {
    return { environment: 'development' as const }
  }
  if (env === 'staging') {
    throw new Error(
      'staging DDEX publishing is not supported by @audius/sdk v15'
    )
  }

  return { environment: 'production' as const }
}

export function getSdk(sourceConfig: SourceConfig) {
  let { ddexKey, ddexSecret, name, env } = sourceConfig
  if (!sdkCache[ddexKey]) {
    // viem expects hex values to start with 0x
    if (!ddexSecret.startsWith('0x')) {
      ddexSecret = '0x' + ddexSecret
    }
    try {
      sdkCache[ddexKey] = createSdkWithServices({
        apiKey: ddexKey,
        apiSecret: ddexSecret,
        appName: name,
        ...getSdkNetworkConfig(env),
        services: {
          storageNodeSelector: pinnedStorageNodeSelector,
        },
      })
    } catch (e) {
      console.log('sdk dial error', e)
      throw e
    }
  }

  return sdkCache[ddexKey]
}

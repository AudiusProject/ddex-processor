import { mkdirSync, readFileSync } from 'fs'
import { decodeId } from './util'

export const dataDir = process.env.DATA_DIR || 'data'
mkdirSync(dataDir, { recursive: true })
console.log({ dataDir })
const sourcesLocation =
  process.env.SOURCES_LOCATION || `${dataDir}/sources.json`

type SourcesFile = {
  sources: SourceConfig[]
  reporting: {
    mri: BucketConfig
  }
}

export type BucketConfig = {
  awsKey: string
  awsSecret: string
  awsRegion: string
  awsBucket: string
}

export type SourceConfig = BucketConfig & {
  env?: 'production' | 'staging' | 'development'
  name: string
  ddexKey: string
  ddexSecret: string
  placementHosts?: string
  payoutUserId?: string
}

let sourcesFile: SourcesFile

export const sources = {
  load(configPath?: string) {
    try {
      const j = readFileSync(configPath || sourcesLocation, 'utf8')
      sourcesFile = JSON.parse(j) as SourcesFile
    } catch (e) {
      console.log('failed to load sources', e)
    }

    // validate
    for (const source of sourcesFile.sources) {
      if (source.payoutUserId && !decodeId(source.payoutUserId)) {
        throw new Error(
          `Invalid payoutUserId for ${source.name}.  Must be encoded int id.`
        )
      }
    }
  },

  all() {
    return sourcesFile.sources
  },

  findByName(name: string) {
    const found = sourcesFile.sources.find((s) => s.name == name)
    return found
  },

  findByXmlUrl(xmlUrl: string) {
    const u = new URL(xmlUrl)
    const found = sourcesFile.sources.find((s) => s.awsBucket == u.host)
    if (!found) throw new Error(`unable to find source for xmlUrl: ${xmlUrl}`)
    return found
  },

  findByApiKey(apiKey: string) {
    const found = sourcesFile.sources.find((s) => s.ddexKey == apiKey)
    return found
  },

  reporting() {
    return sourcesFile.reporting
  },
}

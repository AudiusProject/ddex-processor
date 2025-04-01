import { Client } from '@opensearch-project/opensearch'
import 'dotenv/config'

import { XMLParser } from 'fast-xml-parser'
import { xmlRepo } from './src/db'

const node = process.env.OPENSEARCH_URL || 'http://localhost:9200'
export const client = new Client({ node })

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (tagName) =>
    ['SoundRecording', 'Image', 'Release'].includes(tagName),
  ignoreDeclaration: true,
  removeNSPrefix: true,
  parseTagValue: false,
})

async function main() {
  await client.indices.delete({ index: 'ddex' }, { ignore: [404] })

  const rows = xmlRepo.all('')
  for (const row of rows) {
    if (row.xmlUrl.includes('Batch')) continue
    console.log(row.xmlUrl)
    const json = parser.parse(row.xmlText)
    console.log(json)

    client.index({
      index: 'ddex',
      body: json,
    })
  }
}

main()

import postgres from 'postgres'
import { scanS3 } from './src/s3poller'
import { sources } from './src/sources'

import { XMLParser } from 'fast-xml-parser'

sources.load()

/*
FullName

select xpath('//FullName/text()', xmltext::xml) from release_xml limit 200;

select
  xmlurl,
  (xpath('//ISRC/text()', sr))[1] as isrc,
  (xpath('//GenreText/text()', sr))[1] as genre,
  (xpath('//SubGenre/text()', sr))[1] as subgenre,
  (xpath('//FullName/text()', sr)) as fullname
from release_xml,
unnest(xpath('//SoundRecording', xmltext)) as sr
;
*/

const sql = postgres({
  port: 40111,
  user: 'postgres',
  pass: 'example',
})

async function main() {
  await sql`drop table if exists release_xml;`

  await sql`
  create table if not exists release_xml (
    source text not null,
    xmlUrl text not null,
    xmlText xml not null,
    xmlData jsonb not null,
    primary key (source, xmlUrl)
  );
 `

  for await (const xmlPair of scanS3(true)) {
    const { sourceName, xml, xmlUrl } = xmlPair
    if (xmlUrl.includes('Batch')) continue
    console.log('OK', xmlPair.sourceName, xmlPair.xmlUrl)

    const parser = new XMLParser({
      ignoreAttributes: true,
      isArray: (tagName) => ['SoundRecording', 'Image'].includes(tagName),
    })
    const json = parser.parse(xml)

    await sql`
    insert into release_xml values (${sourceName}, ${xmlUrl}, ${xml}, ${json})
    on conflict do nothing
    `
  }
}

process.on('SIGINT', function () {
  console.log('\nBYE')
  process.exit(0)
})

main()

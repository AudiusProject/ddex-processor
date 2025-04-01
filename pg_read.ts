import postgres from 'postgres'

import util from 'util'
util.inspect.defaultOptions.depth = 10

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
  const rows = await sql`select * from release_xml limit 100;`

  for (const row of rows) {
    console.log(row.xmldata['ern:NewReleaseMessage'])
  }
}

process.on('SIGINT', function () {
  console.log('\nBYE')
  process.exit(0)
})

main()

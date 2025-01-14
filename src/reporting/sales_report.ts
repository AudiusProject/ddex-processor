import 'dotenv/config'

import { stringify } from 'csv-stringify/sync'
import postgres from 'postgres'
import { sources } from '../sources'

const sql = postgres(process.env.DISCOVERY_DB || '')

export async function generateSalesReport(
  sourceName: string,
  start: string,
  end: string
) {
  const source = sources.findByName(sourceName)
  if (!source) {
    throw new Error(`unknown source: ${sourceName}`)
  }
  let ddexApp = source.ddexKey.toLowerCase()
  if (!ddexApp.startsWith('0x')) {
    ddexApp = `0x` + ddexApp
  }

  const rows = await sql`

with
ddex_sales as (
  select
    a.copyright_line->>'text' as "Label",
    a.playlist_name as "Album title",
    u.name as "Artist",
    a.playlist_name as "Track title", -- for album purchase, use album title for track title?
    a.ddex_release_ids->>'icpn' as "UPC",
    a.ddex_release_ids->>'isrc' as "ISRC",
    'album:' || a.playlist_id as "DSP ID",
    country_to_iso_alpha2(coalesce("country", '')) as "Country of sale",
    (
        SELECT (split->>'amount')::NUMERIC
        FROM jsonb_array_elements(splits) AS split
        WHERE split->>'user_id' is not null
    ) as split_amount,
    s.amount,
    s.extra_amount,
    s.created_at
  from usdc_purchases s
  join playlists a on s.content_type = 'album' and a.playlist_id = s.content_id and lower(a.ddex_app) = ${ddexApp}
  join users u on a.playlist_owner_id = u.user_id
  WHERE s.created_at >= ${start}
    AND s.created_at < ${end}

  UNION ALL

  select
    t.copyright_line->>'text' as "Label",
    a.playlist_name as "Album title",
    u.name as "Artist",
    t.title as "Track title", -- for album purchase, use album title for track title?
    t.ddex_release_ids->>'icpn' as "UPC",
    t.isrc as "ISRC",
    'track:' || t.track_id as "DSP ID",
    country_to_iso_alpha2(coalesce("country", '')) as "Country of sale",
    (
        SELECT (split->>'amount')::NUMERIC
        FROM jsonb_array_elements(splits) AS split
        WHERE split->>'user_id' is not null
    ) as split_amount,
    s.amount,
    s.extra_amount,
    s.created_at
  from usdc_purchases s
  join tracks t on s.content_type = 'track' and t.track_id = s.content_id and lower(t.ddex_app) = ${ddexApp}
  join playlist_tracks pt using (track_id)
  join playlists a on pt.playlist_id = a.playlist_id AND a.is_album = TRUE
  join users u on t.owner_id = u.user_id
  WHERE s.created_at >= ${start}
    AND s.created_at < ${end}
)
select
  'Audius' as "Service",
  ${start} as "Start_Date",
  ${end} as "End_Date",
  created_at as "Sale_Date",
  "Label",
  "Album title",
  "Artist",
  "Track title",
  "UPC",
  "ISRC",
  "DSP ID",
  "Country of sale",
  'Download' as "Sales type",
  'Other' as "User type",
  '1' as "Quantity",
  'USD' as "Currency",
  trunc(("split_amount") / 1000000, 2) as "Royalty per item",
  trunc(("split_amount") / 1000000, 2)  as "Total royalty"
from ddex_sales
order by created_at
;

  `.values()

  // prepend header row
  const cols = rows.columns.map((c) => c.name)
  rows.unshift(cols)

  const result = stringify(rows)
  const fileName = `Audius_${sourceName}_${start}_${end}.csv`
  return [fileName, result]
}

async function main() {
  sources.load()
  const start = '2025-12-01'
  const end = '2025-01-01'
  const [fileName, result] = await generateSalesReport('fuga', start, end)
  console.log(fileName, result)
  await sql.end()
}

// main()

import 'dotenv/config'

import { stringify } from 'csv-stringify/sync'
import fs from 'fs'
import path from 'path'
import postgres from 'postgres'

const sql = postgres(process.env.DISCOVERY_DB || '')

export async function generateSalesReport(
  start: string,
  end: string
) {
  const rows = await sql`

  with
  ddex_sales as (
    select
      t.copyright_line->>'text' as "Label",
      a.playlist_name as "Album Title",
      u.name as "Artist",
      t.title as "Track Title",
      t.duration as "Track Length",
      t.track_id as "Track ID",
      t.ddex_release_ids->>'icpn' as "UPC",
      t.isrc as "ISRC",
      country_to_iso_alpha2(coalesce(s.country, 'United States')) as "Country of sale",
      (
          SELECT (split->>'amount')::NUMERIC
          FROM jsonb_array_elements(splits) AS split
          WHERE split->>'user_id' is not null
      ) as split_amount,
      s.amount,
      s.extra_amount,
      s.created_at
    from usdc_purchases s
    join tracks t on s.content_type = 'track' and t.track_id = s.content_id
    join playlist_tracks pt using (track_id)
    join playlists a on pt.playlist_id = a.playlist_id AND a.is_album = TRUE
    join users u on t.owner_id = u.user_id
    WHERE s.created_at >= ${start}
      AND s.created_at < ${end}
  )

  select
    'N' as "Record Type",
    'QJ76' as "Provider Key",
    '2222' as "Client Key",
    ${start.replace(/-/g, '')} as "Report Start Date",
    ${end.replace(/-/g, '')} as "Report End Date",
    'Audius - DTO Products Service' as "Vendor Key Name",
    'P0A1' as "Vendor Key",
    "Country of sale" as "Country Key",
    'SA' as "Sales Type Key",
    "Track ID" as "External Id",
    "UPC" as "UPC (Physical Album Product)",
    '' as "Official SME Product #",
    "ISRC" as "ISRC/Official Track #",
    '' as "GRID/Official Digital ID (Album Level)",
    '' as "GRID/Official Digital ID (Track Level)",
    11 as "Product Type Key",
    COUNT(*) as "Gross Units",
    0 as "Returned Units",
    COUNT(*) * 0.90 as "Invoice Value",
    'USD' as "Invoice Value Currency",
    '0.90' as "Wholesale Price per Unit (WPU)",
    '1.00' as "Retail Price per Unit (RPU)",
    'USD' as "Retail Price per Unit (RPU) Currency",
    0 as "VAT/TAX",
    'USD' as "VAT/TAX Currency",
    'Front' as "Pricing Tier",
    20 as "Distribution Type Key",
    20 as "Transaction Type Key",
    10 as "Service Type Key",
    'MP3' as "Media Key",
    'Y' as "Copyright Indicator",
    "Label" as "Label Name",
    "Artist" as "Participant Full Name (Main artist for the album)",
    "Album Title" as "Product Title",
    "Track Title" as "Track Title",
    1 as "Track Count",
    "Track Length" as "Track Length",
    "Track Length" as "Total Stream Duration",
    'A001' as "Campaign ID",
    '3rd Party Provider' as "Misc."
  from ddex_sales
  group by "Track ID", "UPC", "ISRC", "Label", "Artist", "Album Title", "Track Title", "Track Length", "Country of sale"
;

  `.values()

  // prepend header row
  const rowsWithHeader = [...rows]
  const cols = rows.columns.map((c) => c.name)
  rowsWithHeader.unshift(cols)

  const resultCsv = stringify(rowsWithHeader)
  const fileNameCsv = `P0A1_M_${start.replace(/-/g, '')}_${end.replace(/-/g, '')}.csv`
  
  fs.writeFileSync(path.join(__dirname, fileNameCsv), resultCsv)

  const resultTxt = stringify(rows, { delimiter: '#*#'})
  const fileNameTxt = `P0A1_M_${start.replace(/-/g, '')}_${end.replace(/-/g, '')}.txt`
  fs.writeFileSync(path.join(__dirname, fileNameTxt), resultTxt)

  return [fileNameCsv, resultCsv]
}

async function main() {
  const start = '2025-01-01'
  const end = '2025-01-31'
  const [fileName, ] = await generateSalesReport(start, end)
  console.log(`Report written to ${fileName}`)
  await sql.end()
}

main()

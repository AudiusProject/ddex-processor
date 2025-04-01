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
  const startFormatted = start.replace(/-/g, '')
  const endFormatted = end.replace(/-/g, '')

  const standardReportRows = await sql`
  with
  sales as (
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
          select (split->>'amount')::NUMERIC
          from jsonb_array_elements(splits) AS split
          where split->>'user_id' is not null
      ) as split_amount,
      s.amount,
      s.extra_amount,
      s.created_at
    from usdc_purchases s
    join tracks t on s.content_type = 'track' and t.track_id = s.content_id
    join playlist_tracks pt using (track_id)
    join playlists a on pt.playlist_id = a.playlist_id AND a.is_album = TRUE
    join users u on t.owner_id = u.user_id
    where s.created_at >= ${start}
      and s.created_at < ${end}
  )

  select
    'N' as "Record Type",
    'QJ76' as "Provider Key",
    '2222' as "Client Key",
    ${startFormatted} as "Report Start Date",
    ${endFormatted} as "Report End Date",
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
    '' as "Track Count",
    TO_CHAR(("Track Length" || ' seconds')::interval, 'HH24:MI:SS') as "Track Length",
    TO_CHAR(("Track Length" || ' seconds')::interval, 'HH24:MI:SS') as "Total Stream Duration",
    '' as "Campaign ID",
    '' as "Misc."
  from sales
  group by "Track ID", "UPC", "ISRC", "Label", "Artist", "Album Title", "Track Title", "Track Length", "Country of sale"
;

  `.values()

  const marketShareReportRows = await sql`
  with
  sales as (
    select
      country_to_iso_alpha2(coalesce(s.country, 'United States')) as country_of_sale,
      count(*) as total_sales
    from usdc_purchases s
    join tracks t on s.content_type = 'track' and t.track_id = s.content_id
    where s.created_at >= ${start}
      and s.created_at < ${end}
    group by country_of_sale
  ),
  sme_sales as (
    select
      country_to_iso_alpha2(coalesce(s.country, 'United States')) as country_of_sale,
      count(*) as app_sales
    from usdc_purchases s
    join tracks t on s.content_type = 'track' and t.track_id = s.content_id
    where s.created_at >= ${start}
      and s.created_at < ${end}
      and t.ddex_app = '0x1bA4906aea0D0f5571bdD6E4985c59Ad97ab51B2'
    group by country_of_sale
  )

  select
    'M' as "Record Type",
    'QJ76' as "Provider Key",
    '2222' as "Client Key",
    ${startFormatted} as "Report Start Date",
    ${endFormatted} as "Report End Date",
    'Audius - DTO Products Service' as "Vendor Key Name",
    'P0A1' as "Vendor Key",
    a.country_of_sale as "Country Key",
    10 as "Product Type Key",
    round(coalesce((s.app_sales::numeric / a.total_sales::numeric) * 100, 0), 2) as "Market Share"
  from sales a
  left join sme_sales s on a.country_of_sale = s.country_of_sale
  `.values()

  const outdir = path.join(__dirname, 'data')

  // prepend header row
  // GOTCHA - the 'Market Share' column is not included in the header row.
  // SME's requirement here is weird. It asks for this to be included with the row
  // and is disambiguated by the 'Record Type' column.
  const rowsWithHeader = [...standardReportRows, ...marketShareReportRows]
  const cols = standardReportRows.columns.map((c) => c.name)
  rowsWithHeader.unshift(cols)

  const resultCsv = stringify(rowsWithHeader)
  const fileNameCsv = `P0A1_M_${startFormatted}_${endFormatted}.csv`
  
  fs.writeFileSync(path.join(outdir, fileNameCsv), resultCsv)

  const resultTxt = stringify(rowsWithHeader, { delimiter: '#*#'})
  const fileNameTxt = `P0A1_M_${startFormatted}_${endFormatted}.txt`
  fs.writeFileSync(path.join(outdir, fileNameTxt), resultTxt)

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

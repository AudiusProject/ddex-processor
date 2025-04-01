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

  const rows = await sql`
  with
  ddex_sales as (
    select
      COALESCE(s.country, 'United States') as "Country",
      country_to_iso_alpha2(COALESCE(s.country, 'United States')) as "Country of sale",
      sum(
          (SELECT (split->>'amount')::NUMERIC
          FROM jsonb_array_elements(splits) AS split
          WHERE split->>'user_id' is not null)
      ) as split_amount,
      count(distinct u.user_id) as "User Count",
      count(*) as "Total Sales",
      COALESCE(sum(ap.count), 0) as "Total Plays",
      count(td.track_id) as "Total Downloads",
      COALESCE(sum(ap.count * t.duration), 0) as "Total Minutes Streamed"
    from usdc_purchases s
    join tracks t on s.content_type = 'track' and t.track_id = s.content_id
    join playlist_tracks pt using (track_id)
    join playlists a on pt.playlist_id = a.playlist_id AND a.is_album = TRUE
    join users u on s.buyer_user_id = u.user_id
    left join track_downloads td on t.track_id = td.track_id
    left join aggregate_plays ap on t.track_id = ap.play_item_id
    WHERE s.created_at >= ${start}
      AND s.created_at < ${end}
      AND s.country is not null
    group by s.country
  )

  select
    'D' as "Record Type",
    'QJ76' as "Provider Key",
    ${startFormatted} as "Report Start Date",
    ${endFormatted} as "Report End Date",
    'Audius - DTO Products Service' as "Vendor Key Name",
    'P0A1' as "Vendor Key",
    "Country of sale" as "Country Key",
    "Country" as "Country",
    11 as "Product Type Key",
    "User Count" as "Total Users",
    "User Count" as "Active Users",
    "User Count" as "Total Accounts",
    "User Count" as "New Accounts",
    "User Count" as "Active Accounts",
    0 as "Inactive Accounts",
    100 as "Active Accounts % of Total Accounts",
    0 as "Account Churn",
    1.00000 as "Customer Retail Price",
    'USD' as "Currency for Customer Retail Price",
    0.90000 as "Per Download Rate",
    'USD' as "Currency for Per Download Rate",
    0 as "Download Rate Tier Code",
    "Total Sales" * 1.00000 as "Gross Revenue Across All Content Providers in Local Currency",
    "Total Sales" * 1.00000 as "Gross Revenue Across All Content Providers in Payment Currency",
    0 as "VAT Deductions from Gross Revenue",
    0 as "VAT/TAX",
    0 as "App Store Deductions",
    0 as "App Store Total Cost to Provider",
    "Total Sales" * 1.00000 as "Net Revenue Across All Content Providers in Local Currency",
    "Total Sales" * 1.00000 as "Net Revenue Across All Content Providers in Payment Currency",
    "Total Sales" * 0.900000 as "Payment Owed to SME in Local Currency",
    'USD' as "Local Currency for Payment Owed to SME",
    1.00 as "Exchange Rate",
    ${endFormatted} as "Exchange Rate Date",
    "Total Sales" * 0.900000 as "Payment Owed to SME in Payment Currency",
    'USD' as "Payment Currency for Payment Owed to SME",
    "Total Plays" + "Total Downloads" as "Total Plays (or Downloads) Across All Content Providers",
    "Total Plays" + "Total Downloads" as "Total Plays (or Downloads) for SME Content",
    "Total Plays" + "Total Downloads" as "Total Royalty Bearing Plays (or Downloads) Across All",
    "Total Plays" + "Total Downloads" as "Total Royalty Bearing Plays (or Downloads) for SME",
    CASE WHEN "Country of sale" = 'US' THEN 70 ELSE 62 END as "Revenue Share %",
    100 as "SME Market Share by Usage (Plays or Downloads only)",
    "Total Minutes Streamed" as "Minutes of Audio Delivered",
    '' as "Greater of Calculation: Condition 1",
    '' as "Greater of Calculation: Condition 2"
  from ddex_sales
  group by "Country of sale", "Country", "Total Downloads", "Total Sales", "Total Minutes Streamed", "User Count", "Total Plays"
;

  `.values()

  // prepend header row
  const rowsWithHeader = [...rows]
  const cols = rows.columns.map((c) => c.name)
  rowsWithHeader.unshift(cols)

  const resultCsv = stringify(rowsWithHeader)
  const fileNameCsv = `P0A1_F_${startFormatted}_${endFormatted}_DS.csv`

  fs.writeFileSync(path.join(__dirname, fileNameCsv), resultCsv)

  const resultTxt = stringify(rows, { delimiter: '#*#' })
  const fileNameTxt = `P0A1_F_${startFormatted}_${endFormatted}_DS.txt`

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

import 'dotenv/config'

import { stringify } from 'csv-stringify/sync'
import fs from 'fs'
import path from 'path'
import postgres from 'postgres'

const sql = postgres(process.env.DISCOVERY_DB || '')

const smeDdexApp = '0x123'
const wholesaleRate = 0.9
const smeRetailPrice = 1.00

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
      count(CASE WHEN t.ddex_app = ${smeDdexApp} THEN 1 ELSE 0 END) as "SME Total Sales",
      COALESCE(sum(ap.count), 0) as "Total Plays",
      count(td.track_id) as "Total Downloads",
      COALESCE(sum(CASE WHEN t.ddex_app = ${smeDdexApp} THEN ap.count ELSE 0 END), 0) as "SME Total Plays",
      count(CASE WHEN t.ddex_app = ${smeDdexApp} THEN td.track_id ELSE NULL END) as "SME Total Downloads",
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
  ),
  total_accounts as (
    select count(*) from users
  ),
  new_accounts as (
    select count(*) from users where created_at >= ${start} and created_at < ${end}
  ),
  prior_month_total_accounts as (
    select count(*) from users where created_at < ${start}
  ),
  active_accounts as (
    select count(distinct user_id) from (
      select user_id from plays where created_at >= ${start} and created_at < ${end}
      UNION
      select user_id from track_downloads where created_at >= ${start} and created_at < ${end}
    ) as active_users
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
    MAX(total_accounts.count) as "Total Accounts",
    MAX(new_accounts.count) as "New Accounts",
    MAX(active_accounts.count) as "Active Accounts",
    CAST(
      (MAX(total_accounts.count) - MAX(new_accounts.count) - MAX(prior_month_total_accounts.count)) / 
      MAX(prior_month_total_accounts.count) 
      AS DECIMAL(10,2)
    ) as "Account Churn",
    CAST(${smeRetailPrice.toFixed(6)}::numeric AS DECIMAL(10,6)) as "Customer Retail Price",
    'USD' as "Currency for Customer Retail Price",
    CAST(${wholesaleRate.toFixed(6)}::numeric AS DECIMAL(10,6)) as "Per Download Rate",
    'USD' as "Currency for Per Download Rate",
    0 as "Download Rate Tier Code",
    CAST(
      "Total Sales" * ${smeRetailPrice}::numeric 
      AS DECIMAL(10,6)
    ) as "Gross Revenue Across All Content Providers in Local Currency",
    CAST(
      "Total Sales" * ${smeRetailPrice}::numeric 
      AS DECIMAL(10,6)
    ) as "Gross Revenue Across All Content Providers in Payment Currency",
    0 as "VAT Deductions from Gross Revenue",
    0 as "VAT/TAX",
    CAST(${smeRetailPrice.toFixed(6)}::numeric AS DECIMAL(10,6)) as "Net Retail Price",
    CAST(
      "Total Sales" * ${smeRetailPrice}::numeric 
      AS DECIMAL(10,6)
    ) as "Net Revenue Across All Content Providers in Local Currency",
    CAST(
      "Total Sales" * ${smeRetailPrice}::numeric 
      AS DECIMAL(10,6)
    ) as "Net Revenue Across All Content Providers in Payment Currency",
    CAST(
      GREATEST(
        CASE 
          WHEN "Country of sale" = 'US' THEN 0.70 * "SME Total Sales" 
          ELSE 0.62 * "SME Total Sales" 
        END,
        "SME Total Sales" * ${wholesaleRate}::numeric
      ) 
      AS DECIMAL(10,6)
    ) as "Payment Owed to SME in Local Currency",
    'USD' as "Local Currency for Payment Owed to SME",
    CAST(1.00::numeric AS DECIMAL(10,6)) as "Exchange Rate",
    ${endFormatted} as "Exchange Rate Date",
    CAST(
      GREATEST(
        CASE 
          WHEN "Country of sale" = 'US' THEN 0.70 * "SME Total Sales" 
          ELSE 0.62 * "SME Total Sales" 
        END,
        "SME Total Sales" * ${wholesaleRate}::numeric
      ) 
      AS DECIMAL(10,6)
    ) as "Payment Owed to SME in Payment Currency",
    'USD' as "Payment Currency for Payment Owed to SME",
    "Total Plays" + "Total Downloads" as "Total Plays (or Downloads) Across All Content Providers",
    "SME Total Plays" + "SME Total Downloads" as "Total Plays (or Downloads) for SME Content",
    CASE 
      WHEN "Country of sale" = 'US' THEN 0.70 
      ELSE 0.62 
    END as "Revenue Share %",
    CAST(
      COALESCE(
        ROUND(
          100 * ("SME Total Plays" + "SME Total Downloads") / 
          NULLIF("Total Plays" + "Total Downloads", 0), 
          2
        ), 
        0
      ) 
      AS DECIMAL(10,6)
    ) as "SME Market Share by Usage (Plays or Downloads only)",
    "Total Minutes Streamed" as "Minutes of Audio Delivered",
    CAST(
      CASE 
        WHEN "Country of sale" = 'US' THEN 70 * "SME Total Sales" 
        ELSE 62 * "SME Total Sales" 
      END 
      AS DECIMAL(10,6)
    ) as "Greater of Calculation: Condition 1",
    CAST(
      "SME Total Sales" * ${wholesaleRate}::numeric 
      AS DECIMAL(10,6)
    ) as "Greater of Calculation: Condition 2"
  from ddex_sales, total_accounts, new_accounts, prior_month_total_accounts, active_accounts
  group by "Country of sale", "Country", "Total Sales", "SME Total Sales", "Total Minutes Streamed", "User Count", "Total Plays", "Total Downloads", "SME Total Plays", "SME Total Downloads"
;

  `.values()

  const outdir = path.join(__dirname, 'data')

  // prepend header row
  const rowsWithHeader = [...rows]
  const cols = rows.columns.map((c) => c.name)
  rowsWithHeader.unshift(cols)

  const resultCsv = stringify(rowsWithHeader)
  const fileNameCsv = `P0A1_F_${startFormatted}_${endFormatted}_DS.csv`

  fs.writeFileSync(path.join(outdir, fileNameCsv), resultCsv)

  const resultTxt = stringify(rows, { delimiter: '#*#' })
  const fileNameTxt = `P0A1_F_${startFormatted}_${endFormatted}_DS.txt`

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

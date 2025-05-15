import { html } from 'hono/html'
import { PropsWithChildren } from 'hono/jsx'

export function Layout2({
  title,
  children,
}: PropsWithChildren<{ title: string }>) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title ? title : 'ddex'}</title>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css"
        />
        <style>
          :root {
            --pico-font-size: 16px;
            --pico-line-height: 1.3;
            // --pico-border-radius: 1rem;
            // --pico-spacing: 0.5rem;
            // --pico-form-element-spacing-vertical: 0.5rem;
          }
          h1 {
            --pico-typography-spacing-vertical: 0.5rem;
          }
          button {
            --pico-font-weight: 700;
          }
          mark {
            margin-right: 3px;
          }
          .bold {
            font-weight: bold;
          }
          .topbar {
            display: flex; gap: 10px; padding: 10px;
          }
          .topbar a {
            text-decoration: none;
          }
          .truncate {
            max-width: 300px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .hidden {
            display: none;
          }
          a.plain {
            text-decoration: none;
          }

          table.compact td {
            padding: 8px;
            font-size: 95%;
          }
          table.compact td.key {
            text-transform: uppercase;
            font-size: 80%;
          }
        </style>
      </head>
      <body>
        <div class="topbar">
          <a href="/"><b>ddex</b></a>
          <a href="/releases">releases</a>
          <a href="/users">users</a>
          <a href="/stats">stats</a>
          <a href="/report">report</a>
        </div>
        <div style="padding: 20px 40px;">${children}</div>
      </body>
    </html>`
}

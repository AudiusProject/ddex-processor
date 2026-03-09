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
        <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
        <title>${title ? title : 'ddex'}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap"
          rel="stylesheet"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css"
        />
        <style>
          /* ========== Design tokens (Neue) ========== */
          :root {
            /* Default [Neue] - Light */
            --n-bg: #f6f5f7;
            --n-bg-elevated: #ffffff;
            --n-fg: #0c0f14;
            --n-fg-muted: #4a5263;
            --n-fg-subtle: #7f8798;
            --n-border: #d8dbe2;
            --n-primary: #7f6ad6;
            --n-primary-hover: #5b44b8;
            --n-primary-muted: #e9e3ff;
            --n-accent: #a74cff;
            --n-success: #0f9e48;
            --n-error: #f94d62;
            --n-warning: #ff9400;
          }

          [data-theme='dark'] {
            --n-bg: #000000;
            --n-bg-elevated: #141414;
            --n-fg: #ededed;
            --n-fg-muted: #9e9e9e;
            --n-fg-subtle: #757575;
            --n-border: #333333;
            --n-primary: #806ad8;
            --n-primary-hover: #9e8ee8;
            --n-primary-muted: #261f40;
            --n-accent: #c67cff;
            --n-success: #84df64;
            --n-error: #f94d62;
            --n-warning: #efb360;
          }

          /* Pico overrides with tokens */
          :root {
            --pico-font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
            --pico-font-size: 15px;
            --pico-line-height: 1.5;
            --pico-border-radius: 10px;
            --pico-spacing: 1rem;
            --pico-form-element-spacing-vertical: 0.75rem;
            --pico-form-element-spacing-horizontal: 1rem;
            --pico-primary: var(--n-primary);
            --pico-primary-hover: var(--n-primary-hover);
            --pico-primary-focus: var(--n-primary);
            --pico-background-color: var(--n-bg);
            --pico-color: var(--n-fg);
            --pico-muted-color: var(--n-fg-muted);
            --pico-border-color: var(--n-border);
          }

          [data-theme='dark'] {
            --pico-primary: var(--n-primary);
            --pico-primary-hover: var(--n-primary-hover);
            --pico-background-color: var(--n-bg);
            --pico-color: var(--n-fg);
            --pico-muted-color: var(--n-fg-muted);
            --pico-border-color: var(--n-border);
          }

          body {
            background: var(--n-bg);
            color: var(--n-fg);
            min-height: 100vh;
          }

          /* ========== Navigation ========== */
          .nav-wrapper {
            background: var(--n-bg-elevated);
            border-bottom: 1px solid var(--n-border);
            padding: 0;
            position: sticky;
            top: 0;
            z-index: 100;
            backdrop-filter: blur(8px);
          }

          .nav-inner {
            max-width: 1400px;
            margin: 0 auto;
            padding: 0 1.5rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 56px;
            gap: 1.5rem;
          }

          .nav-brand {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-weight: 700;
            font-size: 1.1rem;
            color: var(--n-fg);
            text-decoration: none;
            letter-spacing: -0.02em;
          }
          .nav-brand:hover {
            color: var(--n-primary);
          }

          .nav-links {
            display: flex;
            align-items: center;
            gap: 0.25rem;
          }

          .nav-links a {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem 0.875rem;
            font-size: 0.9rem;
            font-weight: 500;
            color: var(--n-fg-muted);
            text-decoration: none;
            border-radius: 8px;
            transition:
              color 0.15s,
              background 0.15s;
          }

          .nav-links a:hover {
            color: var(--n-fg);
            background: var(--n-primary-muted);
          }

          .nav-links a[data-active] {
            color: var(--n-primary);
            background: var(--n-primary-muted);
          }

          .nav-icon {
            width: 18px;
            height: 18px;
            flex-shrink: 0;
          }

          .nav-actions {
            display: flex;
            align-items: center;
            gap: 0.5rem;
          }

          .theme-toggle {
            position: absolute;
            top: 50%;
            right: 1rem;
            transform: translateY(-50%);
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            padding: 0;
            border: none;
            background: transparent;
            color: var(--n-fg-muted);
            cursor: pointer;
            transition:
              color 0.15s,
              background 0.15s;
          }
          .theme-toggle:hover {
            color: var(--n-fg);
          }
          .theme-toggle svg {
            width: 18px;
            height: 18px;
          }

          /* Main content */
          .main-content {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem 1.5rem 3rem;
          }

          .main-content > h1:first-child {
            margin-top: 0;
          }
          h1 {
            --pico-typography-spacing-vertical: 0.5rem;
            font-weight: 600;
            letter-spacing: -0.02em;
            margin-bottom: 1.5rem;
          }

          /* Articles / Cards */
          article,
          .pico article {
            background: var(--n-bg-elevated);
            border: 1px solid var(--n-border);
            border-radius: 12px;
            padding: 1.25rem;
          }

          /* Tables */
          table {
            background: var(--n-bg-elevated);
            border-radius: 10px;
            overflow: hidden;
            border: 1px solid var(--n-border);
          }
          table thead th {
            background: var(--n-primary-muted);
            color: var(--n-fg);
            font-weight: 600;
            font-size: 0.8rem;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            padding: 0.875rem 1rem;
          }
          table tbody td {
            padding: 0.875rem 1rem;
            border-color: var(--n-border);
          }
          table tbody tr:hover td {
            background: var(--n-primary-muted);
          }

          table.compact td {
            padding: 0.5rem 0.75rem;
            font-size: 0.9rem;
          }
          table.compact td.key {
            text-transform: uppercase;
            font-size: 0.75rem;
            color: var(--n-fg-muted);
          }

          /* Releases filter bar - bottom-aligned header row */
          .releases-filter-bar {
            display: flex;
            flex-wrap: nowrap;
            align-items: flex-end;
            gap: 0.75rem;
            margin-bottom: 1.5rem;
          }
          .releases-filters-form {
            display: flex;
            flex-wrap: nowrap;
            flex-grow: 1;
            align-items: flex-end;
            gap: 0.75rem;
          }
          .releases-filters-form input,
          .releases-filters-form select,
          .releases-filters-form label {
            margin-bottom: 0 !important;
          }
          .releases-filter-bar-pagination {
            display: flex;
            align-items: flex-end;
            gap: 0.5rem;
          }
          .releases-filter-bar-export {
            display: flex;
            align-items: flex-end;
          }

          /* Filter checkbox - button-style box (matches .btn-export size) */
          .filter-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            padding: 0.5rem 1rem;
            min-width: 9.5rem;
            min-height: 2.5rem;
            font-size: 0.9rem;
            font-weight: 500;
            color: var(--n-fg);
            cursor: pointer;
            user-select: none;
            margin-bottom: 0;
            background: transparent;
            border: 1px solid var(--n-primary);
            border-radius: 8px;
          }
          .filter-toggle:hover {
            background: var(--n-primary-muted);
          }
          .filter-toggle input[type='checkbox'] {
            appearance: none;
            -webkit-appearance: none;
            width: 1rem;
            height: 1rem;
            margin: 0;
            padding: 0;
            border: 2px solid var(--n-primary);
            border-radius: 4px;
            background: transparent;
            cursor: pointer;
            position: relative;
            flex-shrink: 0;
          }
          .filter-toggle input[type='checkbox']:checked {
            background: var(--n-primary-muted);
          }
          .filter-toggle input[type='checkbox']:checked::after {
            content: '';
            position: absolute;
            left: 0.25rem;
            top: 0.05rem;
            width: 0.3rem;
            height: 0.5rem;
            border: solid var(--n-primary);
            border-width: 0 2px 2px 0;
            transform: rotate(45deg);
          }

          /* Buttons */
          button,
          [role='button'],
          .pico button {
            font-weight: 600;
          }
          .btn-primary {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 0.5rem 1rem;
            font-size: 0.9rem;
            font-weight: 600;
            color: white;
            background: var(--n-primary);
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.15s;
          }
          .btn-primary:hover:not(:disabled) {
            background: var(--n-primary-hover);
          }
          .btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .btn-export {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            padding: 0.5rem 1rem;
            min-width: 9.5rem;
            min-height: 2.5rem;
            font-size: 0.9rem;
            font-weight: 500;
            color: var(--n-primary);
            background: var(--n-primary-muted);
            border: none;
            border-radius: 8px;
            text-decoration: none;
            transition:
              background 0.15s,
              color 0.15s;
          }
          .btn-export:hover {
            background: var(--n-primary);
            color: white;
          }
          .btn-export svg {
            width: 18px;
            height: 18px;
            flex-shrink: 0;
          }
          .btn-secondary {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            padding: 0.5rem 1rem;
            font-size: 0.9rem;
            font-weight: 500;
            color: var(--n-fg);
            background: transparent;
            border: 1px solid var(--n-border);
            border-radius: 8px;
            text-decoration: none;
            cursor: pointer;
            transition:
              background 0.15s,
              border-color 0.15s,
              color 0.15s;
          }
          .btn-secondary:hover {
            background: var(--n-primary-muted);
            border-color: var(--n-primary-muted);
            color: var(--n-primary);
          }
          .btn-secondary:disabled,
          .btn-secondary[aria-disabled='true'],
          a.btn-secondary[disabled] {
            opacity: 0.5;
            cursor: not-allowed;
            pointer-events: none;
          }
          .btn-link {
            display: inline-flex;
            align-items: center;
            font-size: 0.85rem;
            font-weight: 500;
            color: var(--n-fg-muted);
            text-decoration: none;
            padding: 0.25rem 0.5rem;
            border-radius: 6px;
            transition:
              color 0.15s,
              background 0.15s;
          }
          .btn-link:hover {
            color: var(--n-primary);
            background: var(--n-primary-muted);
          }

          /* Mark / Badges */
          mark {
            margin-right: 3px;
            padding: 0.2em 0.5em;
            border-radius: 6px;
            font-weight: 500;
          }
          .cleared {
            background: rgba(15, 158, 72, 0.2);
            color: var(--n-success);
          }
          .not-cleared {
            background: rgba(249, 77, 98, 0.2);
            color: var(--n-error);
          }

          .bold {
            font-weight: 600;
          }
          .text-muted {
            color: var(--n-fg-muted);
            font-size: 0.9em;
          }
          .tag,
          .chip {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            font-size: 0.8rem;
            font-weight: 500;
            border-radius: 6px;
            background: var(--n-primary-muted);
            color: var(--n-primary);
            text-decoration: none;
            margin: 2px;
            transition: background 0.15s;
          }
          .tag:hover,
          .chip:hover {
            background: var(--n-primary);
            color: white;
          }

          /* Custom audio player (fixed at bottom) */
          .playa-wrap {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 1rem 1.5rem;
            background: var(--n-bg-elevated);
            border-top: 1px solid var(--n-border);
            box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.08);
            z-index: 50;
            display: flex;
            justify-content: center;
            align-items: center;
          }
          [data-theme='dark'] .playa-wrap {
            box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.3);
          }
          .playa-player {
            display: flex;
            align-items: center;
            gap: 1rem;
            width: 100%;
            max-width: 720px;
          }
          .playa-controls {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            flex-shrink: 0;
          }
          .playa-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            padding: 0;
            border: none;
            border-radius: 50%;
            background: var(--n-primary-muted);
            color: var(--n-primary);
            cursor: pointer;
            transition:
              background 0.15s,
              color 0.15s;
          }
          .playa-btn:hover {
            background: var(--n-primary);
            color: white;
          }
          .playa-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .playa-btn svg {
            width: 18px;
            height: 18px;
          }
          .playa-btn-play svg {
            width: 20px;
            height: 20px;
          }
          .playa-track-info {
            display: flex;
            flex-direction: column;
            gap: 0.125rem;
            min-width: 0;
            flex: 1;
            max-width: 200px;
          }
          .playa-track-title {
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--n-fg);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .playa-track-artist {
            font-size: 0.8rem;
            color: var(--n-fg-muted);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .playa-progress-wrap {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 0.75rem;
            min-width: 0;
          }
          .playa-time {
            font-size: 0.8rem;
            font-weight: 500;
            color: var(--n-fg-muted);
            flex-shrink: 0;
            width: 2.5rem;
          }
          .playa-time-current {
            text-align: right;
          }
          .playa-time-duration {
            text-align: left;
          }
          .playa-progress-track {
            flex: 1;
            display: flex;
            align-items: center;
            min-height: 20px;
            min-width: 0;
          }
          .playa-progress {
            flex: 1;
            width: 100%;
            -webkit-appearance: none;
            appearance: none;
            margin: 0;
            padding: 0;
            background: transparent;
          }
          .playa-progress::-webkit-slider-runnable-track {
            height: 20px;
            background: linear-gradient(var(--n-border) 0 0) 50% / 100% 6px no-repeat;
            cursor: pointer;
          }
          .playa-progress::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 14px;
            height: 14px;
            margin-top: 3px;
            border-radius: 50%;
            background: var(--n-primary);
            cursor: pointer;
            transition: transform 0.15s;
          }
          .playa-progress::-webkit-slider-thumb:hover {
            transform: scale(1.1);
          }
          .playa-progress::-moz-range-track {
            height: 6px;
            background: var(--n-border);
            border-radius: 3px;
          }
          .playa-progress::-moz-range-thumb {
            width: 14px;
            height: 14px;
            border-radius: 50%;
            border: none;
            background: var(--n-primary);
            cursor: pointer;
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
        </style>
      </head>
      <body>
        <nav class="nav-wrapper">
          <div class="nav-inner">
            <a href="/" class="nav-brand">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="22"
                height="22"
                viewBox="0 0 32 32"
              >
                <circle cx="16" cy="16" r="14" fill="var(--n-primary)" />
                <circle cx="16" cy="16" r="5" fill="white" />
              </svg>
              ddex
            </a>
            <div class="nav-links">
              <a href="/" data-nav="/">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="nav-icon"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"
                  />
                </svg>
                Home
              </a>
              <a href="/releases" data-nav="/releases">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="nav-icon"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"
                  />
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                  />
                </svg>
                Releases
              </a>
              <a href="/users" data-nav="/users">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="nav-icon"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7Z"
                  />
                </svg>
                Users
              </a>
              <a href="/stats" data-nav="/stats">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="nav-icon"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75Z"
                  />
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625Z"
                  />
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
                  />
                </svg>
                Stats
              </a>
              <a href="/report" data-nav="/report">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="nav-icon"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                  />
                </svg>
                Sales Report
              </a>
            </div>
            <div class="nav-actions">
              <button
                type="button"
                class="theme-toggle"
                id="theme-toggle"
                aria-label="Toggle theme"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="2"
                  stroke="currentColor"
                  id="theme-icon-sun"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
                  />
                </svg>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="2"
                  stroke="currentColor"
                  id="theme-icon-moon"
                  style="display:none"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
                  />
                </svg>
              </button>
            </div>
          </div>
        </nav>
        <main class="main-content">${children}</main>

        <script>
          ;(function () {
            var html = document.documentElement
            var stored = localStorage.getItem('theme')
            var prefersDark = window.matchMedia(
              '(prefers-color-scheme: dark)'
            ).matches
            var theme = stored || (prefersDark ? 'dark' : 'light')
            if (theme === 'dark') {
              html.setAttribute('data-theme', 'dark')
              document.getElementById('theme-icon-sun').style.display = 'none'
              document.getElementById('theme-icon-moon').style.display = 'block'
            } else {
              html.removeAttribute('data-theme')
              document.getElementById('theme-icon-sun').style.display = 'block'
              document.getElementById('theme-icon-moon').style.display = 'none'
            }
            document.getElementById('theme-toggle').onclick = function () {
              var isDark = html.getAttribute('data-theme') === 'dark'
              if (isDark) {
                html.removeAttribute('data-theme')
                localStorage.setItem('theme', 'light')
                document.getElementById('theme-icon-sun').style.display =
                  'block'
                document.getElementById('theme-icon-moon').style.display =
                  'none'
              } else {
                html.setAttribute('data-theme', 'dark')
                localStorage.setItem('theme', 'dark')
                document.getElementById('theme-icon-sun').style.display = 'none'
                document.getElementById('theme-icon-moon').style.display =
                  'block'
              }
            }
            var path = location.pathname
            document
              .querySelectorAll('.nav-links a[data-nav]')
              .forEach(function (a) {
                var nav = a.getAttribute('data-nav')
                if (nav === '/') {
                  if (path === '/' || path === '')
                    a.setAttribute('data-active', '')
                  else a.removeAttribute('data-active')
                } else if (path.startsWith(nav)) {
                  a.setAttribute('data-active', '')
                } else {
                  a.removeAttribute('data-active')
                }
              })
          })()
        </script>
      </body>
    </html>`
}

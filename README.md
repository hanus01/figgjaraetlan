# Fíggjarætlan

Fíggjarætlan is a Faroese personal budgeting app for iPhone and Mac. It keeps a monthly spending plan alongside the purchases, refunds, and income recorded against it. The hosted version can be installed from Safari and syncs between devices.

![The transaction form and category filter with sample purchases and refunds](tests/evidence/category-check.png)

## Try the demo

Download or clone this repository and open `index.html` in your browser. The demo starts with sample records and saves changes in that browser. It runs without an account or server.

## What it does

- Build monthly budgets for expected income, fixed costs, and variable expenses. Copy a previous month's plan without copying its transactions.
- Record expenses, refunds, and income. Search across months by description, date range, category, or transaction type. The fixed-cost tab fills an entry from a monthly budget line for you to review and save.
- Close a month and prepare the next plan together. Rename or archive categories for future budgets while keeping historical labels. **Hagtøl** can include the current month to date, with averages and insights still based on completed months.
- Download transaction and budget CSVs or a JSON backup. Restore previews the changes and asks you to download a safety copy first. A hosted restore can change up to 5,000 records within a 2 MB request.
- Keep unfinished entry and budget drafts on the device. Add, edit, delete, or undo a transaction offline, then sync it on reconnection. If another device changed the same entry, review both versions. Budget changes and backup restore require a connection.

## How it works

The frontend uses HTML, CSS, and JavaScript. It stores amounts as integer øre. The hosted app uses a service worker to cache the app, IndexedDB for offline transactions, and a Cloudflare Worker with a D1 database. GitHub OAuth restricts the hosted ledger to one configured owner. The server rejects stale edits and identifies retried writes so the same transaction is recorded once.

## Build and test

Use Node.js 24 or newer.

```sh
npm ci
npm test
npm run test:runtime
npm run build
```

The tests cover budgeting and categories, statistics, exports and restore, sign-in, and offline sync. The runtime suite uses a temporary local D1 database. `npm run build` creates the hosted app bundle in `dist/`.

To host your own instance, copy `wrangler.example.jsonc` to `wrangler.jsonc` and fill in your Worker and D1 details. Apply the SQL migrations in `cloud/migrations/`. Register a GitHub OAuth app with a callback at `/auth/callback` on your Worker origin, and store `GITHUB_CLIENT_SECRET` as a Worker secret.

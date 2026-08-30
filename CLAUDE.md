# reforgedz-dotnet — working notes for Claude

**First run:** there is no build, lint or test suite. Read the memory `reforgedz-shop-repo`
(the file map and the two traps), then `git status` — and stop if `shop.db-wal` /
`shop.db-shm` show as modified, that is normal and must never be "cleaned up".

- Node/Express despite the name (`node server.js`, SQLite via better-sqlite3 in WAL mode).
  Needs a `.env`; never read or print it.
- **Live customers and money.** Show the owner the plan before changing checkout, PayPal,
  webhooks, roles, sync, or anything under `routes/shop.js`. Deploys are attended only
  (memory `reforgedz-eu-box-ssh-deploy`).
- ⛔ **Never `git rm --cached` or `git checkout --` the `shop.db-*` sidecars** — they are
  tracked on purpose (commit `6988f53`); removing them risks live data loss on deploy.
- `sync.js` writes to game-server volumes over SSH; treat every code path that reaches it as
  touching live servers.
- Before a push: `/ship`.

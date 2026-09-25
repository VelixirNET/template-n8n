# n8n

[![Deploy on velixir](https://velixir.net/img/deploy-on-velixir.svg)](https://velixir.net/new?template=n8n)

[n8n](https://n8n.io) is a workflow automation tool: connect APIs, schedule jobs, and build
integrations from a visual editor, on infrastructure you control.

[Deploy it on velixir](https://velixir.net/new?template=n8n).

## What this repo is

A thin wrapper, not a fork. `package.json` depends on the `n8n` npm package and the start
script runs it. Upgrading is a version bump.

```json
"scripts": { "start": "N8N_PORT=$PORT N8N_LISTEN_ADDRESS=0.0.0.0 n8n start" }
```

n8n reads `N8N_PORT`, while velixir injects `PORT`, so the start script maps one to the
other. That is the whole reason this script is not just `n8n start`.

## Setting it up on velixir

n8n defaults to a SQLite file on local disk. **A container's disk does not survive a
redeploy**, so every workflow you build would vanish on your next deploy. Point it at a
managed Postgres before you do anything else.

1. **Create a managed Postgres** and bind it to the app on the **Databases** tab.
2. **Set these on the app's Environment tab**, reading the host, port, database, user and
   password off the managed instance's connection details:

   | Variable | Value |
   | --- | --- |
   | `DB_TYPE` | `postgresdb` |
   | `DB_POSTGRESDB_HOST` | the instance host |
   | `DB_POSTGRESDB_PORT` | `5432` |
   | `DB_POSTGRESDB_DATABASE` | the database name |
   | `DB_POSTGRESDB_USER` | the username |
   | `DB_POSTGRESDB_PASSWORD` | the password |
   | `DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED` | `false` |
   | `N8N_ENCRYPTION_KEY` | a random string, kept forever |
   | `WEBHOOK_URL` | `https://your-app.velixir.run/` |
   | `N8N_HOST` | `your-app.velixir.run` |
   | `N8N_PROTOCOL` | `https` |

3. **Turn on authentication.** n8n does not require a login by default, and this will be on
   a public URL. Set `N8N_BASIC_AUTH_ACTIVE=true` with `N8N_BASIC_AUTH_USER` and
   `N8N_BASIC_AUTH_PASSWORD`, or configure user management, *before* the first deploy.

`N8N_ENCRYPTION_KEY` encrypts your stored credentials. Generate it once
(`openssl rand -hex 32`), keep it somewhere safe, and never change it: lose it and every
saved credential in every workflow becomes unreadable.

## Three things to know before you rely on this

**Do not run it on a scale-to-zero plan.** An app that sleeps when idle does not run
scheduled workflows, and cold-starting on a webhook will time out. Use a plan that stays warm.

**`WEBHOOK_URL` must match your real hostname.** n8n builds webhook URLs from it and hands
them to third parties; get it wrong and callbacks go nowhere.

**It wants memory.** n8n is heavier than it looks. Start on a plan with at least 2 GB of RAM
rather than the smallest tier.

## Running it locally

```bash
npm install
PORT=5678 npm start
```

The start script uses shell-style environment assignment, so on Windows run it under WSL or
Git Bash, or just set `N8N_PORT` yourself and call `npx n8n start`.

## Upstream

n8n is distributed under the [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)
(fair-code), not an OSI open-source licence. Self-hosting for internal use is permitted;
reselling it as a service is not. Read it before commercial use. This wrapper is MIT; the
licence that matters is upstream's.

- Docs: https://docs.n8n.io
- Source: https://github.com/n8n-io/n8n

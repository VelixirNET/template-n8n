# n8n

[![Deploy on velixir](https://velixir.net/img/deploy-on-velixir.svg)](https://velixir.net/new?template=n8n)

[n8n](https://n8n.io) is a workflow automation tool: connect APIs, schedule jobs, and build
integrations from a visual editor, on infrastructure you control.

[Deploy it on velixir](https://velixir.net/new?template=n8n).

## What you get

Deploy it from the gallery and it comes up ready to use:

- **A managed Postgres, created and connected for you.** Workflows, credentials, execution
  history and the files your workflows handle all live there, so nothing is lost on a redeploy.
- **An owner account nobody else can claim.** A fresh n8n hands the owner account to whoever
  opens it first, which on a public URL is a race. This one creates the owner on its first boot,
  before it takes any traffic, and prints the sign-in details to the deploy log.
- **An encryption key that survives.** n8n encrypts every credential you store with a key it
  normally keeps on local disk, and container disks are wiped on every redeploy. This key is
  generated once and kept in the database, so your credentials stay readable.
- **The right public URL for webhooks**, worked out from the app's address, so the webhook URLs
  n8n hands to third parties point back at it.

## Signing in

Open the app's **Logs** after the first deploy and look for the box that says
**n8n owner account created**. It has the email and password to sign in with. They are only
printed once, so change both under **Settings > Personal** once you are in.

Lost them? Set `N8N_OWNER_EMAIL` and `N8N_OWNER_PASSWORD` on the app's Environment tab and
redeploy: the owner is reset to those. While they are set, n8n manages the account from them and
will not let you change it in the UI, so remove them again once you have signed in.

## What this repo is

A thin wrapper, not a fork. `package.json` depends on the `n8n` npm package, pinned to an exact
release, and `start.js` translates what velixir provides into what n8n reads:

| velixir provides | n8n gets |
| --- | --- |
| `PORT` | `N8N_PORT`, listening on `0.0.0.0` |
| `DATABASE_URL` | `DB_TYPE=postgresdb` and the `DB_POSTGRESDB_*` settings, with TLS |
| `VELIXIR_APP_SLUG` | `WEBHOOK_URL`, `N8N_EDITOR_BASE_URL`, `N8N_HOST` (override with `PUBLIC_URL`) |
| nothing | a persistent `N8N_ENCRYPTION_KEY`, binary data in Postgres, telemetry off |

Anything you set yourself on the Environment tab wins, so every
[n8n environment variable](https://docs.n8n.io/hosting/configuration/environment-variables/)
still works as documented.

To upgrade n8n, change the version in `package.json` and deploy. Read n8n's release notes first:
major versions have breaking changes.

There is no `package-lock.json` on purpose. n8n's dependency tree has peer-dependency conflicts
that make `npm ci` reject a lockfile even when the same npm version wrote it, so the build runs
`npm install` against the exact n8n version pinned here instead. n8n pins most of its own
dependencies, so builds stay close to reproducible.

## On your own domain

Add the domain to the app, then set `PUBLIC_URL` to `https://your.domain` and redeploy, so the
webhook URLs n8n generates use it.

## Things to know before you rely on this

**It needs an always-on plan with at least 1 GB of memory.** Scheduled workflows only run while
the app is awake, and n8n is heavier than it looks. The create form will not offer smaller plans.

**No email.** Outbound SMTP is blocked on velixir, so n8n cannot send invitations or password
resets by email, and the Send Email node will not connect. Use an email API node (Resend,
Postmark, Brevo, SendGrid) in workflows instead.

**Some nodes are off by default.** n8n 2 disables the Execute Command and Local File Trigger nodes
unless you change `NODES_EXCLUDE`. The Read/Write Files from Disk node still works, but it writes
to a disk that is wiped on every redeploy, so keep files in the database or an external bucket.

**One replica.** n8n's queue mode, for running executions across several workers, needs a Valkey
and separate worker processes. This template runs n8n as a single process.

## Running it locally

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/n8n PORT=5678 npm start
```

Node 24 or newer, as n8n requires. Without `DATABASE_URL` you get the setup page rather than an
n8n that would lose everything on restart.

## Upstream

n8n is distributed under the [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)
(fair-code), not an OSI open-source licence. Running it for your own internal automation is
permitted; offering it to others as a service is not. Read it before commercial use. This wrapper
is MIT; the licence that matters is upstream's.

- Docs: https://docs.n8n.io
- Source: https://github.com/n8n-io/n8n

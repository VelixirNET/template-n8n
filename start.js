// Starts n8n the way velixir runs apps.
//
// n8n can run on velixir with no configuration at all, but only if something translates for it:
// velixir injects PORT, DATABASE_URL and VELIXIR_APP_SLUG, and n8n wants N8N_PORT, a dozen
// DB_POSTGRESDB_* variables, an encryption key that must never change, and its own public URL.
// This file is that translation, plus the three things that go wrong without it:
//
//   1. No database bound yet: n8n would quietly fall back to SQLite on the container disk, which
//      is wiped on every redeploy, taking every workflow with it. Instead we serve a setup page.
//   2. The encryption key: n8n generates one on first boot and keeps it in ~/.n8n, which is also
//      wiped on redeploy. Lose it and every stored credential becomes unreadable. We generate it
//      once and keep it in Postgres, unless you set N8N_ENCRYPTION_KEY yourself.
//   3. The owner account: on a fresh n8n, whoever opens the URL first becomes the owner. On a
//      public URL that is a race nobody should have to win. The first boot creates the owner
//      itself, with a generated password printed to the deploy log, before n8n takes any traffic.
//
// Everything n8n reads can still be set directly on the app's Environment tab; nothing here
// overrides a variable you set yourself.

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const PORT = Number(process.env.PORT || 8080);
// Private port for the one-time owner setup. Not 5679: n8n's task-runner broker listens there.
const FIRST_BOOT_PORT = PORT === 5690 ? 5691 : 5690;

const publicUrl = (process.env.PUBLIC_URL
  || (process.env.VELIXIR_APP_SLUG ? `https://${process.env.VELIXIR_APP_SLUG}.velixir.run` : `http://localhost:${PORT}`))
  .replace(/\/+$/, '');

// ─── Pages ──────────────────────────────────────────────────────────────────

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body, refreshSeconds) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#0b0b10; color:#e8e8ef;
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  .wrap { max-width:38rem; margin:0 auto; padding:3rem 1.25rem 4rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; letter-spacing:-.02em; }
  .sub { color:#7a7a8c; font-size:.8125rem; margin:0 0 2rem; }
  code { background:#16161f; border:1px solid #26263a; border-radius:5px;
         padding:.1rem .35rem; color:#c7d2fe; font-size:.8125rem; overflow-wrap:anywhere; }
  ol { padding-left:1.25rem; margin:0 0 1.5rem; }
  li { margin-bottom:.9rem; }
  .note { color:#7a7a8c; font-size:.8125rem; }
  footer { color:#4b4b5c; font-size:.75rem; margin-top:2.5rem; text-align:center; }
  footer a { color:#7a7a8c; }
</style>
<div class="wrap">
  ${body}
  <footer>n8n, running on <a href="https://velixir.net">velixir</a></footer>
</div>
</html>`;
}

const SETUP_PAGE = page('Connect a database', `
  <h1>Connect a database</h1>
  <p class="sub">n8n keeps its workflows, credentials and execution history in Postgres, and no database is bound to this app yet.</p>
  <ol>
    <li><strong>Create a managed Postgres</strong> from the Databases page, or run <code>velixir db create</code>.</li>
    <li><strong>Bind it to this app</strong> as <code>DATABASE_URL</code>: on the database's page under Bound apps,
      or <code>velixir db bind &lt;database-id&gt; --app &lt;app-id&gt;</code>.</li>
    <li><strong>Redeploy</strong> with the Redeploy button on the live release (Deploys tab).
      The owner account's password is printed in the deploy log on that first boot.</li>
  </ol>
  <p class="note">Deploying this template from the velixir gallery does all three for you.</p>`);

const startingPage = (detail) => page('Starting n8n', `
  <h1>Starting n8n</h1>
  <p class="sub">${escapeHtml(detail)} This page refreshes on its own.</p>`, 5);

// A small server for the moments n8n is not answering yet: setup mode, waiting for the
// database, and the first-boot owner setup. /healthz stays 200 so the platform does not
// restart a container that is doing exactly what it should.
function holdingServer(render) {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok (n8n not started yet)');
    }
    const { status, html } = render();
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  server.listen(PORT, '0.0.0.0');
  return server;
}

// ─── Database ───────────────────────────────────────────────────────────────

// velixir's DATABASE_URL carries sslmode=require: TLS with a certificate from the platform's own
// CA, so encrypt but do not verify against public CAs. n8n takes discrete settings, which is also
// the only way to get that behaviour out of node-postgres (the URL form treats require as
// verify-full and overrides the ssl option).
function parseDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const mode = (url.searchParams.get('sslmode') || '').toLowerCase();
  return {
    host: url.hostname,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: mode !== '' && mode !== 'disable',
    verify: mode === 'verify-ca' || mode === 'verify-full',
  };
}

async function withDatabase(db, fn) {
  const client = new Client({
    host: db.host, port: Number(db.port), database: db.database, user: db.user, password: db.password,
    ssl: db.ssl ? { rejectUnauthorized: db.verify } : false,
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => {}); }
}

// Generated once, then read back forever. ON CONFLICT DO NOTHING makes two replicas booting at
// the same moment agree on one value instead of each inventing its own.
async function persistentSecret(client, name, make) {
  await client.query(`CREATE TABLE IF NOT EXISTS velixir_template_secrets (
    name TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await client.query(
    'INSERT INTO velixir_template_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
    [name, make()]);
  const { rows } = await client.query('SELECT value FROM velixir_template_secrets WHERE name = $1', [name]);
  return rows[0].value;
}

// n8n records a finished owner setup in its own settings table. Missing table: n8n has never run.
async function ownerIsSetUp(client) {
  try {
    const { rows } = await client.query(
      "SELECT value FROM settings WHERE key = 'userManagement.isInstanceOwnerSetUp'");
    return rows.length > 0 && rows[0].value === 'true';
  } catch {
    return false;
  }
}

// ─── n8n ────────────────────────────────────────────────────────────────────

function n8nEnv(db, encryptionKey, overrides) {
  const env = { ...process.env };
  const setDefault = (key, value) => { if (env[key] === undefined || env[key] === '') env[key] = value; };

  setDefault('DB_TYPE', 'postgresdb');
  setDefault('DB_POSTGRESDB_HOST', db.host);
  setDefault('DB_POSTGRESDB_PORT', String(db.port));
  setDefault('DB_POSTGRESDB_DATABASE', db.database);
  setDefault('DB_POSTGRESDB_USER', db.user);
  setDefault('DB_POSTGRESDB_PASSWORD', db.password);
  if (db.ssl) {
    setDefault('DB_POSTGRESDB_SSL_ENABLED', 'true');
    setDefault('DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED', db.verify ? 'true' : 'false');
  }
  // Small pool: several replicas multiply it, and a managed instance has a connection cap.
  setDefault('DB_POSTGRESDB_POOL_SIZE', '4');

  env.N8N_ENCRYPTION_KEY = encryptionKey;

  const host = new URL(publicUrl).host;
  setDefault('N8N_PROTOCOL', publicUrl.startsWith('https:') ? 'https' : 'http');
  setDefault('N8N_HOST', host);
  setDefault('WEBHOOK_URL', `${publicUrl}/`);
  setDefault('N8N_EDITOR_BASE_URL', publicUrl);
  setDefault('N8N_PROXY_HOPS', '1');

  // The editor's live updates (execution progress, "workflow saved elsewhere") over server-sent
  // events instead of n8n's default WebSocket. SSE is plain HTTP, so it works through any proxy,
  // including edges that cannot pass a WebSocket; n8n supports both. Set it to 'websocket' if
  // you'd rather have that.
  setDefault('N8N_PUSH_BACKEND', 'sse');

  // Files handled by workflows are stored in Postgres: the container disk is wiped on every
  // redeploy, and n8n's in-memory mode is deprecated.
  setDefault('N8N_DEFAULT_BINARY_DATA_MODE', 'database');
  setDefault('N8N_DIAGNOSTICS_ENABLED', 'false');

  return { ...env, ...overrides };
}

function spawnN8n(env) {
  // node_modules/.bin/n8n rather than npx: no network lookups, and the version is the locked one.
  return spawn(process.execPath, [require.resolve('n8n/bin/n8n'), 'start'], { env, stdio: 'inherit' });
}

// Waits until n8n has actually recorded the owner, which only happens after its migrations.
// Not /healthz: n8n answers that before migrating, and stopping it there leaves a half-migrated
// database and no owner (which is how this was found).
async function waitForOwner(db, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  child.once('exit', (code) => { exited = code; });
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`n8n exited during first boot (code ${exited})`);
    try {
      if (await withDatabase(db, ownerIsSetUp)) return;
    } catch {
      // The database blipped; keep waiting until the deadline.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('n8n did not finish setting up the owner in time');
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 30000).unref();
  });
}

// A password n8n's own rules would accept (8 to 64 characters, a digit and an upper-case letter).
function generatedPassword() {
  return `${crypto.randomBytes(15).toString('base64url')}A7`;
}

function printOwnerCredentials(email, password) {
  const line = '='.repeat(64);
  console.log([
    '', line,
    ' n8n owner account created. Sign in with:',
    '',
    `   URL:       ${publicUrl}/signin`,
    `   Email:     ${email}`,
    `   Password:  ${password}`,
    '',
    ' This is the only time the password is shown. Change the email and',
    ' password under Settings > Personal once you are in.',
    ' Lost it? Set N8N_OWNER_EMAIL and N8N_OWNER_PASSWORD on the',
    ' Environment tab and redeploy to reset the owner to those.',
    line, '',
  ].join('\n'));
}

// ─── Signals ────────────────────────────────────────────────────────────────

// This process is PID 1 in its container, and PID 1 gets no default signal handling: without a
// handler a redeploy's SIGTERM would be ignored until the platform's grace period ran out. While
// n8n runs, the signal goes to n8n so it can finish what it is executing; before that (setup
// page, waiting for the database) there is nothing to wait for.
let current = null;      // the n8n process running right now, if any
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shuttingDown = true;
    if (current && current.exitCode === null) current.kill(signal);
    else process.exit(0);
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL is not set, so n8n is not started. Serving the setup page instead.\n'
      + 'Bind a managed Postgres to this app as DATABASE_URL, then redeploy.');
    holdingServer(() => ({ status: 200, html: SETUP_PAGE }));
    return;
  }

  const db = parseDatabaseUrl(process.env.DATABASE_URL);
  let status = 'Connecting to the database.';
  const holding = holdingServer(() => ({ status: 503, html: startingPage(status) }));

  // Retry rather than crash: a database that is briefly unreachable should delay n8n, not
  // put the container into a restart loop.
  let encryptionKey, setUp;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ encryptionKey, setUp } = await withDatabase(db, async (client) => ({
        encryptionKey: process.env.N8N_ENCRYPTION_KEY
          || await persistentSecret(client, 'n8n_encryption_key', () => crypto.randomBytes(32).toString('hex')),
        setUp: await ownerIsSetUp(client),
      })));
      break;
    } catch (err) {
      status = `Waiting for the database (${err.message}).`;
      if (attempt === 1 || attempt % 12 === 0) console.error(`database not reachable yet (attempt ${attempt}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // An owner pinned by environment variables (a reset, or someone who prefers it that way).
  // n8n re-applies it on every boot and blocks changing it in the UI while it is set.
  const pinnedEmail = process.env.N8N_OWNER_EMAIL;
  const pinnedPassword = process.env.N8N_OWNER_PASSWORD;
  const ownerEnv = (email, password) => ({
    N8N_INSTANCE_OWNER_MANAGED_BY_ENV: 'true',
    N8N_INSTANCE_OWNER_EMAIL: email,
    N8N_INSTANCE_OWNER_PASSWORD_HASH: bcrypt.hashSync(password, 10),
    N8N_INSTANCE_OWNER_FIRST_NAME: process.env.N8N_OWNER_FIRST_NAME || 'Owner',
    N8N_INSTANCE_OWNER_LAST_NAME: process.env.N8N_OWNER_LAST_NAME || '',
  });

  if (!setUp && !(pinnedEmail && pinnedPassword)) {
    // First boot. Create the owner on a private port before n8n takes public traffic, then
    // restart without the owner variables so the account can be changed in the UI straight away.
    status = 'Setting n8n up for the first time. This takes a minute or two.';
    const email = pinnedEmail || `owner@${new URL(publicUrl).hostname}`;
    const password = generatedPassword();
    const first = spawnN8n(n8nEnv(db, encryptionKey, {
      ...ownerEnv(email, password),
      N8N_PORT: String(FIRST_BOOT_PORT),
      N8N_LISTEN_ADDRESS: '127.0.0.1',
    }));
    current = first;
    try {
      await waitForOwner(db, first, 10 * 60 * 1000);
      await stop(first);
      printOwnerCredentials(email, password);
    } catch (err) {
      if (shuttingDown) process.exit(0); // stopped by a redeploy mid-setup: the next boot retries
      // Leave the container running the holding page with the reason, rather than
      // restart-looping through the same failure.
      console.error(`First boot failed: ${err.message}`);
      status = `First boot failed: ${err.message}. Check the deploy log.`;
      await stop(first);
      return;
    }
  }

  // Never open n8n to the internet without an owner: its setup page would hand the instance to
  // whoever finds it first. Checked against the database rather than trusted from above.
  if (!(pinnedEmail && pinnedPassword)) {
    const ready = await withDatabase(db, ownerIsSetUp).catch(() => false);
    if (!ready) {
      console.error('The n8n owner account does not exist, so n8n is not being opened to the internet. Redeploy to retry the first-boot setup, or set N8N_OWNER_EMAIL and N8N_OWNER_PASSWORD.');
      status = 'The owner account could not be created, so n8n is not being opened. Check the deploy log, then redeploy.';
      return;
    }
  }

  if (shuttingDown) process.exit(0);

  // Free the port for n8n. closeAllConnections drops idle keep-alive sockets too, which would
  // otherwise hold the listener open and make n8n's bind fail with EADDRINUSE.
  await new Promise((resolve) => { holding.close(resolve); holding.closeAllConnections(); });
  const extra = pinnedEmail && pinnedPassword ? ownerEnv(pinnedEmail, pinnedPassword) : {};
  const child = spawnN8n(n8nEnv(db, encryptionKey, {
    ...extra,
    N8N_PORT: String(PORT),
    N8N_LISTEN_ADDRESS: '0.0.0.0',
  }));
  current = child;

  // Go down with n8n. Signals reach it through the handlers above, which lets it finish running
  // executions first, and a stop we asked for is a clean exit whatever code n8n leaves behind:
  // reporting it as a failure would make every redeploy read as a crash. Anything else exits
  // non-zero so the platform restarts it.
  child.on('exit', (code, signal) => {
    if (shuttingDown) process.exit(0);
    console.error(`n8n stopped unexpectedly (${signal || `exit code ${code}`}).`);
    process.exit(code || 1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

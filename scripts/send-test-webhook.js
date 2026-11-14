#!/usr/bin/env node
'use strict';

/**
 * Send a signed, synthetic HubSpot v3 webhook batch to your n8n webhook.
 *
 *   npm run send:test-webhook                  -> signs and POSTs test/fixtures/hubspot-company-webhook-batch.json
 *   npm run send:test-webhook -- --print       -> prints the signed request without sending it
 *   npm run send:test-webhook -- --fixture path/to/batch.json
 *
 * Reads N8N_WEBHOOK_URL, HUBSPOT_APP_CLIENT_SECRET and EXPECTED_PORTAL_ID from the environment
 * or from a local .env file (never committed). Uses only Node built-ins (fetch requires Node 18+).
 */

const fs = require('fs');
const path = require('path');
const { computeSignatureV3 } = require('../src/hubspot-signature');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'hubspot-company-webhook-batch.json');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) return;
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      out[m[1]] = value;
    });
  return out;
}

function parseArgs(argv) {
  const args = { print: false, fixture: DEFAULT_FIXTURE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--print') args.print = true;
    else if (argv[i] === '--fixture') args.fixture = path.resolve(argv[(i += 1)]);
  }
  return args;
}

function isUnset(value) {
  return !value || /^REPLACE_WITH_/.test(String(value)) || /your-n8n-webhook-domain\.com/.test(String(value));
}

/** Build a signed request. Exported for tests. */
function buildSignedRequest({ url, clientSecret, portalId, events, now = Date.now() }) {
  const batch = events.map((e, i) => Object.assign({}, e, {
    portalId: portalId ? Number(portalId) : e.portalId,
    occurredAt: now - (events.length - i) * 1000,
  }));
  const body = JSON.stringify(batch);
  const timestamp = String(now);
  const signature = computeSignatureV3({ clientSecret, method: 'POST', uri: url, rawBody: body, timestamp });
  return {
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-HubSpot-Signature-v3': signature,
      'X-HubSpot-Request-Timestamp': timestamp,
    },
    body,
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const env = Object.assign({}, loadDotEnv(path.join(ROOT, '.env')), process.env);
  const url = env.N8N_WEBHOOK_URL || 'https://your-n8n-webhook-domain.com/webhook/hubspot-company-hierarchy';
  const clientSecret = env.HUBSPOT_APP_CLIENT_SECRET || 'REPLACE_WITH_HUBSPOT_APP_CLIENT_SECRET';
  const events = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));

  if (!args.print && (isUnset(url) || isUnset(clientSecret))) {
    process.stderr.write('Set N8N_WEBHOOK_URL and HUBSPOT_APP_CLIENT_SECRET in .env first, or use --print.\n');
    return 1;
  }

  const request = buildSignedRequest({ url, clientSecret, portalId: isUnset(env.EXPECTED_PORTAL_ID) ? null : env.EXPECTED_PORTAL_ID, events });

  if (args.print) {
    const shown = Object.assign({}, request, { headers: Object.assign({}, request.headers) });
    process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
    return 0;
  }

  const res = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body });
  const text = await res.text();
  process.stdout.write('HTTP ' + res.status + '\n' + text + '\n');
  return res.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(String(err && err.message ? err.message : err) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = { loadDotEnv, parseArgs, buildSignedRequest, main };

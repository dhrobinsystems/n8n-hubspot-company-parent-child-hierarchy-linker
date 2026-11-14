'use strict';

const fs = require('fs');
const path = require('path');

const build = require('../scripts/build-workflow');
const { computeSignatureV3 } = require('../src/hubspot-signature');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_FILE = path.join(ROOT, 'workflow.json');
const workflowText = fs.readFileSync(WORKFLOW_FILE, 'utf8');
const workflow = JSON.parse(workflowText);
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hubspot-company-webhook-batch.json'), 'utf8'));

const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const codeNodes = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compileCodeNode(nodeName) {
  return new AsyncFunction('$input', '$env', '$execution', 'require', byName[nodeName].parameters.jsCode);
}

function inputOf(items) {
  return { first: () => items[0], all: () => items };
}

async function runCodeNode(nodeName, { items, env = {}, helpers = {} }) {
  const fn = compileCodeNode(nodeName);
  return fn.call({ helpers }, inputOf(items), env, { id: 'test-execution' }, require);
}

/* -------------------------------------------------------------------------- */
/* Sync with src/                                                             */
/* -------------------------------------------------------------------------- */

describe('workflow.json build sync', () => {
  test('workflow.json is byte-identical to a fresh build', () => {
    expect(workflowText).toBe(build.renderWorkflow());
  });

  test('build:workflow --check exits 0 when in sync', () => {
    const writes = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((s) => writes.push(s));
    try {
      expect(build.main(['--check'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).toMatch(/in sync/);
  });

  test.each(build.MODULE_FILES)('src/%s is embedded verbatim', (file) => {
    const source = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8').replace(/\s+$/, '');
    const begin = '// ==== BEGIN EMBEDDED MODULE: src/' + file;
    const end = '// ==== END EMBEDDED MODULE: src/' + file + ' ====';
    const hosts = codeNodes.filter((n) => n.parameters.jsCode.includes(begin));
    expect(hosts.length).toBeGreaterThan(0);
    hosts.forEach((n) => {
      const code = n.parameters.jsCode;
      expect(code).toContain(source);
      const block = code.slice(code.indexOf(begin), code.indexOf(end));
      expect(block).toContain(source);
    });
  });

  test('build output is deterministic', () => {
    expect(build.renderWorkflow()).toBe(build.renderWorkflow());
    expect(build.stableId('x')).toBe(build.stableId('x'));
    expect(build.stableId('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

/* -------------------------------------------------------------------------- */
/* Structure                                                                  */
/* -------------------------------------------------------------------------- */

describe('workflow structure', () => {
  test('ships inactive with safe settings', () => {
    expect(workflow.active).toBe(false);
    expect(workflow.settings.executionOrder).toBe('v1');
    expect(workflow.settings.errorWorkflow).toMatch(/^REPLACE_WITH_/);
  });

  test('node IDs and names are unique', () => {
    const ids = workflow.nodes.map((n) => n.id);
    const names = workflow.nodes.map((n) => n.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every connection points at an existing node and output index', () => {
    for (const [from, conn] of Object.entries(workflow.connections)) {
      expect(byName[from]).toBeDefined();
      conn.main.forEach((outputs) => {
        outputs.forEach((t) => {
          expect(byName[t.node]).toBeDefined();
          expect(t.type).toBe('main');
          expect(t.index).toBe(0);
        });
      });
    }
  });

  test('every non-trigger node is reachable from a trigger', () => {
    const triggers = workflow.nodes.filter((n) => /webhook$|errorTrigger$/.test(n.type)).map((n) => n.name);
    const reached = new Set(triggers);
    const queue = triggers.slice();
    while (queue.length) {
      const name = queue.shift();
      const conn = workflow.connections[name];
      if (!conn) continue;
      conn.main.flat().forEach((t) => {
        if (!reached.has(t.node)) {
          reached.add(t.node);
          queue.push(t.node);
        }
      });
    }
    expect(Array.from(reached).sort()).toEqual(workflow.nodes.map((n) => n.name).sort());
  });

  test('webhook keeps the raw body and responds through Respond to Webhook nodes', () => {
    const hook = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
    expect(hook.parameters).toMatchObject({ httpMethod: 'POST', path: build.WEBHOOK_PATH, responseMode: 'responseNode', options: { rawBody: true } });
    const [okBranch, failBranch] = workflow.connections['Signature Valid?'].main;
    expect(okBranch.map((t) => t.node)).toEqual(['Acknowledge 200']);
    expect(failBranch.map((t) => t.node)).toEqual(['Reject 401']);
    expect(byName['Reject 401'].parameters.options.responseCode).toBe(401);
    expect(workflow.connections['Reject 401']).toBeUndefined();
  });

  test('linker output fans out to review and audit branches', () => {
    expect(workflow.connections['Resolve, Guard & Link Hierarchy'].main[0].map((t) => t.node).sort()).toEqual(['Audit Log Enabled?', 'Needs Human Review?']);
    expect(workflow.connections['Needs Human Review?'].main[0].map((t) => t.node)).toEqual(['Create Review Ticket']);
    expect(workflow.connections['Audit Log Enabled?'].main[0].map((t) => t.node)).toEqual(['Send Audit Log']);
  });

  test('error routing: Error Trigger -> Classify Error -> alert', () => {
    expect(byName['Error Trigger'].type).toBe('n8n-nodes-base.errorTrigger');
    expect(workflow.connections['Error Trigger'].main[0][0].node).toBe('Classify Error');
    expect(workflow.connections['Classify Error'].main[0][0].node).toBe('Error Alert Enabled?');
    expect(workflow.connections['Error Alert Enabled?'].main[0][0].node).toBe('Send Error Alert');
  });

  test('HTTP nodes use credential placeholders and never fail the run', () => {
    const httpNodes = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
    expect(httpNodes.length).toBe(3);
    httpNodes.forEach((n) => {
      expect(n.credentials.httpHeaderAuth.id).toBe(build.CREDENTIAL_PLACEHOLDER);
      expect(n.onError).toBe('continueRegularOutput');
      expect(n.parameters.url).toMatch(/^=\{\{ \$(env|json)\./);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Code nodes compile and run                                                 */
/* -------------------------------------------------------------------------- */

describe('Code nodes', () => {
  test.each(codeNodes.map((n) => n.name))('%s compiles', (name) => {
    expect(() => compileCodeNode(name)).not.toThrow();
  });

  const SECRET = 'test-client-secret-not-real';
  const URL_ = 'https://your-n8n-webhook-domain.com/webhook/hubspot-company-hierarchy';
  const now = Date.now();
  const body = JSON.stringify(FIXTURE);
  const headers = {
    'x-hubspot-signature-v3': computeSignatureV3({ clientSecret: SECRET, method: 'POST', uri: URL_, rawBody: body, timestamp: String(now) }),
    'x-hubspot-request-timestamp': String(now),
  };
  const webhookItem = (raw) => ({ json: { headers, query: {} }, binary: { data: { data: Buffer.from(raw, 'utf8').toString('base64') } } });
  const noBinaryHelper = { getBinaryDataBuffer: async () => { throw new Error('binary store unavailable'); } };
  const env = { HUBSPOT_APP_CLIENT_SECRET: SECRET, WEBHOOK_PUBLIC_URL: URL_, EXPECTED_PORTAL_ID: '1234567', HUBSPOT_APP_ID: '7654321' };

  test('Verify HubSpot Signature accepts a signed batch and rejects a tampered one', async () => {
    const good = await runCodeNode('Verify HubSpot Signature', { items: [webhookItem(body)], env, helpers: noBinaryHelper });
    expect(good[0].json).toMatchObject({ valid: true, reason: null, eventCount: FIXTURE.length });

    const viaHelper = await runCodeNode('Verify HubSpot Signature', { items: [{ json: { headers } }], env, helpers: { getBinaryDataBuffer: async () => Buffer.from(body) } });
    expect(viaHelper[0].json.valid).toBe(true);

    const bad = await runCodeNode('Verify HubSpot Signature', { items: [webhookItem(body.replace('1002', '1009'))], env, helpers: noBinaryHelper });
    expect(bad[0].json).toMatchObject({ valid: false, reason: 'SIGNATURE_MISMATCH', events: [] });
  });

  test('Filter & Deduplicate Events emits one item per company', async () => {
    const out = await runCodeNode('Filter & Deduplicate Events', { items: [{ json: { events: FIXTURE } }], env });
    expect(out.map((i) => i.json.work.companyId)).toEqual(['1002', '1003', '1004']);
  });

  test('Resolve, Guard & Link Hierarchy runs in dry-run against a mocked HubSpot API', async () => {
    const companies = {
      1001: { id: '1001', properties: { domain: 'example.com', annualrevenue: '1000' } },
      1002: { id: '1002', properties: { domain: 'emea.example.com', annualrevenue: '100' } },
    };
    const calls = [];
    const helpers = {
      httpRequest: async (opts) => {
        calls.push(opts);
        expect(opts).toMatchObject({ returnFullResponse: true, ignoreHttpStatusErrors: true });
        const u = new URL(opts.url);
        let m;
        if (opts.method === 'GET' && (m = u.pathname.match(/^\/crm\/v3\/objects\/companies\/(\d+)$/))) {
          return companies[m[1]] ? { statusCode: 200, body: companies[m[1]] } : { statusCode: 404, body: {} };
        }
        if (opts.method === 'POST' && u.pathname.endsWith('/companies/search')) {
          const value = opts.body.filterGroups[0].filters[0].value;
          return { statusCode: 200, body: { results: Object.values(companies).filter((c) => c.properties.domain === value) } };
        }
        if (opts.method === 'POST' && u.pathname.endsWith('/batch/read')) {
          return { statusCode: 200, body: { results: opts.body.inputs.map((i) => companies[i.id]).filter(Boolean) } };
        }
        if (opts.method === 'GET' && /\/associations\/companies$/.test(u.pathname)) {
          return { statusCode: 200, body: { results: [] } };
        }
        throw new Error('Unexpected request in dry-run: ' + opts.method + ' ' + u.pathname);
      },
    };
    const items = [{ json: { work: { companyId: '1002', portalId: '1234567', propertyNames: ['domain'] } } }];
    const out = await runCodeNode('Resolve, Guard & Link Hierarchy', { items, env: Object.assign({}, env, { HUBSPOT_PRIVATE_APP_TOKEN: 'test-token-not-real' }), helpers });
    expect(out[0].json).toMatchObject({ action: 'link', dryRun: true, companyId: '1002', auditEnabled: false, reviewEnabled: false, review: null });
    expect(out[0].json.audit).toMatchObject({ parentId: '1001', executionId: 'test-execution', triggers: ['domain'] });
    expect(calls.some((c) => c.method === 'PUT' || c.url.endsWith('/batch/update'))).toBe(false);
  });

  test('Resolve, Guard & Link Hierarchy fails loudly without a token (routes to Error Trigger)', async () => {
    const items = [{ json: { work: { companyId: '1002', portalId: '1234567' } } }];
    await expect(runCodeNode('Resolve, Guard & Link Hierarchy', { items, env, helpers: { httpRequest: async () => ({}) } })).rejects.toThrow(/not configured/);
  });

  test('Classify Error builds a redacted alert', async () => {
    const leaked = 'Bearer ' + 'x'.repeat(24);
    const items = [{ json: { execution: { id: '7', error: { message: 'Request failed ' + leaked, httpCode: '503' } }, workflow: { id: 'wf' } } }];
    const out = await runCodeNode('Classify Error', { items, env: { AUDIT_LOG_WEBHOOK_URL: 'https://audit.example.com/hook' } });
    expect(out[0].json.alertEnabled).toBe(true);
    expect(out[0].json.alert.classification).toMatchObject({ category: 'SERVER', retryable: true });
    expect(JSON.stringify(out[0].json)).not.toContain(leaked);
  });
});

/* -------------------------------------------------------------------------- */
/* Secret and PII scanning                                                    */
/* -------------------------------------------------------------------------- */

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist']);
const TEXT_EXT = new Set(['.js', '.json', '.md', '.txt', '.yml', '.yaml', '.example', '']);

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (TEXT_EXT.has(path.extname(entry.name)) && entry.name !== 'package-lock.json' && !entry.name.endsWith('.zip')) out.push(full);
  }
  return out;
}

const repoFiles = listFiles(ROOT).map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));
const DOC_FILES = new Set(['README.md', 'DISCLAIMER.md', 'LICENSE', 'package.json']);
const AUTHOR_EMAIL = ['robin', 'dhrobinsystems.com'].join('@');

// Built from fragments so this file never contains a literal that matches its own patterns.
const SECRET_PATTERNS = [
  ['HubSpot private app token', new RegExp('\\bpat-(na|eu|ap)\\d?-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b', 'i')],
  ['Bearer token literal', new RegExp('Bearer\\s+[A-Za-z0-9._~+/-]{20,}=*')],
  ['HubSpot legacy API key', new RegExp('hapikey=[0-9a-f]{8}-', 'i')],
  ['Private key block', new RegExp('-----BEGIN [A-Z ]*PRIVATE ' + 'KEY-----')],
  ['AWS access key', new RegExp('\\bAKIA[0-9A-Z]{16}\\b')],
  ['GitHub token', new RegExp('\\bgh[pousr]_[A-Za-z0-9]{36,}\\b')],
  ['Slack token', new RegExp('\\bxox[abposr]-[A-Za-z0-9-]{10,}\\b')],
  ['Generic secret assignment', new RegExp('(client_secret|api_key|access_token)\\s*[:=]\\s*["\'][A-Za-z0-9_\\-]{24,}["\']', 'i')],
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const SAFE_EMAIL_DOMAIN = /(^|\.)example\.(com|org|net)$/i;

describe('security: no secrets, real tokens or PII', () => {
  test('repository scan covers the workflow, sources, tests and docs', () => {
    const rels = repoFiles.map((f) => f.rel);
    ['workflow.json', 'src/hierarchy-linker.js', 'src/hubspot-signature.js', 'src/event-filter.js', 'README.md', '.env.example'].forEach((f) => expect(rels).toContain(f));
  });

  test.each(SECRET_PATTERNS)('no %s anywhere in the repository', (label, pattern) => {
    const hits = repoFiles.filter((f) => pattern.test(f.text)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  test('every email address uses an RFC 2606 domain (author contact allowed only in docs)', () => {
    const offenders = [];
    repoFiles.forEach((f) => {
      for (const m of f.text.matchAll(EMAIL_RE)) {
        if (SAFE_EMAIL_DOMAIN.test(m[1])) continue;
        if (m[0].toLowerCase() === AUTHOR_EMAIL && DOC_FILES.has(f.rel)) continue;
        offenders.push(f.rel + ': ' + m[0]);
      }
    });
    expect(offenders).toEqual([]);
  });

  test('workflow.json only references placeholder or HubSpot API hosts', () => {
    const hosts = Array.from(workflowText.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)).map((m) => m[1].toLowerCase());
    const allowed = /^(api\.hubapi\.com|your-n8n-webhook-domain\.com|([a-z0-9-]+\.)*example\.(com|org|net))$/;
    expect(hosts.filter((h) => !allowed.test(h))).toEqual([]);
  });

  test('workflow.json contains no credentials, only placeholders', () => {
    workflow.nodes.forEach((n) => {
      Object.values(n.credentials || {}).forEach((c) => expect(c.id).toMatch(/^REPLACE_WITH_/));
    });
    expect(workflowText).not.toMatch(/"(token|password|secret|apiKey)"\s*:\s*"(?!REPLACE_WITH_)[^"]{8,}"/i);
  });

  test('fixtures use synthetic IDs and RFC 2606 domains only', () => {
    FIXTURE.forEach((e) => {
      expect([1234567, 7777777]).toContain(e.portalId);
      expect(e.objectId).toBeGreaterThanOrEqual(1001);
      expect(e.objectId).toBeLessThan(2000);
      if (typeof e.propertyValue === 'string' && /\./.test(e.propertyValue) && !/\s/.test(e.propertyValue)) {
        expect(e.propertyValue).toMatch(/(^|\.)example\.(com|org|net)$/);
      }
    });
  });

  test('.env.example holds placeholders for every secret', () => {
    const envText = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const vars = Object.fromEntries(envText.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
    ['HUBSPOT_PRIVATE_APP_TOKEN', 'HUBSPOT_APP_CLIENT_SECRET'].forEach((k) => expect(vars[k]).toMatch(/^REPLACE_WITH_/));
    expect(vars.DRY_RUN).toBe('true');
    expect(vars.SANDBOX_MODE).toBe('true');
    expect(vars.MAX_HIERARCHY_DEPTH).toBe('5');
  });

  test('.gitignore excludes env files, credentials, logs and coverage', () => {
    const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    ['node_modules/', '.env', '.env.*', '!.env.example', 'coverage/', '*.log', '*.credentials.json'].forEach((entry) => expect(lines).toContain(entry));
  });
});

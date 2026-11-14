'use strict';

const path = require('path');
const fs = require('fs');

const signature = require('../src/hubspot-signature');
const filter = require('../src/event-filter');
const linker = require('../src/hierarchy-linker');
const { buildSignedRequest } = require('../scripts/send-test-webhook');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hubspot-company-webhook-batch.json'), 'utf8'));

const PORTAL = '1234567';
const APP_ID = '7654321';
const TEST_SECRET = 'test-client-secret-not-real';
const WEBHOOK_URL = 'https://your-n8n-webhook-domain.com/webhook/hubspot-company-hierarchy';
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/* -------------------------------------------------------------------------- */
/* In-memory HubSpot fake                                                     */
/* -------------------------------------------------------------------------- */

function company(id, props) {
  return { id: String(id), properties: Object.assign({}, props) };
}

function createFakeHubSpot(companies, options = {}) {
  const db = new Map(companies.map((c) => [String(c.id), JSON.parse(JSON.stringify(c))]));
  const calls = { associate: [], batchUpdate: [], searches: [] };
  const all = () => Array.from(db.values());
  return {
    db,
    calls,
    async getCompany(id) {
      return db.get(String(id)) || null;
    },
    async getCompanies(ids) {
      return ids.map((id) => db.get(String(id))).filter(Boolean);
    },
    async findCompaniesByDomain(domain) {
      calls.searches.push(['domain', domain]);
      return all().filter((c) => linker.normalizeDomain(c.properties.domain) === domain);
    },
    async findCompaniesByDuns(duns) {
      calls.searches.push(['duns', duns]);
      return all().filter((c) => linker.normalizeDuns(c.properties.duns_number) === duns);
    },
    async getParentId(id) {
      const c = db.get(String(id));
      return c ? c.properties.hs_parent_company_id || '' : '';
    },
    async getChildIds(id) {
      const kids = all().filter((c) => c.properties.hs_parent_company_id === String(id)).map((c) => c.id);
      return options.duplicateChildLinks ? kids.concat(kids) : kids;
    },
    async associateParent(childId, parentId) {
      calls.associate.push([String(childId), String(parentId)]);
      if (!options.dropAssociations) db.get(String(childId)).properties.hs_parent_company_id = String(parentId);
    },
    async verifyParentAssociation(childId, parentId) {
      return db.get(String(childId)).properties.hs_parent_company_id === String(parentId);
    },
    async batchUpdateCompanies(inputs) {
      calls.batchUpdate.push(inputs);
      inputs.forEach((i) => Object.assign(db.get(String(i.id)).properties, i.properties));
    },
  };
}

const dryConfig = () => linker.loadConfig({});
const liveSandboxConfig = (extra = {}) =>
  linker.loadConfig(Object.assign({ DRY_RUN: 'false', SANDBOX_MODE: 'true', HUBSPOT_SANDBOX_PORTAL_ID: PORTAL }, extra));

function work(companyId, propertyNames = ['domain']) {
  return { companyId: String(companyId), portalId: PORTAL, propertyNames, isCreation: false };
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

describe('loadConfig', () => {
  test('defaults to safe mode: DRY_RUN=true, SANDBOX_MODE=true, MAX_HIERARCHY_DEPTH=5', () => {
    const cfg = linker.loadConfig({});
    expect(cfg.dryRun).toBe(true);
    expect(cfg.sandboxMode).toBe(true);
    expect(cfg.maxDepth).toBe(5);
    expect(cfg.associationTypes).toEqual({ primaryParent: 14, child: 13 });
    expect(cfg.auditLogEnabled).toBe(false);
  });

  test('ignores REPLACE_WITH_ placeholders and malformed values', () => {
    const cfg = linker.loadConfig({
      EXPECTED_PORTAL_ID: 'REPLACE_WITH_HUBSPOT_PORTAL_ID',
      AUDIT_LOG_WEBHOOK_URL: 'REPLACE_WITH_AUDIT_LOG_WEBHOOK_URL',
      MAX_HIERARCHY_DEPTH: 'abc',
      DRY_RUN: 'maybe',
    });
    expect(cfg.expectedPortalId).toBe('');
    expect(cfg.auditLogEnabled).toBe(false);
    expect(cfg.maxDepth).toBe(5);
    expect(cfg.dryRun).toBe(true);
  });

  test('parses explicit overrides', () => {
    const cfg = linker.loadConfig({ DRY_RUN: 'false', SANDBOX_MODE: '0', MAX_HIERARCHY_DEPTH: '3', REGIONAL_PARENT_TLDS: 'com, net', EXTRA_FREE_MAIL_DOMAINS: 'mail.example.net' });
    expect(cfg.dryRun).toBe(false);
    expect(cfg.sandboxMode).toBe(false);
    expect(cfg.maxDepth).toBe(3);
    expect(cfg.regionalParentTlds).toEqual(['com', 'net']);
    expect(linker.isFreeMailDomain('mail.example.net', cfg)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Domain utilities                                                           */
/* -------------------------------------------------------------------------- */

describe('domain utilities', () => {
  test.each([
    ['https://www.Example.com/about?x=1', 'example.com'],
    ['http://emea.example.com:8080/', 'emea.example.com'],
    ['person@example.org', 'example.org'],
    ['example.net.', 'example.net'],
    ['www2.example.com', 'example.com'],
    ['not a domain', ''],
    ['', ''],
    [null, ''],
  ])('normalizeDomain(%p) -> %p', (input, expected) => {
    expect(linker.normalizeDomain(input)).toBe(expected);
  });

  test('root domain, public suffix and brand label handle multi-part suffixes', () => {
    expect(linker.getRootDomain('emea.example.com')).toBe('example.com');
    expect(linker.getRootDomain('shop.uk.example.co.uk')).toBe('example.co.uk');
    expect(linker.getPublicSuffix('example.co.uk')).toBe('co.uk');
    expect(linker.getBrandLabel('apac.example.com.au')).toBe('example');
    expect(linker.isSubdomain('example.com')).toBe(false);
    expect(linker.isSubdomain('emea.example.com')).toBe(true);
  });

  test('free-mail and parked / shared-hosting domains are excluded', () => {
    const cfg = dryConfig();
    expect(linker.isExcludedDomain('gmail.com', cfg)).toBe(true);
    expect(linker.isExcludedDomain('tenant.myshopify.com', cfg)).toBe(true);
    expect(linker.isExcludedDomain('subsidiary.example.com', cfg)).toBe(false);
  });

  test('DUNS normalization pads 8 digits and rejects garbage', () => {
    expect(linker.normalizeDuns('12-345-678')).toBe('012345678');
    expect(linker.normalizeDuns('123456789')).toBe('123456789');
    expect(linker.normalizeDuns('12')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* Parent candidate resolution                                                */
/* -------------------------------------------------------------------------- */

describe('resolveParentCandidates', () => {
  const parent = company(1001, { domain: 'example.com', duns_number: '123456789' });

  test('tier 1: explicit parent_company_domain', async () => {
    const child = company(1002, { domain: 'subsidiary.example.org', parent_company_domain: 'https://www.example.com' });
    const hs = createFakeHubSpot([parent, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res.status).toBe('match');
    expect(res.tier).toBe(1);
    expect(res.candidates[0].id).toBe('1001');
    expect(res.candidates[0].sources).toEqual(['explicit_parent_domain']);
  });

  test.each([
    ['clearbit_parent_domain', 'clearbit'],
    ['apollo_parent_domain', 'apollo'],
    ['parent_domain', 'explicit_parent_domain'],
  ])('tier 1: %s enrichment metadata', async (property, source) => {
    const child = company(1002, { domain: 'subsidiary.example.org', [property]: 'example.com' });
    const hs = createFakeHubSpot([parent, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res.status).toBe('match');
    expect(res.candidates[0].sources).toContain(source);
  });

  test('tier 1: duns_parent_id matches duns_number', async () => {
    const child = company(1002, { domain: 'subsidiary.example.org', duns_parent_id: '123456789' });
    const hs = createFakeHubSpot([parent, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res.status).toBe('match');
    expect(res.candidates[0].sources).toEqual(['duns']);
  });

  test('agreeing tier 1 sources merge into one candidate', async () => {
    const child = company(1002, { domain: 'subsidiary.example.org', parent_company_domain: 'example.com', duns_parent_id: '123456789', clearbit_parent_domain: 'example.com' });
    const hs = createFakeHubSpot([parent, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res.status).toBe('match');
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].sources.sort()).toEqual(['clearbit', 'duns', 'explicit_parent_domain']);
  });

  test('disagreeing tier 1 sources are ambiguous', async () => {
    const other = company(1003, { domain: 'example.net' });
    const child = company(1002, { domain: 'subsidiary.example.org', parent_company_domain: 'example.com', apollo_parent_domain: 'example.net' });
    const hs = createFakeHubSpot([parent, other, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res.status).toBe('ambiguous');
    expect(res.reason).toBe(linker.REASONS.AMBIGUOUS_PARENT);
    expect(res.candidates.map((c) => c.id).sort()).toEqual(['1001', '1003']);
  });

  test('ultimate_parent_domain is only a fallback', async () => {
    const ultimate = company(1009, { domain: 'example.net' });
    const child = company(1002, { domain: 'subsidiary.example.org', ultimate_parent_domain: 'example.net' });
    const hs = createFakeHubSpot([ultimate, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res.status).toBe('match');
    expect(res.candidates[0].id).toBe('1009');
    expect(res.candidates[0].sources).toEqual(['ultimate_parent_domain']);

    const both = company(1002, { domain: 'subsidiary.example.org', parent_company_domain: 'example.com', ultimate_parent_domain: 'example.net' });
    const hs2 = createFakeHubSpot([parent, ultimate, both]);
    const res2 = await linker.resolveParentCandidates(both, hs2, dryConfig());
    expect(res2.candidates[0].id).toBe('1001');
  });

  test('explicit metadata without a CRM match never falls back to domain heuristics', async () => {
    const root = company(1001, { domain: 'example.com' });
    const child = company(1002, { domain: 'emea.example.com', parent_company_domain: 'example.org' });
    const hs = createFakeHubSpot([root, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res.status).toBe('none');
    expect(res.reason).toBe(linker.REASONS.EXPLICIT_PARENT_NOT_FOUND);
  });

  test('free-mail explicit values are ignored and tier 2 is used', async () => {
    const root = company(1001, { domain: 'example.com' });
    const child = company(1002, { domain: 'emea.example.com', parent_company_domain: 'gmail.com' });
    const hs = createFakeHubSpot([root, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res.status).toBe('match');
    expect(res.tier).toBe(2);
    expect(res.trace[0].excluded).toBe(true);
  });

  test('tier 2: subdomain resolves to root domain', async () => {
    const root = company(1001, { domain: 'example.com' });
    const child = company(1002, { website: 'https://emea.example.com/de' });
    const hs = createFakeHubSpot([root, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res).toMatchObject({ status: 'match', tier: 2 });
    expect(res.candidates[0].sources).toEqual(['root_domain']);
  });

  test('tier 2: regional TLD entity resolves to the .com brand', async () => {
    const root = company(1001, { domain: 'example.com' });
    const child = company(1002, { domain: 'example.co.uk' });
    const hs = createFakeHubSpot([root, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res).toMatchObject({ status: 'match', tier: 2 });
    expect(res.candidates[0].sources).toEqual(['regional_domain']);
  });

  test('tier 2: duplicate root-domain records are ambiguous', async () => {
    const a = company(1001, { domain: 'example.com' });
    const b = company(1003, { domain: 'www.example.com' });
    const child = company(1002, { domain: 'emea.example.com' });
    const hs = createFakeHubSpot([a, b, child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res.status).toBe('ambiguous');
  });

  test('tier 2 is skipped for free-mail and shared-hosting domains', async () => {
    const platform = company(1001, { domain: 'myshopify.com' });
    const tenant = company(1002, { domain: 'tenant.myshopify.com' });
    const freemail = company(1003, { domain: 'gmail.com' });
    const hs = createFakeHubSpot([platform, tenant, freemail]);
    expect((await linker.resolveParentCandidates(tenant, hs, dryConfig())).reason).toBe(linker.REASONS.EXCLUDED_DOMAIN);
    expect((await linker.resolveParentCandidates(freemail, hs, dryConfig())).reason).toBe(linker.REASONS.EXCLUDED_DOMAIN);
  });

  test('tier 2 can be disabled', async () => {
    const root = company(1001, { domain: 'example.com' });
    const child = company(1002, { domain: 'emea.example.com' });
    const hs = createFakeHubSpot([root, child]);
    const cfg = linker.loadConfig({ ENABLE_SUBDOMAIN_MATCHING: 'false', ENABLE_REGIONAL_MATCHING: 'false' });
    expect((await linker.resolveParentCandidates(child, hs, cfg)).status).toBe('none');
  });

  test('explicit parent pointing at the company itself is a self-parent', async () => {
    const child = company(1002, { domain: 'example.com', parent_company_domain: 'example.com' });
    const hs = createFakeHubSpot([child]);
    const res = await linker.resolveParentCandidates(child, hs, dryConfig());
    expect(res.status).toBe('self');
    expect(res.reason).toBe(linker.REASONS.SELF_PARENT);
  });

  test('no domain and no metadata yields NO_PARENT_SIGNAL', async () => {
    const child = company(1002, { name: 'Synthetic Co' });
    const res = await linker.resolveParentCandidates(child, createFakeHubSpot([child]), dryConfig());
    expect(res).toMatchObject({ status: 'none', reason: linker.REASONS.NO_PARENT_SIGNAL });
  });
});

/* -------------------------------------------------------------------------- */
/* Cycle and depth guards                                                     */
/* -------------------------------------------------------------------------- */

describe('checkLinkSafety', () => {
  const parentsOf = (map) => async (id) => map[id] || '';

  test('blocks self-parenting A -> A', async () => {
    const res = await linker.checkLinkSafety({ childId: '1001', parentId: '1001', getParentId: parentsOf({}) });
    expect(res).toMatchObject({ ok: false, reason: linker.REASONS.SELF_PARENT, cycleLength: 1 });
  });

  test('blocks a direct 2-node cycle A -> B -> A', async () => {
    // B (1002) already has parent A (1001); linking A under B closes the loop.
    const res = await linker.checkLinkSafety({ childId: '1001', parentId: '1002', getParentId: parentsOf({ 1002: '1001' }) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(linker.REASONS.CIRCULAR_REFERENCE);
    expect(res.cyclePath).toEqual(['1001', '1002', '1001']);
    expect(res.cycleLength).toBe(2);
  });

  test('blocks a multi-hop cycle A -> B -> C -> A', async () => {
    const res = await linker.checkLinkSafety({ childId: '1001', parentId: '1002', getParentId: parentsOf({ 1002: '1003', 1003: '1001' }) });
    expect(res.reason).toBe(linker.REASONS.CIRCULAR_REFERENCE);
    expect(res.cyclePath).toEqual(['1001', '1002', '1003', '1001']);
    expect(res.cycleLength).toBe(3);
  });

  test('flags a pre-existing cycle above the proposed parent', async () => {
    const res = await linker.checkLinkSafety({ childId: '1009', parentId: '1001', getParentId: parentsOf({ 1001: '1002', 1002: '1003', 1003: '1002' }) });
    expect(res.reason).toBe(linker.REASONS.EXISTING_CYCLE);
    expect(res.cyclePath).toEqual(['1002', '1003', '1002']);
  });

  test('enforces MAX_HIERARCHY_DEPTH on the upward chain', async () => {
    // Chain: 1001 <- 1002 <- 1003 <- 1004 <- 1005 <- 1006 (1006 at depth 5). New child would be depth 6.
    const map = { 1006: '1005', 1005: '1004', 1004: '1003', 1003: '1002', 1002: '1001' };
    const res = await linker.checkLinkSafety({ childId: '1099', parentId: '1006', getParentId: parentsOf(map), maxDepth: 5 });
    expect(res).toMatchObject({ ok: false, reason: linker.REASONS.DEPTH_EXCEEDED });

    const ok = await linker.checkLinkSafety({ childId: '1099', parentId: '1005', getParentId: parentsOf(map), maxDepth: 5 });
    expect(ok).toMatchObject({ ok: true, parentDepth: 4, childDepth: 5, ultimateParentId: '1001' });
  });

  test('stops walking when the chain is longer than the depth budget', async () => {
    const map = {};
    for (let i = 1100; i < 1120; i += 1) map[i] = String(i + 1);
    const res = await linker.checkLinkSafety({ childId: '1099', parentId: '1100', getParentId: parentsOf(map), maxDepth: 3 });
    expect(res.reason).toBe(linker.REASONS.DEPTH_EXCEEDED);
    expect(res.chain.length).toBeLessThanOrEqual(4);
  });

  test('accounts for the height of the child subtree being attached', async () => {
    const res = await linker.checkLinkSafety({ childId: '1099', parentId: '1002', getParentId: parentsOf({ 1002: '1001' }), childSubtreeHeight: 4, maxDepth: 5 });
    expect(res.reason).toBe(linker.REASONS.DEPTH_EXCEEDED);
  });

  test('safe link reports chain, depths and ultimate parent', async () => {
    const res = await linker.checkLinkSafety({ childId: '1003', parentId: '1002', getParentId: parentsOf({ 1002: '1001' }) });
    expect(res).toMatchObject({ ok: true, chain: ['1002', '1001'], parentDepth: 1, childDepth: 2, ultimateParentId: '1001' });
  });
});

/* -------------------------------------------------------------------------- */
/* Rollup engine                                                              */
/* -------------------------------------------------------------------------- */

describe('computeFamilyRollup', () => {
  const byId = (list) => list.reduce((acc, c) => Object.assign(acc, { [c.id]: c }), {});

  test('sums ARR and open + closed-won deal value bottom-up', () => {
    const companies = byId([
      company(1001, { annualrevenue: '1000000', hs_total_deal_value: '50000', total_revenue: '20000' }),
      company(1002, { annualrevenue: '500000', hs_total_deal_value: '10000', total_revenue: '5000' }),
      company(1003, { annualrevenue: '250000', hs_total_deal_value: '0', total_revenue: '1000' }),
      company(1004, { annualrevenue: '100000' }),
    ]);
    const children = { 1001: ['1002', '1004'], 1002: ['1003'] };
    const r = linker.computeFamilyRollup('1001', companies, children);
    expect(r.byId['1001']).toMatchObject({ familyArr: 1850000, childCount: 3, directChildCount: 2, openDealValue: 60000, closedWonValue: 26000, totalDealValue: 86000, depth: 0 });
    expect(r.byId['1002']).toMatchObject({ familyArr: 750000, childCount: 1, totalDealValue: 16000, depth: 1 });
    expect(r.byId['1003']).toMatchObject({ familyArr: 250000, childCount: 0, depth: 2 });
  });

  test('never double-counts a subsidiary reachable through two parents (diamond)', () => {
    const companies = byId([
      company(1001, { annualrevenue: '100' }),
      company(1002, { annualrevenue: '10' }),
      company(1003, { annualrevenue: '10' }),
      company(1004, { annualrevenue: '1' }),
    ]);
    const children = { 1001: ['1002', '1003'], 1002: ['1004'], 1003: ['1004'] };
    const r = linker.computeFamilyRollup('1001', companies, children);
    expect(r.byId['1001'].familyArr).toBe(121);
    expect(r.byId['1001'].childCount).toBe(3);
    expect(r.duplicatesIgnored).toEqual(['1004']);
  });

  test('survives cycles and duplicate association rows in source data', () => {
    const companies = byId([company(1001, { annualrevenue: '100' }), company(1002, { annualrevenue: '50' })]);
    const children = { 1001: ['1002', '1002'], 1002: ['1001'] };
    const r = linker.computeFamilyRollup('1001', companies, children);
    expect(r.byId['1001']).toMatchObject({ familyArr: 150, childCount: 1 });
  });

  test('treats missing, invalid and negative values as zero and avoids float drift', () => {
    const companies = byId([
      company(1001, { annualrevenue: '0.1' }),
      company(1002, { annualrevenue: '0.2' }),
      company(1003, { annualrevenue: 'n/a' }),
      company(1004, { annualrevenue: '-500' }),
    ]);
    const r = linker.computeFamilyRollup('1001', companies, { 1001: ['1002', '1003', '1004'] });
    expect(r.byId['1001'].familyArr).toBe(0.3);
    expect(r.byId['1001'].childCount).toBe(3);
  });

  test('respects maxDepth', () => {
    const companies = byId([company(1001, { annualrevenue: '1' }), company(1002, { annualrevenue: '1' }), company(1003, { annualrevenue: '1' })]);
    const r = linker.computeFamilyRollup('1001', companies, { 1001: ['1002'], 1002: ['1003'] }, { maxDepth: 1 });
    expect(r.byId['1001'].familyArr).toBe(2);
    expect(r.byId['1003']).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end orchestration against the in-memory fake                        */
/* -------------------------------------------------------------------------- */

function familyFixture() {
  return [
    company(1001, { domain: 'example.com', annualrevenue: '1000000', hs_total_deal_value: '40000', total_revenue: '60000' }),
    company(1003, { domain: 'example.co.uk', annualrevenue: '300000', hs_total_deal_value: '5000', total_revenue: '0', hs_parent_company_id: '1001' }),
    company(1002, { domain: 'emea.example.com', annualrevenue: '200000', hs_total_deal_value: '10000', total_revenue: '2500' }),
  ];
}

describe('processCompany', () => {
  test('dry-run: plans the association and projected rollups without writing', async () => {
    const hs = createFakeHubSpot(familyFixture());
    const res = await linker.processCompany(work(1002), { client: hs, config: dryConfig(), now: () => FIXED_NOW });

    expect(res).toMatchObject({ action: 'link', reason: 'NEW_LINK', dryRun: true, dryRunReason: 'DRY_RUN_ENABLED', parentId: '1001', ultimateParentId: '1001', hierarchyTier: 2 });
    expect(res.plannedWrites.associations).toEqual([
      expect.objectContaining({ method: 'PUT', path: '/crm/v4/objects/companies/1002/associations/companies/1001', associationTypeId: 14, associationCategory: 'HUBSPOT_DEFINED' }),
    ]);
    const parentUpdate = res.plannedWrites.propertyUpdates.find((u) => u.id === '1001');
    expect(parentUpdate.properties).toMatchObject({
      rolled_up_family_arr: '1500000',
      rolled_up_child_count: '2',
      rolled_up_total_deal_value: '117500',
      hierarchy_tier: '1',
      ultimate_parent_company_id: '1001',
      hierarchy_last_synced_at: FIXED_NOW.toISOString(),
    });
    const childUpdate = res.plannedWrites.propertyUpdates.find((u) => u.id === '1002');
    expect(childUpdate.properties).toEqual({ hierarchy_tier: '2', ultimate_parent_company_id: '1001', hierarchy_last_synced_at: FIXED_NOW.toISOString() });
    expect(hs.calls.associate).toHaveLength(0);
    expect(hs.calls.batchUpdate).toHaveLength(0);
    expect(res.executedWrites).toBeNull();
  });

  test('live sandbox: associates, verifies, then writes metadata and rollups', async () => {
    const hs = createFakeHubSpot(familyFixture());
    const res = await linker.processCompany(work(1002), { client: hs, config: liveSandboxConfig(), now: () => FIXED_NOW });
    expect(res).toMatchObject({ action: 'link', dryRun: false, verification: { checked: true, verified: true }, executedWrites: { associations: 1, propertyUpdates: 2 } });
    expect(hs.calls.associate).toEqual([['1002', '1001']]);
    expect(hs.db.get('1001').properties.rolled_up_family_arr).toBe('1500000');
    expect(hs.db.get('1002').properties.hs_parent_company_id).toBe('1001');
  });

  test('sandbox gate forces dry-run outside the sandbox portal', async () => {
    const hs = createFakeHubSpot(familyFixture());
    const wrongPortal = Object.assign(work(1002), { portalId: '7777777' });
    const res = await linker.processCompany(wrongPortal, { client: hs, config: liveSandboxConfig() });
    expect(res).toMatchObject({ dryRun: true, dryRunReason: 'PORTAL_IS_NOT_SANDBOX' });
    expect(hs.calls.associate).toHaveLength(0);

    const unconfigured = linker.loadConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'true' });
    const res2 = await linker.processCompany(work(1002), { client: hs, config: unconfigured });
    expect(res2).toMatchObject({ dryRun: true, dryRunReason: 'SANDBOX_PORTAL_NOT_CONFIGURED' });
  });

  test('production mode requires both DRY_RUN=false and SANDBOX_MODE=false', async () => {
    const hs = createFakeHubSpot(familyFixture());
    const prod = linker.loadConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'false' });
    const res = await linker.processCompany(Object.assign(work(1002), { portalId: '7777777' }), { client: hs, config: prod });
    expect(res.dryRun).toBe(false);
    expect(hs.calls.associate).toHaveLength(1);
  });

  test('failed post-association verification routes to review and skips property writes', async () => {
    const hs = createFakeHubSpot(familyFixture(), { dropAssociations: true });
    const res = await linker.processCompany(work(1002), { client: hs, config: liveSandboxConfig() });
    expect(res).toMatchObject({ action: 'review', reason: 'VERIFICATION_FAILED', verification: { verified: false } });
    expect(hs.calls.batchUpdate).toHaveLength(0);
    expect(linker.buildReviewTicket(res).priority).toBe('high');
  });

  test('2-node circular reference is blocked even in live mode', async () => {
    const hs = createFakeHubSpot([
      company(1001, { domain: 'example.com', parent_company_domain: 'example.org' }),
      company(1002, { domain: 'example.org', hs_parent_company_id: '1001' }),
    ]);
    const res = await linker.processCompany(work(1001, ['parent_company_domain']), { client: hs, config: liveSandboxConfig() });
    expect(res).toMatchObject({ action: 'review', reason: 'CIRCULAR_REFERENCE' });
    expect(res.safety.cyclePath).toEqual(['1001', '1002', '1001']);
    expect(hs.calls.associate).toHaveLength(0);
    const ticket = linker.buildReviewTicket(res);
    expect(ticket).toMatchObject({ reason: 'CIRCULAR_REFERENCE', priority: 'high', proposedParentId: '1002', cyclePath: ['1001', '1002', '1001'] });
  });

  test('multi-hop circular reference is blocked', async () => {
    const hs = createFakeHubSpot([
      company(1001, { domain: 'example.com', duns_parent_id: '222222222' }),
      company(1002, { domain: 'example.org', duns_number: '222222222', hs_parent_company_id: '1003' }),
      company(1003, { domain: 'example.net', hs_parent_company_id: '1001' }),
    ]);
    const res = await linker.processCompany(work(1001), { client: hs, config: liveSandboxConfig() });
    expect(res.reason).toBe('CIRCULAR_REFERENCE');
    expect(res.safety.cycleLength).toBe(3);
  });

  test('self-parent routes to review', async () => {
    const hs = createFakeHubSpot([company(1001, { domain: 'example.com', parent_company_domain: 'example.com' })]);
    const res = await linker.processCompany(work(1001), { client: hs, config: liveSandboxConfig() });
    expect(res).toMatchObject({ action: 'review', reason: 'SELF_PARENT' });
  });

  test('ambiguous multi-parent match routes to review with candidates', async () => {
    const hs = createFakeHubSpot([
      company(1001, { domain: 'example.com' }),
      company(1003, { domain: 'example.com' }),
      company(1002, { domain: 'emea.example.com' }),
    ]);
    const res = await linker.processCompany(work(1002), { client: hs, config: dryConfig() });
    expect(res).toMatchObject({ action: 'review', reason: 'AMBIGUOUS_PARENT' });
    expect(linker.buildReviewTicket(res).candidates).toHaveLength(2);
  });

  test('existing different parent is a conflict, never an overwrite', async () => {
    const hs = createFakeHubSpot([
      company(1001, { domain: 'example.com' }),
      company(1004, { domain: 'example.net' }),
      company(1002, { domain: 'emea.example.com', hs_parent_company_id: '1004' }),
    ]);
    const res = await linker.processCompany(work(1002), { client: hs, config: liveSandboxConfig() });
    expect(res).toMatchObject({ action: 'review', reason: 'PARENT_CONFLICT', currentParentId: '1004', parentId: '1001' });
    expect(hs.calls.associate).toHaveLength(0);
  });

  test('depth limit routes to review', async () => {
    const list = [company(1001, { domain: 'example.com' })];
    for (let i = 1; i <= 5; i += 1) list.push(company(1001 + i, { domain: 'level' + i + '.example.org', hs_parent_company_id: String(1000 + i) }));
    list.push(company(1099, { domain: 'leaf.example.net', parent_company_domain: 'level5.example.org' }));
    const hs = createFakeHubSpot(list);
    const res = await linker.processCompany(work(1099), { client: hs, config: dryConfig() });
    expect(res).toMatchObject({ action: 'review', reason: 'DEPTH_EXCEEDED' });

    const relaxed = linker.loadConfig({ MAX_HIERARCHY_DEPTH: '8' });
    const res2 = await linker.processCompany(work(1099), { client: createFakeHubSpot(list), config: relaxed });
    expect(res2).toMatchObject({ action: 'link', hierarchyTier: 7 });
  });

  test('already-linked company refreshes rollups up to the ultimate parent', async () => {
    const hs = createFakeHubSpot([
      company(1001, { domain: 'example.com', annualrevenue: '1000' }),
      company(1002, { domain: 'emea.example.com', annualrevenue: '100', hs_parent_company_id: '1001' }),
      company(1003, { domain: 'de.emea.example.com', annualrevenue: '10', parent_company_domain: 'emea.example.com', hs_parent_company_id: '1002' }),
    ]);
    const res = await linker.processCompany(work(1003, ['annualrevenue']), { client: hs, config: liveSandboxConfig() });
    expect(res).toMatchObject({ action: 'rollup', reason: 'ALREADY_LINKED', ultimateParentId: '1001', hierarchyTier: 3 });
    expect(hs.db.get('1001').properties.rolled_up_family_arr).toBe('1110');
    expect(hs.db.get('1002').properties.rolled_up_family_arr).toBe('110');
    expect(hs.db.get('1003').properties.rolled_up_family_arr).toBeUndefined();
  });

  test('grandchild link updates parent and ultimate parent totals', async () => {
    const hs = createFakeHubSpot([
      company(1001, { domain: 'example.com', annualrevenue: '1000' }),
      company(1002, { domain: 'example.org', annualrevenue: '100', hs_parent_company_id: '1001' }),
      company(1003, { domain: 'example.net', annualrevenue: '10', apollo_parent_domain: 'example.org' }),
    ]);
    const res = await linker.processCompany(work(1003), { client: hs, config: dryConfig() });
    const ids = res.plannedWrites.propertyUpdates.map((u) => u.id).sort();
    expect(ids).toEqual(['1001', '1002', '1003']);
    expect(res.rollupSummary.totals['1001']).toMatchObject({ familyArr: 1110, childCount: 2 });
    expect(res.rollupSummary.totals['1002']).toMatchObject({ familyArr: 110, childCount: 1 });
  });

  test('attaching a company with its own subsidiaries re-tiers the whole subtree', async () => {
    const hs = createFakeHubSpot([
      company(1001, { domain: 'example.com', annualrevenue: '1000' }),
      company(1002, { domain: 'example.org', annualrevenue: '100', parent_company_domain: 'example.com' }),
      company(1003, { domain: 'example.net', annualrevenue: '10', hs_parent_company_id: '1002' }),
    ]);
    const res = await linker.processCompany(work(1002), { client: hs, config: dryConfig() });
    const byId = Object.fromEntries(res.plannedWrites.propertyUpdates.map((u) => [u.id, u.properties]));
    expect(byId['1003']).toMatchObject({ hierarchy_tier: '3', ultimate_parent_company_id: '1001' });
    expect(byId['1002']).toMatchObject({ hierarchy_tier: '2', rolled_up_family_arr: '110' });
    expect(byId['1001']).toMatchObject({ rolled_up_family_arr: '1110', rolled_up_child_count: '2' });
  });

  test('duplicate association rows do not double-count', async () => {
    const hs = createFakeHubSpot(familyFixture(), { duplicateChildLinks: true });
    const res = await linker.processCompany(work(1002), { client: hs, config: dryConfig() });
    expect(res.rollupSummary.totals['1001'].familyArr).toBe(1500000);
  });

  test('ARR change on a root company with children rolls up without linking', async () => {
    const hs = createFakeHubSpot(familyFixture());
    const res = await linker.processCompany(work(1001, ['annualrevenue']), { client: hs, config: dryConfig() });
    expect(res).toMatchObject({ action: 'rollup', reason: 'IN_HIERARCHY', ultimateParentId: '1001' });
    expect(res.plannedWrites.associations).toHaveLength(0);
  });

  test('stand-alone company with no signal is skipped', async () => {
    const hs = createFakeHubSpot([company(1005, { domain: 'example.org' })]);
    const res = await linker.processCompany(work(1005), { client: hs, config: dryConfig() });
    expect(res).toMatchObject({ action: 'skip', reason: 'NO_PARENT_SIGNAL' });
    expect(linker.buildReviewTicket(res)).toBeNull();
  });

  test('missing company is skipped', async () => {
    const res = await linker.processCompany(work(1404), { client: createFakeHubSpot([]), config: dryConfig() });
    expect(res).toMatchObject({ action: 'skip', reason: 'COMPANY_NOT_FOUND' });
  });

  test('audit payload carries decision context and no credentials', async () => {
    const hs = createFakeHubSpot(familyFixture());
    const res = await linker.processCompany(work(1002), { client: hs, config: dryConfig(), now: () => FIXED_NOW });
    const audit = linker.buildAuditPayload(res, { timestamp: FIXED_NOW.toISOString(), executionId: 'exec-1', triggers: ['domain'] });
    expect(audit).toMatchObject({ type: 'hubspot.company_hierarchy.audit', companyId: '1002', action: 'link', dryRun: true, parentId: '1001', triggers: ['domain'] });
    expect(JSON.stringify(audit)).not.toMatch(/Bearer|pat-/);
  });
});

describe('processBatch', () => {
  test('isolates per-company failures as classified error results', async () => {
    const hs = createFakeHubSpot(familyFixture());
    const flaky = Object.assign({}, hs, {
      async getCompany(id) {
        if (String(id) === '1003') throw new linker.HubSpotApiError('boom', { statusCode: 502 });
        return hs.getCompany(id);
      },
    });
    const results = await linker.processBatch([work(1002), work(1003)], { client: flaky, config: dryConfig() });
    expect(results.map((r) => r.action)).toEqual(['link', 'error']);
    expect(results[1].error).toMatchObject({ category: 'SERVER', retryable: true, statusCode: 502 });
  });

  test('re-throws authentication failures so the Error Trigger fires', async () => {
    const client = { getCompany: async () => { throw new linker.HubSpotApiError('unauthorized', { statusCode: 401 }); } };
    await expect(linker.processBatch([work(1002)], { client, config: dryConfig() })).rejects.toThrow('unauthorized');
  });
});

/* -------------------------------------------------------------------------- */
/* Error classification                                                       */
/* -------------------------------------------------------------------------- */

describe('classifyError', () => {
  test.each([
    [{ statusCode: 429 }, 'RATE_LIMIT', true],
    [{ httpCode: '401' }, 'AUTH', false],
    [{ status: 403 }, 'AUTH', false],
    [{ response: { status: 404 } }, 'NOT_FOUND', false],
    [{ statusCode: 409 }, 'CONFLICT', false],
    [{ statusCode: 400 }, 'VALIDATION', false],
    [{ statusCode: 503 }, 'SERVER', true],
    [{ code: 'ECONNRESET' }, 'NETWORK', true],
    [{ message: 'HubSpot private app token is not configured' }, 'CONFIG', false],
    [new Error('something odd'), 'UNKNOWN', false],
  ])('%p -> %s', (err, category, retryable) => {
    expect(linker.classifyError(err)).toMatchObject({ category, retryable });
  });

  test('redacts tokens from error messages', () => {
    const fakeToken = ['pat', 'na1', '00000000-0000-0000-0000-000000000000'].join('-');
    const out = linker.classifyError(new Error('failed with Bearer abc.def.ghi and ' + fakeToken + ' at /x?hapikey=zzz'));
    expect(out.message).not.toContain('abc.def.ghi');
    expect(out.message).not.toContain(fakeToken);
    expect(out.message).not.toContain('zzz');
  });

  test('buildErrorAlert converts an Error Trigger item', () => {
    const alert = linker.buildErrorAlert({
      execution: { id: '42', lastNodeExecuted: 'Resolve, Guard & Link Hierarchy', mode: 'webhook', error: { message: 'Too many requests', httpCode: '429' } },
      workflow: { id: 'wf-1', name: 'HubSpot Company Parent-Child Hierarchy Linker' },
    }, { timestamp: FIXED_NOW.toISOString() });
    expect(alert).toMatchObject({ type: 'hubspot.company_hierarchy.error', executionId: '42', classification: { category: 'RATE_LIMIT', retryable: true } });
  });
});

/* -------------------------------------------------------------------------- */
/* HubSpot client transport                                                   */
/* -------------------------------------------------------------------------- */

describe('createHubSpotClient', () => {
  const token = 'test-token-not-real';
  const ok = (body) => ({ statusCode: 200, body, headers: {} });

  test('refuses to start without a real token', () => {
    expect(() => linker.createHubSpotClient({ httpRequest: async () => ok({}), token: 'REPLACE_WITH_HUBSPOT_PRIVATE_APP_TOKEN' })).toThrow(/not configured/);
  });

  test('PUTs the child -> parent association with PRIMARY_PARENT type 14', async () => {
    const httpRequest = jest.fn(async () => ok({}));
    const client = linker.createHubSpotClient({ httpRequest, token });
    await client.associateParent('1002', '1001');
    const call = httpRequest.mock.calls[0][0];
    expect(call.method).toBe('PUT');
    expect(call.url).toBe('https://api.hubapi.com/crm/v4/objects/companies/1002/associations/companies/1001');
    expect(call.body).toEqual([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 14 }]);
    expect(call.headers.Authorization).toBe('Bearer ' + token);
  });

  test('lists children via CHILD type 13 with pagination, and verifies parent links', async () => {
    const pages = [
      ok({ results: [{ toObjectId: 1002, associationTypes: [{ typeId: 13 }] }, { toObjectId: 1009, associationTypes: [{ typeId: 14 }] }], paging: { next: { after: 'cursor-1' } } }),
      ok({ results: [{ toObjectId: 1003, associationTypes: [{ typeId: 13 }] }] }),
    ];
    const httpRequest = jest.fn(async () => pages.shift());
    const client = linker.createHubSpotClient({ httpRequest, token });
    expect(await client.getChildIds('1001')).toEqual(['1002', '1003']);
    expect(httpRequest.mock.calls[1][0].url).toContain('after=cursor-1');

    const client2 = linker.createHubSpotClient({ httpRequest: async () => ok({ results: [{ toObjectId: 1001, associationTypes: [{ typeId: 14 }] }] }), token });
    expect(await client2.verifyParentAssociation('1002', '1001')).toBe(true);
    expect(await client2.verifyParentAssociation('1002', '1005')).toBe(false);
  });

  test('retries 429 using Retry-After, then succeeds', async () => {
    const responses = [{ statusCode: 429, body: {}, headers: { 'retry-after': '2' } }, ok({ results: [] })];
    const sleep = jest.fn(async () => {});
    const client = linker.createHubSpotClient({ httpRequest: async () => responses.shift(), token, sleep });
    await client.findCompaniesByDomain('example.com');
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  test('throws a classified HubSpotApiError after retries are exhausted', async () => {
    const sleep = jest.fn(async () => {});
    const client = linker.createHubSpotClient({ httpRequest: async () => ({ statusCode: 500, body: { message: 'down' } }), token, sleep, maxRetries: 2 });
    await expect(client.findCompaniesByDuns('123456789')).rejects.toMatchObject({ name: 'HubSpotApiError', statusCode: 500 });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('getCompany returns null on 404 and caches records', async () => {
    const httpRequest = jest.fn(async () => ({ statusCode: 404, body: { message: 'not found' } }));
    const client = linker.createHubSpotClient({ httpRequest, token });
    expect(await client.getCompany('1404')).toBeNull();
    expect(await client.getCompany('1404')).toBeNull();
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  test('search sends an EQ filter and batch update chunks to 100', async () => {
    const httpRequest = jest.fn(async () => ok({ results: [] }));
    const client = linker.createHubSpotClient({ httpRequest, token });
    await client.findCompaniesByDomain('example.com');
    expect(httpRequest.mock.calls[0][0].body.filterGroups[0].filters[0]).toEqual({ propertyName: 'domain', operator: 'EQ', value: 'example.com' });
    const inputs = Array.from({ length: 150 }, (_, i) => ({ id: String(2000 + i), properties: { hierarchy_tier: '2' } }));
    await client.batchUpdateCompanies(inputs);
    const updates = httpRequest.mock.calls.filter((c) => c[0].url.endsWith('/batch/update'));
    expect(updates.map((c) => c[0].body.inputs.length)).toEqual([100, 50]);
  });

  test('createN8nHttpRequest asks n8n for the full response without throwing on status', async () => {
    const helpers = { httpRequest: jest.fn(async () => ({ statusCode: 204, body: '', headers: {} })) };
    const res = await linker.createN8nHttpRequest(helpers)({ method: 'GET', url: 'https://api.hubapi.com/x' });
    expect(helpers.httpRequest.mock.calls[0][0]).toMatchObject({ json: true, returnFullResponse: true, ignoreHttpStatusErrors: true });
    expect(res.statusCode).toBe(204);
  });
});

/* -------------------------------------------------------------------------- */
/* Signature verification                                                     */
/* -------------------------------------------------------------------------- */

describe('verifyHubSpotSignatureV3', () => {
  const now = 1767225600000;
  const body = JSON.stringify(FIXTURE.slice(0, 2));
  const sign = (overrides = {}) => {
    const ts = String(overrides.timestamp || now);
    const sig = signature.computeSignatureV3({ clientSecret: overrides.secret || TEST_SECRET, method: 'POST', uri: WEBHOOK_URL, rawBody: overrides.body || body, timestamp: ts });
    return { 'X-HubSpot-Signature-v3': sig, 'X-HubSpot-Request-Timestamp': ts };
  };
  const verify = (headers, extra = {}) =>
    signature.verifyHubSpotSignatureV3(Object.assign({ clientSecret: TEST_SECRET, method: 'POST', uri: WEBHOOK_URL, rawBody: body, headers, now }, extra));

  test('accepts a valid signature (header names are case-insensitive)', () => {
    const headers = sign();
    expect(verify(headers)).toMatchObject({ valid: true, reason: null });
    const lower = { 'x-hubspot-signature-v3': headers['X-HubSpot-Signature-v3'], 'x-hubspot-request-timestamp': headers['X-HubSpot-Request-Timestamp'] };
    expect(verify(lower).valid).toBe(true);
  });

  test('rejects a tampered body', () => {
    expect(verify(sign(), { rawBody: body.replace('1002', '1003') }).reason).toBe('SIGNATURE_MISMATCH');
  });

  test('rejects a signature made with another secret', () => {
    expect(verify(sign({ secret: 'some-other-secret' })).reason).toBe('SIGNATURE_MISMATCH');
  });

  test('enforces the replay window and future-skew limit', () => {
    const old = sign({ timestamp: now - 6 * 60 * 1000 });
    expect(verify(old).reason).toBe('TIMESTAMP_EXPIRED');
    expect(verify(old, { maxAgeMs: 10 * 60 * 1000 }).valid).toBe(true);
    expect(verify(sign({ timestamp: now + 5 * 60 * 1000 })).reason).toBe('TIMESTAMP_IN_FUTURE');
  });

  test('rejects missing headers, bad timestamps and placeholder secrets', () => {
    expect(verify({}).reason).toBe('MISSING_SIGNATURE');
    expect(verify({ 'X-HubSpot-Signature-v3': 'abc' }).reason).toBe('MISSING_TIMESTAMP');
    expect(verify({ 'X-HubSpot-Signature-v3': 'abc', 'X-HubSpot-Request-Timestamp': 'soon' }).reason).toBe('INVALID_TIMESTAMP');
    expect(verify(sign(), { clientSecret: 'REPLACE_WITH_HUBSPOT_APP_CLIENT_SECRET' }).reason).toBe('MISSING_SECRET');
  });

  test('decodes the URI characters HubSpot specifies before signing', () => {
    expect(signature.decodeHubSpotUri('https://your-n8n-webhook-domain.com/webhook/x%3Fa%3Db%2Cc%40d')).toBe('https://your-n8n-webhook-domain.com/webhook/x?a%3Db,c@d');
    const encoded = 'https://your-n8n-webhook-domain.com/webhook/hubspot%2Dcompany%3Ax';
    const ts = String(now);
    const sig = signature.computeSignatureV3({ clientSecret: TEST_SECRET, uri: 'https://your-n8n-webhook-domain.com/webhook/hubspot%2Dcompany:x', rawBody: body, timestamp: ts });
    expect(verify({ 'X-HubSpot-Signature-v3': sig, 'X-HubSpot-Request-Timestamp': ts }, { uri: encoded }).valid).toBe(true);
  });

  test('send-test-webhook produces requests the verifier accepts', () => {
    const req = buildSignedRequest({ url: WEBHOOK_URL, clientSecret: TEST_SECRET, portalId: PORTAL, events: FIXTURE, now });
    const res = signature.verifyHubSpotSignatureV3({ clientSecret: TEST_SECRET, method: 'POST', uri: req.url, rawBody: req.body, headers: req.headers, now });
    expect(res.valid).toBe(true);
    expect(JSON.parse(req.body).every((e) => e.portalId === Number(PORTAL))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Event filtering                                                            */
/* -------------------------------------------------------------------------- */

describe('filterWebhookBatch', () => {
  const cfg = { expectedPortalId: PORTAL, appId: APP_ID };

  test('filters the fixture batch and deduplicates per company', () => {
    const out = filter.filterWebhookBatch(FIXTURE, cfg);
    expect(out.companies.map((c) => c.companyId)).toEqual(['1002', '1003', '1004']);
    const c1002 = out.companies[0];
    expect(c1002).toMatchObject({ isCreation: true, propertyNames: ['domain'], eventIds: ['9000001', '9000002'] });
    expect(out.stats).toMatchObject({ received: 10, accepted: 3, rejected: 5, duplicatesCollapsed: 2 });
    const reasons = Object.fromEntries(out.rejected.map((r) => [String(r.objectId), r.reason]));
    expect(reasons).toEqual({
      1001: 'OWNED_PROPERTY',
      1005: 'SELF_ORIGINATED',
      1006: 'UNWATCHED_PROPERTY',
      1007: 'PORTAL_NOT_ALLOWED',
      1008: 'UNSUPPORTED_SUBSCRIPTION',
    });
  });

  test('fails closed when no portal allowlist is configured', () => {
    const out = filter.filterWebhookBatch(FIXTURE, { expectedPortalId: 'REPLACE_WITH_HUBSPOT_PORTAL_ID' });
    expect(out.companies).toHaveLength(0);
    expect(out.rejected.filter((r) => r.reason === 'PORTAL_ALLOWLIST_NOT_CONFIGURED').length).toBeGreaterThan(0);
  });

  test('self-origin detection accepts prefixed source IDs', () => {
    expect(filter.isSelfOriginated({ changeSource: 'INTEGRATION', sourceId: 'app-7654321' }, APP_ID)).toBe(true);
    expect(filter.isSelfOriginated({ changeSource: 'CRM_UI', sourceId: '7654321' }, APP_ID)).toBe(false);
    expect(filter.isSelfOriginated({ changeSource: 'INTEGRATION', sourceId: '1111111' }, APP_ID)).toBe(false);
  });

  test('respects custom watched properties and the batch size limit', () => {
    const out = filter.filterWebhookBatch(FIXTURE, Object.assign({}, cfg, { watchedProperties: 'annualrevenue', maxEventsPerBatch: 4 }));
    expect(out.companies.map((c) => c.companyId)).toEqual(['1002', '1004']);
    expect(out.rejected.filter((r) => r.reason === 'BATCH_LIMIT_EXCEEDED')).toHaveLength(6);
  });

  test('parses JSON strings and rejects malformed payloads', () => {
    expect(filter.filterWebhookBatch(JSON.stringify(FIXTURE), cfg).companies).toHaveLength(3);
    expect(() => filter.filterWebhookBatch('{"not":"an array"}', cfg)).toThrow(/array/);
    expect(filter.filterWebhookBatch([{ subscriptionType: 'company.creation' }], cfg).rejected[0].reason).toBe('MALFORMED_EVENT');
  });
});

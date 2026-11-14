'use strict';

/**
 * HubSpot company parent-child hierarchy linker and bottom-up ARR rollup engine.
 *
 * Pipeline for one company (see processCompany):
 *   1. Load the company record.
 *   2. Resolve parent candidates by deterministic priority tiers:
 *        Tier 1  explicit metadata: parent_company_domain, parent_domain, clearbit_parent_domain,
 *                apollo_parent_domain, duns_parent_id (fallback: ultimate_parent_domain)
 *        Tier 2  root domain vs. subdomain, then regional TLD variant of the same brand
 *      Free-mail and parked / shared-hosting domains are never used as a match signal.
 *   3. Guard the link: self-parenting, 2-node cycles, multi-hop cycles, pre-existing cycles,
 *      parent conflicts and MAX_HIERARCHY_DEPTH. Anything unsafe or ambiguous becomes `review`.
 *   4. Build a write plan: CRM v4 child -> parent association plus hierarchy metadata and
 *      rolled-up family totals for every company on the path from the ultimate parent down.
 *   5. Execute only when DRY_RUN=false and the SANDBOX_MODE gate allows it, then verify
 *      the association after writing.
 *
 * Zero runtime dependencies. Embedded verbatim into an n8n Code node by scripts/build-workflow.js.
 */

const VERSION = '1.0.0';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const ASSOCIATION_TYPES = Object.freeze({
  // HubSpot-defined company <-> company association type IDs.
  PRIMARY_PARENT: 14, // child company -> parent company
  CHILD: 13, // parent company -> child company
});

const ACTIONS = Object.freeze({
  LINK: 'link',
  ROLLUP: 'rollup',
  REVIEW: 'review',
  SKIP: 'skip',
  ERROR: 'error',
});

const REASONS = Object.freeze({
  COMPANY_NOT_FOUND: 'COMPANY_NOT_FOUND',
  NO_PARENT_SIGNAL: 'NO_PARENT_SIGNAL',
  EXPLICIT_PARENT_NOT_FOUND: 'EXPLICIT_PARENT_NOT_FOUND',
  EXCLUDED_DOMAIN: 'EXCLUDED_DOMAIN',
  SELF_PARENT: 'SELF_PARENT',
  CIRCULAR_REFERENCE: 'CIRCULAR_REFERENCE',
  EXISTING_CYCLE: 'EXISTING_CYCLE',
  DEPTH_EXCEEDED: 'DEPTH_EXCEEDED',
  AMBIGUOUS_PARENT: 'AMBIGUOUS_PARENT',
  PARENT_CONFLICT: 'PARENT_CONFLICT',
  ALREADY_LINKED: 'ALREADY_LINKED',
  IN_HIERARCHY: 'IN_HIERARCHY',
  NEW_LINK: 'NEW_LINK',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  FAMILY_TRUNCATED: 'FAMILY_TRUNCATED',
});

const DEFAULT_EXPLICIT_PARENT_SOURCES = Object.freeze([
  { property: 'parent_company_domain', type: 'domain', source: 'explicit_parent_domain' },
  { property: 'parent_domain', type: 'domain', source: 'explicit_parent_domain' },
  { property: 'clearbit_parent_domain', type: 'domain', source: 'clearbit' },
  { property: 'apollo_parent_domain', type: 'domain', source: 'apollo' },
  { property: 'duns_parent_id', type: 'duns', source: 'duns' },
]);

const DEFAULT_ULTIMATE_PARENT_SOURCES = Object.freeze([
  { property: 'ultimate_parent_domain', type: 'domain', source: 'ultimate_parent_domain' },
]);

const DEFAULT_FREE_MAIL_DOMAINS = Object.freeze([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'mail.com',
  'yandex.com', 'yandex.ru', 'zoho.com', 'qq.com', '163.com', '126.com', 'web.de',
  'fastmail.com', 'hey.com', 'tutanota.com', 'mail.ru', 'rediffmail.com',
]);

// Parked-domain services and shared-hosting / site-builder platforms. Subdomains of these
// belong to unrelated tenants, so they must never be rolled up to the platform's root domain.
const DEFAULT_PARKED_DOMAINS = Object.freeze([
  'sedoparking.com', 'parkingcrew.net', 'bodis.com', 'above.com', 'parklogic.com',
  'hugedomains.com', 'dan.com', 'afternic.com', 'godaddysites.com', 'wixsite.com',
  'squarespace.com', 'wordpress.com', 'blogspot.com', 'myshopify.com', 'webflow.io',
  'carrd.co', 'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app',
  'pages.dev', 'azurewebsites.net', 'cloudfront.net', 'firebaseapp.com', 'web.app',
  'notion.site', 'linktr.ee', 'hubspotpagebuilder.com', 'hs-sites.com',
]);

const MULTI_PART_SUFFIXES = Object.freeze([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr',
  'co.in', 'net.in', 'org.in', 'com.br', 'com.mx', 'com.sg', 'com.hk', 'com.cn', 'com.tw',
  'co.za', 'com.tr', 'com.ar', 'co.id', 'com.my', 'com.ph', 'com.vn', 'co.il', 'com.sa',
  'com.eg', 'com.pk', 'com.bd', 'com.ng', 'com.co', 'com.pe', 'com.ua', 'co.th',
]);

const DEFAULT_PROPERTY_NAMES = Object.freeze({
  domain: 'domain',
  website: 'website',
  parentCompanyId: 'hs_parent_company_id',
  dunsNumber: 'duns_number',
  annualRevenue: 'annualrevenue',
  openDealValue: 'hs_total_deal_value',
  closedWonValue: 'total_revenue',
  hierarchyTier: 'hierarchy_tier',
  ultimateParentId: 'ultimate_parent_company_id',
  lastSyncedAt: 'hierarchy_last_synced_at',
  rolledUpArr: 'rolled_up_family_arr',
  rolledUpChildCount: 'rolled_up_child_count',
  rolledUpDealValue: 'rolled_up_total_deal_value',
});

function parseBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseIntSafe(value, fallback, min) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return fallback;
  return n;
}

function parseCsv(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function isPlaceholder(value) {
  return typeof value === 'string' && /^REPLACE_WITH_/.test(value.trim());
}

function cleanEnvValue(value) {
  if (value === undefined || value === null) return '';
  const s = String(value).trim();
  return isPlaceholder(s) ? '' : s;
}

/**
 * Build a normalized config object from environment variables.
 * Safe defaults: DRY_RUN=true, SANDBOX_MODE=true, MAX_HIERARCHY_DEPTH=5.
 */
function loadConfig(env = {}) {
  const e = env || {};
  return {
    version: VERSION,
    dryRun: parseBool(e.DRY_RUN, true),
    sandboxMode: parseBool(e.SANDBOX_MODE, true),
    sandboxPortalId: cleanEnvValue(e.HUBSPOT_SANDBOX_PORTAL_ID).replace(/\D/g, ''),
    expectedPortalId: cleanEnvValue(e.EXPECTED_PORTAL_ID).replace(/\D/g, ''),
    appId: cleanEnvValue(e.HUBSPOT_APP_ID).replace(/\D/g, ''),
    maxDepth: parseIntSafe(e.MAX_HIERARCHY_DEPTH, 5, 1),
    maxFamilySize: parseIntSafe(e.MAX_FAMILY_SIZE, 500, 1),
    apiBaseUrl: cleanEnvValue(e.HUBSPOT_API_BASE_URL) || 'https://api.hubapi.com',
    maxRetries: parseIntSafe(e.HUBSPOT_MAX_RETRIES, 3, 0),
    associationTypes: {
      primaryParent: parseIntSafe(e.HUBSPOT_ASSOC_TYPE_PRIMARY_PARENT, ASSOCIATION_TYPES.PRIMARY_PARENT, 1),
      child: parseIntSafe(e.HUBSPOT_ASSOC_TYPE_CHILD, ASSOCIATION_TYPES.CHILD, 1),
    },
    enableSubdomainMatching: parseBool(e.ENABLE_SUBDOMAIN_MATCHING, true),
    enableRegionalMatching: parseBool(e.ENABLE_REGIONAL_MATCHING, true),
    regionalParentTlds: parseCsv(e.REGIONAL_PARENT_TLDS).length ? parseCsv(e.REGIONAL_PARENT_TLDS) : ['com'],
    rollupEnabled: parseBool(e.ROLLUP_ENABLED, true),
    freeMailDomains: DEFAULT_FREE_MAIL_DOMAINS.concat(parseCsv(e.EXTRA_FREE_MAIL_DOMAINS)),
    parkedDomains: DEFAULT_PARKED_DOMAINS.concat(parseCsv(e.EXTRA_PARKED_DOMAINS)),
    explicitParentSources: DEFAULT_EXPLICIT_PARENT_SOURCES.slice(),
    ultimateParentSources: DEFAULT_ULTIMATE_PARENT_SOURCES.slice(),
    properties: Object.assign({}, DEFAULT_PROPERTY_NAMES),
    auditLogEnabled: Boolean(cleanEnvValue(e.AUDIT_LOG_WEBHOOK_URL)),
    reviewQueueEnabled: Boolean(cleanEnvValue(e.REVIEW_QUEUE_WEBHOOK_URL)),
  };
}

/* -------------------------------------------------------------------------- */
/* Domain utilities                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a domain, URL or email address into a bare lowercase hostname.
 * Returns '' for anything that is not a plausible public hostname.
 */
function normalizeDomain(input) {
  if (input === undefined || input === null) return '';
  let s = String(input).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  s = s.replace(/:\d+$/, '');
  s = s.replace(/\.+$/, '');
  s = s.replace(/^www\d*\./, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,63}$/.test(s)) return '';
  return s;
}

function getPublicSuffix(domain) {
  const d = normalizeDomain(domain);
  if (!d) return '';
  const parts = d.split('.');
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_SUFFIXES.includes(lastTwo)) return lastTwo;
  }
  return parts[parts.length - 1];
}

/** Registrable root domain: emea.example.com -> example.com, shop.example.co.uk -> example.co.uk */
function getRootDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d) return '';
  const suffix = getPublicSuffix(d);
  const parts = d.split('.');
  const suffixParts = suffix.split('.').length;
  if (parts.length <= suffixParts) return '';
  return parts.slice(-(suffixParts + 1)).join('.');
}

/** Brand label of the root domain: example.co.uk -> example */
function getBrandLabel(domain) {
  const root = getRootDomain(domain);
  return root ? root.split('.')[0] : '';
}

function isSubdomain(domain) {
  const d = normalizeDomain(domain);
  return Boolean(d) && d !== getRootDomain(d);
}

function domainInList(domain, list) {
  const d = normalizeDomain(domain);
  if (!d) return false;
  const root = getRootDomain(d);
  return list.some((entry) => {
    const e = String(entry).toLowerCase();
    return d === e || root === e || d.endsWith('.' + e);
  });
}

function isFreeMailDomain(domain, config) {
  const list = (config && config.freeMailDomains) || DEFAULT_FREE_MAIL_DOMAINS;
  return domainInList(domain, list);
}

function isParkedDomain(domain, config) {
  const list = (config && config.parkedDomains) || DEFAULT_PARKED_DOMAINS;
  return domainInList(domain, list);
}

function isExcludedDomain(domain, config) {
  return isFreeMailDomain(domain, config) || isParkedDomain(domain, config);
}

/* -------------------------------------------------------------------------- */
/* Company helpers                                                            */
/* -------------------------------------------------------------------------- */

function getProp(company, name) {
  if (!company || !company.properties) return undefined;
  const v = company.properties[name];
  return v === null || v === undefined || String(v).trim() === '' ? undefined : v;
}

function getCompanyDomain(company, config) {
  const props = (config && config.properties) || DEFAULT_PROPERTY_NAMES;
  return normalizeDomain(getProp(company, props.domain)) || normalizeDomain(getProp(company, props.website));
}

function idOf(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\D/g, '');
}

/** Convert a HubSpot numeric property (string) into integer cents. Invalid or negative -> 0. */
function toCents(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function fromCents(cents) {
  return Math.round(cents) / 100;
}

function normalizeDuns(value) {
  const digits = idOf(value);
  return digits.length >= 8 && digits.length <= 9 ? digits.padStart(9, '0') : '';
}

/* -------------------------------------------------------------------------- */
/* Parent candidate resolution                                                */
/* -------------------------------------------------------------------------- */

async function lookupSource(sourceDef, rawValue, lookup, config) {
  if (sourceDef.type === 'duns') {
    const duns = normalizeDuns(rawValue);
    if (!duns) return { usable: false, matches: [] };
    const matches = (await lookup.findCompaniesByDuns(duns)) || [];
    return { usable: true, value: duns, matches };
  }
  const domain = normalizeDomain(rawValue);
  if (!domain || isExcludedDomain(domain, config)) return { usable: false, value: domain, excluded: Boolean(domain), matches: [] };
  const matches = (await lookup.findCompaniesByDomain(domain)) || [];
  return { usable: true, value: domain, matches };
}

function addCandidate(map, company, meta) {
  const id = idOf(company && company.id);
  if (!id) return;
  const existing = map.get(id);
  if (existing) {
    if (!existing.sources.includes(meta.source)) existing.sources.push(meta.source);
    if (!existing.matchedValues.includes(meta.value)) existing.matchedValues.push(meta.value);
    return;
  }
  map.set(id, { id, company, tier: meta.tier, sources: [meta.source], matchedValues: [meta.value] });
}

async function collectFromSources(sources, child, lookup, config, tier, trace) {
  const candidates = new Map();
  let anySignal = false;
  for (const sourceDef of sources) {
    const raw = getProp(child, sourceDef.property);
    if (raw === undefined) continue;
    const res = await lookupSource(sourceDef, raw, lookup, config);
    trace.push({ tier, source: sourceDef.source, property: sourceDef.property, value: res.value || null, usable: res.usable, excluded: Boolean(res.excluded), matches: res.matches.map((m) => idOf(m.id)) });
    if (!res.usable) continue;
    anySignal = true;
    res.matches.forEach((m) => addCandidate(candidates, m, { tier, source: sourceDef.source, value: res.value }));
  }
  return { anySignal, candidates };
}

/**
 * Resolve parent candidates for a company using deterministic priority tiers.
 *
 * @param {object} child  HubSpot company record { id, properties }
 * @param {object} lookup { findCompaniesByDomain(domain), findCompaniesByDuns(duns) } (async)
 * @param {object} config result of loadConfig()
 * @returns {Promise<{ status: 'match'|'ambiguous'|'self'|'none', tier: number|null, candidates: Array, selfMatches: Array, reason: string|null, trace: Array }>}
 */
async function resolveParentCandidates(child, lookup, config) {
  const cfg = config || loadConfig({});
  const childId = idOf(child && child.id);
  const trace = [];

  const finalize = (tier, map, reasonWhenNone) => {
    const all = Array.from(map.values());
    const selfMatches = all.filter((c) => c.id === childId);
    const candidates = all.filter((c) => c.id !== childId);
    if (candidates.length === 1) return { status: 'match', tier, candidates, selfMatches, reason: null, trace };
    if (candidates.length > 1) return { status: 'ambiguous', tier, candidates, selfMatches, reason: REASONS.AMBIGUOUS_PARENT, trace };
    if (selfMatches.length) return { status: 'self', tier, candidates, selfMatches, reason: REASONS.SELF_PARENT, trace };
    return { status: 'none', tier, candidates, selfMatches, reason: reasonWhenNone, trace };
  };

  // Tier 1a: explicit immediate-parent metadata (HubSpot, Clearbit, Apollo, DUNS)
  const immediate = await collectFromSources(cfg.explicitParentSources, child, lookup, cfg, 1, trace);
  if (immediate.candidates.size > 0) return finalize(1, immediate.candidates, null);

  // Tier 1b: ultimate-parent metadata, used only when no immediate parent matched
  const ultimate = await collectFromSources(cfg.ultimateParentSources, child, lookup, cfg, 1, trace);
  if (ultimate.candidates.size > 0) return finalize(1, ultimate.candidates, null);

  if (immediate.anySignal || ultimate.anySignal) {
    // Explicit metadata exists but names a company that is not in the CRM.
    // Never fall back to a domain heuristic that could contradict the explicit signal.
    return { status: 'none', tier: 1, candidates: [], selfMatches: [], reason: REASONS.EXPLICIT_PARENT_NOT_FOUND, trace };
  }

  // Tier 2: domain structure
  const childDomain = getCompanyDomain(child, cfg);
  if (!childDomain) return { status: 'none', tier: null, candidates: [], selfMatches: [], reason: REASONS.NO_PARENT_SIGNAL, trace };
  if (isExcludedDomain(childDomain, cfg)) {
    trace.push({ tier: 2, source: 'domain', value: childDomain, usable: false, excluded: true, matches: [] });
    return { status: 'none', tier: 2, candidates: [], selfMatches: [], reason: REASONS.EXCLUDED_DOMAIN, trace };
  }

  if (cfg.enableSubdomainMatching && isSubdomain(childDomain)) {
    const root = getRootDomain(childDomain);
    const matches = (await lookup.findCompaniesByDomain(root)) || [];
    trace.push({ tier: 2, source: 'root_domain', value: root, usable: true, excluded: false, matches: matches.map((m) => idOf(m.id)) });
    const map = new Map();
    matches.forEach((m) => addCandidate(map, m, { tier: 2, source: 'root_domain', value: root }));
    const result = finalize(2, map, REASONS.NO_PARENT_SIGNAL);
    if (result.status !== 'none') return result;
  }

  if (cfg.enableRegionalMatching) {
    const suffix = getPublicSuffix(childDomain);
    const brand = getBrandLabel(childDomain);
    if (brand && !cfg.regionalParentTlds.includes(suffix)) {
      const map = new Map();
      for (const tld of cfg.regionalParentTlds) {
        const target = brand + '.' + tld;
        if (isExcludedDomain(target, cfg)) continue;
        const matches = (await lookup.findCompaniesByDomain(target)) || [];
        trace.push({ tier: 2, source: 'regional_domain', value: target, usable: true, excluded: false, matches: matches.map((m) => idOf(m.id)) });
        matches.forEach((m) => addCandidate(map, m, { tier: 2, source: 'regional_domain', value: target }));
      }
      const result = finalize(2, map, REASONS.NO_PARENT_SIGNAL);
      if (result.status !== 'none') return result;
    }
  }

  return { status: 'none', tier: null, candidates: [], selfMatches: [], reason: REASONS.NO_PARENT_SIGNAL, trace };
}

/* -------------------------------------------------------------------------- */
/* Cycle and depth protection                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Walk upward along hs_parent_company_id from startId.
 * Returns the chain [startId, parent, grandparent, ...] up to the ultimate parent.
 * Stops on cycle detection or when more than maxDepth hops are needed.
 */
async function walkAncestors(startId, getParentId, maxDepth) {
  const start = idOf(startId);
  const chain = [start];
  const seen = new Set([start]);
  let current = start;
  for (let hop = 0; hop <= maxDepth; hop += 1) {
    const parent = idOf(await getParentId(current));
    if (!parent) return { chain, cycle: false, cycleAt: null, depthExceeded: false };
    if (seen.has(parent)) {
      chain.push(parent);
      return { chain, cycle: true, cycleAt: parent, depthExceeded: false };
    }
    if (hop === maxDepth) {
      return { chain, cycle: false, cycleAt: null, depthExceeded: true };
    }
    chain.push(parent);
    seen.add(parent);
    current = parent;
  }
  return { chain, cycle: false, cycleAt: null, depthExceeded: true };
}

/** Height of the subtree under rootId (0 = no children). Cycle-safe. */
function subtreeHeight(rootId, childrenById) {
  const root = idOf(rootId);
  let height = 0;
  const visited = new Set([root]);
  let frontier = [root];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const c of childrenById[id] || []) {
        if (visited.has(c)) continue;
        visited.add(c);
        next.push(c);
      }
    }
    if (next.length) height += 1;
    frontier = next;
  }
  return height;
}

/**
 * Decide whether linking childId under parentId is safe.
 *
 * @returns {Promise<{ ok: boolean, reason: string|null, chain: string[], cyclePath: string[]|null,
 *                     cycleLength: number|null, parentDepth: number|null, childDepth: number|null,
 *                     ultimateParentId: string|null }>}
 */
async function checkLinkSafety({ childId, parentId, getParentId, childSubtreeHeight = 0, maxDepth = 5 }) {
  const child = idOf(childId);
  const parent = idOf(parentId);
  const base = { chain: [], cyclePath: null, cycleLength: null, parentDepth: null, childDepth: null, ultimateParentId: null };

  if (!child || !parent || child === parent) {
    return Object.assign(base, { ok: false, reason: REASONS.SELF_PARENT, cyclePath: [child, child], cycleLength: 1 });
  }

  const walk = await walkAncestors(parent, getParentId, maxDepth);
  const idx = walk.chain.indexOf(child);
  if (idx !== -1) {
    // child is already an ancestor of the proposed parent: linking would close a loop.
    const cyclePath = [child].concat(walk.chain.slice(0, idx + 1));
    return Object.assign(base, { ok: false, reason: REASONS.CIRCULAR_REFERENCE, chain: walk.chain, cyclePath, cycleLength: idx + 1 });
  }
  if (walk.cycle) {
    const start = walk.chain.indexOf(walk.cycleAt);
    return Object.assign(base, { ok: false, reason: REASONS.EXISTING_CYCLE, chain: walk.chain, cyclePath: walk.chain.slice(start), cycleLength: walk.chain.length - 1 - start });
  }
  if (walk.depthExceeded) {
    return Object.assign(base, { ok: false, reason: REASONS.DEPTH_EXCEEDED, chain: walk.chain });
  }

  const parentDepth = walk.chain.length - 1; // edges from the ultimate parent
  const childDepth = parentDepth + 1;
  if (childDepth + Number(childSubtreeHeight || 0) > maxDepth) {
    return Object.assign(base, { ok: false, reason: REASONS.DEPTH_EXCEEDED, chain: walk.chain, parentDepth, childDepth });
  }

  return Object.assign(base, {
    ok: true,
    reason: null,
    chain: walk.chain,
    parentDepth,
    childDepth,
    ultimateParentId: walk.chain[walk.chain.length - 1],
  });
}

/* -------------------------------------------------------------------------- */
/* Family collection and bottom-up rollup                                     */
/* -------------------------------------------------------------------------- */

/**
 * Breadth-first collection of a company family from HubSpot.
 * @returns {Promise<{ companiesById: object, childrenById: object, truncated: boolean }>}
 */
async function collectFamily(rootId, client, { maxDepth = 5, maxFamilySize = 500, properties } = {}) {
  const root = idOf(rootId);
  const childrenById = {};
  const visited = new Set([root]);
  let frontier = [root];
  let truncated = false;

  for (let depth = 0; depth <= maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const id of frontier) {
      const kids = Array.from(new Set((await client.getChildIds(id)).map(idOf).filter(Boolean)));
      childrenById[id] = kids;
      for (const k of kids) {
        if (visited.has(k)) continue;
        if (visited.size >= maxFamilySize) {
          truncated = true;
          continue;
        }
        visited.add(k);
        next.push(k);
      }
    }
    if (depth === maxDepth && next.length) truncated = true;
    frontier = depth === maxDepth ? [] : next;
  }

  const companies = await client.getCompanies(Array.from(visited), properties);
  const companiesById = {};
  companies.forEach((c) => {
    companiesById[idOf(c.id)] = c;
  });
  return { companiesById, childrenById, truncated };
}

/**
 * Pure bottom-up rollup. Every company is counted exactly once, even when the
 * association data contains duplicates, diamonds (one child under two parents) or cycles.
 *
 * @returns {{ byId: object, order: string[], duplicatesIgnored: string[] }}
 *   byId[id] = { ownArr, familyArr, childCount, directChildCount, openDealValue, closedWonValue,
 *                totalDealValue, depth }  (currency values in major units)
 */
function computeFamilyRollup(rootId, companiesById, childrenById, options = {}) {
  const props = options.properties || DEFAULT_PROPERTY_NAMES;
  const maxDepth = options.maxDepth === undefined ? Infinity : options.maxDepth;
  const root = idOf(rootId);

  // 1. Build a spanning tree with a global visited set so each company has exactly one owner.
  const owner = {};
  const treeChildren = {};
  const depthOf = { [root]: 0 };
  const visited = new Set([root]);
  const duplicatesIgnored = [];
  const order = [root];
  let frontier = [root];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      treeChildren[id] = [];
      if (depthOf[id] >= maxDepth) continue;
      for (const raw of childrenById[id] || []) {
        const c = idOf(raw);
        if (!c) continue;
        if (visited.has(c)) {
          if (!duplicatesIgnored.includes(c)) duplicatesIgnored.push(c);
          continue;
        }
        visited.add(c);
        owner[c] = id;
        depthOf[c] = depthOf[id] + 1;
        treeChildren[id].push(c);
        order.push(c);
        next.push(c);
      }
    }
    frontier = next;
  }

  // 2. Aggregate in reverse BFS order (children before parents) using integer cents.
  const acc = {};
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i];
    const company = companiesById[id];
    const own = {
      arr: toCents(getProp(company, props.annualRevenue)),
      open: toCents(getProp(company, props.openDealValue)),
      won: toCents(getProp(company, props.closedWonValue)),
    };
    const node = { arr: own.arr, open: own.open, won: own.won, count: 0, ownArr: own.arr };
    for (const c of treeChildren[id]) {
      node.arr += acc[c].arr;
      node.open += acc[c].open;
      node.won += acc[c].won;
      node.count += acc[c].count + 1;
    }
    acc[id] = node;
  }

  const byId = {};
  for (const id of order) {
    const n = acc[id];
    byId[id] = {
      ownArr: fromCents(n.ownArr),
      familyArr: fromCents(n.arr),
      childCount: n.count,
      directChildCount: treeChildren[id].length,
      openDealValue: fromCents(n.open),
      closedWonValue: fromCents(n.won),
      totalDealValue: fromCents(n.open + n.won),
      depth: depthOf[id],
      parentId: owner[id] || null,
    };
  }
  return { byId, order, duplicatesIgnored };
}

function mergeFamilies(a, b) {
  const companiesById = Object.assign({}, a.companiesById, b.companiesById);
  const childrenById = {};
  const keys = new Set(Object.keys(a.childrenById).concat(Object.keys(b.childrenById)));
  keys.forEach((k) => {
    childrenById[k] = Array.from(new Set((a.childrenById[k] || []).concat(b.childrenById[k] || [])));
  });
  return { companiesById, childrenById, truncated: Boolean(a.truncated || b.truncated) };
}

function descendantsOf(rootId, childrenById) {
  const out = [];
  const visited = new Set([rootId]);
  let frontier = [rootId];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const c of childrenById[id] || []) {
        if (visited.has(c)) continue;
        visited.add(c);
        out.push(c);
        next.push(c);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Build hierarchy metadata + rollup property updates for a projected family tree.
 * Updates every company on the path ultimate parent -> focus, plus the focus subtree.
 */
function buildPropertyUpdates({ rootId, pathIds, focusId, family, rollup, config, syncedAt }) {
  const props = config.properties;
  const updates = new Map();
  const put = (id, values) => {
    const existing = updates.get(id) || {};
    updates.set(id, Object.assign(existing, values));
  };

  const metaTargets = new Set(pathIds.concat([focusId], descendantsOf(focusId, family.childrenById)));
  metaTargets.forEach((id) => {
    const r = rollup.byId[id];
    if (!r) return;
    put(id, {
      [props.hierarchyTier]: String(r.depth + 1),
      [props.ultimateParentId]: String(rootId),
      [props.lastSyncedAt]: syncedAt,
    });
  });

  if (config.rollupEnabled) {
    // Ancestors always receive rollups; the focus company only when it has subsidiaries itself.
    const rollupTargets = pathIds.filter((id) => id !== focusId);
    if (rollup.byId[focusId] && rollup.byId[focusId].childCount > 0) rollupTargets.push(focusId);
    rollupTargets.forEach((id) => {
      const r = rollup.byId[id];
      if (!r) return;
      put(id, {
        [props.rolledUpArr]: String(r.familyArr),
        [props.rolledUpChildCount]: String(r.childCount),
        [props.rolledUpDealValue]: String(r.totalDealValue),
        [props.lastSyncedAt]: syncedAt,
      });
    });
  }

  return Array.from(updates.entries()).map(([id, properties]) => ({ id, properties }));
}

/* -------------------------------------------------------------------------- */
/* HubSpot API client (transport injected)                                    */
/* -------------------------------------------------------------------------- */

class HubSpotApiError extends Error {
  constructor(message, { statusCode, method, path, body } = {}) {
    super(message);
    this.name = 'HubSpotApiError';
    this.statusCode = statusCode;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Adapter for n8n's `this.helpers.httpRequest`, returning { statusCode, body, headers }.
 */
function createN8nHttpRequest(helpers) {
  return async function httpRequest(options) {
    const res = await helpers.httpRequest(
      Object.assign({}, options, { json: true, returnFullResponse: true, ignoreHttpStatusErrors: true })
    );
    return { statusCode: res.statusCode, body: res.body, headers: res.headers || {} };
  };
}

/**
 * Create a minimal HubSpot CRM client.
 * @param {object} opts
 * @param {function} opts.httpRequest async ({ method, url, headers, body }) => { statusCode, body, headers }
 * @param {string}   opts.token       HubSpot private app token (read from the environment, never hard-coded)
 */
function createHubSpotClient({ httpRequest, token, baseUrl = 'https://api.hubapi.com', associationTypes, maxRetries = 3, sleep = defaultSleep, properties = DEFAULT_PROPERTY_NAMES }) {
  if (typeof httpRequest !== 'function') throw new Error('createHubSpotClient requires an httpRequest function');
  if (!token || isPlaceholder(token)) throw new HubSpotApiError('HubSpot private app token is not configured', { statusCode: 401 });
  const types = associationTypes || { primaryParent: ASSOCIATION_TYPES.PRIMARY_PARENT, child: ASSOCIATION_TYPES.CHILD };
  const companyCache = new Map();
  const readProps = Array.from(new Set(Object.values(properties).concat(
    DEFAULT_EXPLICIT_PARENT_SOURCES.map((s) => s.property),
    DEFAULT_ULTIMATE_PARENT_SOURCES.map((s) => s.property)
  )));

  async function request(method, path, body) {
    let attempt = 0;
    for (;;) {
      const res = await httpRequest({
        method,
        url: baseUrl.replace(/\/$/, '') + path,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      });
      const status = Number(res && res.statusCode);
      if (status >= 200 && status < 300) return res.body;
      if ((status === 429 || status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers && (res.headers['retry-after'] || res.headers['Retry-After']));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * Math.pow(2, attempt);
        attempt += 1;
        await sleep(waitMs);
        continue;
      }
      const message = (res && res.body && res.body.message) || 'HubSpot API request failed';
      throw new HubSpotApiError(message + ' (' + method + ' ' + path + ' -> ' + status + ')', { statusCode: status, method, path, body: res && res.body });
    }
  }

  async function getCompany(id) {
    const key = idOf(id);
    if (companyCache.has(key)) return companyCache.get(key);
    try {
      const body = await request('GET', '/crm/v3/objects/companies/' + key + '?properties=' + encodeURIComponent(readProps.join(',')));
      companyCache.set(key, body);
      return body;
    } catch (err) {
      if (err.statusCode === 404) {
        companyCache.set(key, null);
        return null;
      }
      throw err;
    }
  }

  async function getCompanies(ids) {
    const wanted = Array.from(new Set(ids.map(idOf).filter(Boolean)));
    const missing = wanted.filter((id) => !companyCache.has(id));
    for (const group of chunk(missing, 100)) {
      const body = await request('POST', '/crm/v3/objects/companies/batch/read', {
        inputs: group.map((id) => ({ id })),
        properties: readProps,
      });
      ((body && body.results) || []).forEach((c) => companyCache.set(idOf(c.id), c));
    }
    return wanted.map((id) => companyCache.get(id)).filter(Boolean);
  }

  async function searchCompanies(propertyName, value) {
    const body = await request('POST', '/crm/v3/objects/companies/search', {
      filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value: String(value) }] }],
      properties: readProps,
      limit: 10,
    });
    const results = (body && body.results) || [];
    results.forEach((c) => companyCache.set(idOf(c.id), c));
    return results;
  }

  async function listCompanyAssociations(id) {
    const out = [];
    let after;
    for (let page = 0; page < 50; page += 1) {
      const path = '/crm/v4/objects/companies/' + idOf(id) + '/associations/companies?limit=500' + (after ? '&after=' + encodeURIComponent(after) : '');
      const body = await request('GET', path);
      ((body && body.results) || []).forEach((r) => out.push(r));
      after = body && body.paging && body.paging.next && body.paging.next.after;
      if (!after) break;
    }
    return out;
  }

  function hasType(assoc, typeId) {
    return (assoc.associationTypes || []).some((t) => Number(t.typeId) === Number(typeId));
  }

  return {
    request,
    getCompany,
    getCompanies,
    searchCompanies,
    findCompaniesByDomain: (domain) => searchCompanies(properties.domain, domain),
    findCompaniesByDuns: (duns) => searchCompanies(properties.dunsNumber, duns),
    async getParentId(id) {
      const company = await getCompany(id);
      return idOf(getProp(company, properties.parentCompanyId));
    },
    async getChildIds(id) {
      const assocs = await listCompanyAssociations(id);
      return assocs.filter((a) => hasType(a, types.child)).map((a) => idOf(a.toObjectId));
    },
    async associateParent(childId, parentId) {
      return request('PUT', '/crm/v4/objects/companies/' + idOf(childId) + '/associations/companies/' + idOf(parentId), [
        { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: types.primaryParent },
      ]);
    },
    async verifyParentAssociation(childId, parentId) {
      const assocs = await listCompanyAssociations(childId);
      return assocs.some((a) => idOf(a.toObjectId) === idOf(parentId) && hasType(a, types.primaryParent));
    },
    async batchUpdateCompanies(inputs) {
      const results = [];
      for (const group of chunk(inputs, 100)) {
        const body = await request('POST', '/crm/v3/objects/companies/batch/update', { inputs: group });
        results.push(body);
        group.forEach((g) => companyCache.delete(idOf(g.id)));
      }
      return results;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Error classification                                                       */
/* -------------------------------------------------------------------------- */

const ERROR_CATEGORIES = Object.freeze({
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH: 'AUTH',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION: 'VALIDATION',
  SERVER: 'SERVER',
  NETWORK: 'NETWORK',
  CONFIG: 'CONFIG',
  UNKNOWN: 'UNKNOWN',
});

const NETWORK_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ECONNABORTED'];

/** Remove anything that looks like a credential from text before it is logged. */
function redactSecrets(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bpat-[a-z]{2}\d?-[A-Za-z0-9-]{8,}/gi, '[REDACTED_TOKEN]')
    .replace(/([?&](?:hapikey|access_token|token|api_key)=)[^&\s]+/gi, '$1[REDACTED]');
}

function classifyError(err) {
  const e = err || {};
  const status = Number(e.statusCode || e.httpCode || e.status || (e.response && (e.response.status || e.response.statusCode)) || 0);
  const code = String(e.code || (e.cause && e.cause.code) || '').toUpperCase();
  const message = redactSecrets(e.message || String(err || 'Unknown error')).slice(0, 500);
  const out = (category, retryable) => ({ category, retryable, statusCode: status || null, code: code || null, message });

  if (status === 429) return out(ERROR_CATEGORIES.RATE_LIMIT, true);
  if (status === 401 || status === 403) return out(ERROR_CATEGORIES.AUTH, false);
  if (status === 404) return out(ERROR_CATEGORIES.NOT_FOUND, false);
  if (status === 409) return out(ERROR_CATEGORIES.CONFLICT, false);
  if (status === 400 || status === 422) return out(ERROR_CATEGORIES.VALIDATION, false);
  if (status >= 500) return out(ERROR_CATEGORIES.SERVER, true);
  if (NETWORK_CODES.includes(code)) return out(ERROR_CATEGORIES.NETWORK, true);
  if (/not configured|missing (secret|token)|REPLACE_WITH_/i.test(message)) return out(ERROR_CATEGORIES.CONFIG, false);
  return out(ERROR_CATEGORIES.UNKNOWN, false);
}

/* -------------------------------------------------------------------------- */
/* Audit and review payloads                                                  */
/* -------------------------------------------------------------------------- */

function summarizeCandidates(candidates) {
  return (candidates || []).map((c) => ({
    companyId: c.id,
    domain: normalizeDomain(getProp(c.company, 'domain')) || null,
    tier: c.tier,
    sources: c.sources,
    matchedValues: c.matchedValues,
  }));
}

function buildAuditPayload(result, context = {}) {
  return {
    type: 'hubspot.company_hierarchy.audit',
    version: VERSION,
    timestamp: context.timestamp || new Date().toISOString(),
    executionId: context.executionId || null,
    portalId: result.portalId || null,
    companyId: result.companyId,
    action: result.action,
    reason: result.reason,
    dryRun: result.dryRun,
    dryRunReason: result.dryRunReason || null,
    parentId: result.parentId || null,
    ultimateParentId: result.ultimateParentId || null,
    hierarchyTier: result.hierarchyTier || null,
    match: result.match || null,
    safety: result.safety || null,
    plannedWrites: result.plannedWrites || null,
    executedWrites: result.executedWrites || null,
    verification: result.verification || null,
    rollupSummary: result.rollupSummary || null,
    triggers: context.triggers || null,
    error: result.error || null,
  };
}

function buildReviewTicket(result, context = {}) {
  if (result.action !== ACTIONS.REVIEW) return null;
  const titles = {
    [REASONS.SELF_PARENT]: 'Company resolves to itself as parent',
    [REASONS.CIRCULAR_REFERENCE]: 'Proposed parent link would create a circular hierarchy',
    [REASONS.EXISTING_CYCLE]: 'Existing parent chain already contains a cycle',
    [REASONS.DEPTH_EXCEEDED]: 'Hierarchy would exceed MAX_HIERARCHY_DEPTH',
    [REASONS.AMBIGUOUS_PARENT]: 'Multiple possible parent companies matched',
    [REASONS.PARENT_CONFLICT]: 'Company already has a different parent',
    [REASONS.VERIFICATION_FAILED]: 'Parent association could not be verified after writing',
  };
  return {
    type: 'hubspot.company_hierarchy.review',
    version: VERSION,
    timestamp: context.timestamp || new Date().toISOString(),
    priority: [REASONS.CIRCULAR_REFERENCE, REASONS.EXISTING_CYCLE, REASONS.VERIFICATION_FAILED].includes(result.reason) ? 'high' : 'normal',
    title: titles[result.reason] || 'Company hierarchy needs human review',
    reason: result.reason,
    portalId: result.portalId || null,
    companyId: result.companyId,
    currentParentId: result.currentParentId || null,
    proposedParentId: result.parentId || null,
    candidates: (result.match && result.match.candidates) || [],
    cyclePath: (result.safety && result.safety.cyclePath) || null,
    suggestedResolution:
      result.reason === REASONS.AMBIGUOUS_PARENT
        ? 'Set parent_company_domain or duns_parent_id on the child to a single parent, or merge duplicate parent records.'
        : 'Inspect the parent chain in HubSpot and correct the Parent company association manually.',
  };
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

function resolveExecutionMode(config, portalId) {
  if (config.dryRun) return { dryRun: true, dryRunReason: 'DRY_RUN_ENABLED' };
  if (config.sandboxMode) {
    if (!config.sandboxPortalId) return { dryRun: true, dryRunReason: 'SANDBOX_PORTAL_NOT_CONFIGURED' };
    if (idOf(portalId) !== config.sandboxPortalId) return { dryRun: true, dryRunReason: 'PORTAL_IS_NOT_SANDBOX' };
  }
  return { dryRun: false, dryRunReason: null };
}

/**
 * Process one deduplicated company work item from event-filter.js.
 *
 * @param {object} work   { companyId, portalId, propertyNames, isCreation }
 * @param {object} deps   { client, config, now?: () => Date }
 */
async function processCompany(work, deps) {
  const { client } = deps;
  const config = deps.config || loadConfig({});
  const now = deps.now ? deps.now() : new Date();
  const syncedAt = now.toISOString();
  const companyId = idOf(work.companyId);
  const portalId = idOf(work.portalId);
  const mode = resolveExecutionMode(config, portalId);
  const props = config.properties;

  const result = {
    companyId,
    portalId,
    action: ACTIONS.SKIP,
    reason: null,
    dryRun: mode.dryRun,
    dryRunReason: mode.dryRunReason,
    currentParentId: null,
    parentId: null,
    ultimateParentId: null,
    hierarchyTier: null,
    match: null,
    safety: null,
    plannedWrites: { associations: [], propertyUpdates: [] },
    executedWrites: null,
    verification: null,
    rollupSummary: null,
  };

  const child = await client.getCompany(companyId);
  if (!child) {
    result.reason = REASONS.COMPANY_NOT_FOUND;
    return result;
  }

  const currentParentId = idOf(getProp(child, props.parentCompanyId));
  result.currentParentId = currentParentId || null;

  const resolution = await resolveParentCandidates(child, client, config);
  result.match = {
    status: resolution.status,
    tier: resolution.tier,
    candidates: summarizeCandidates(resolution.candidates),
    trace: resolution.trace,
  };

  // ---- Decide -------------------------------------------------------------
  let focusParentId = null; // parent to attach (link) or existing parent (rollup)
  let linking = false;

  if (resolution.status === 'self') {
    result.action = ACTIONS.REVIEW;
    result.reason = REASONS.SELF_PARENT;
    result.safety = { ok: false, reason: REASONS.SELF_PARENT, cyclePath: [companyId, companyId], cycleLength: 1 };
    return result;
  }
  if (resolution.status === 'ambiguous') {
    result.action = ACTIONS.REVIEW;
    result.reason = REASONS.AMBIGUOUS_PARENT;
    return result;
  }

  if (resolution.status === 'match') {
    const proposed = resolution.candidates[0].id;
    result.parentId = proposed;
    if (currentParentId && currentParentId === proposed) {
      focusParentId = proposed;
      result.reason = REASONS.ALREADY_LINKED;
    } else if (currentParentId && currentParentId !== proposed) {
      result.action = ACTIONS.REVIEW;
      result.reason = REASONS.PARENT_CONFLICT;
      return result;
    } else {
      linking = true;
      focusParentId = proposed;
    }
  } else if (currentParentId) {
    focusParentId = currentParentId;
    result.parentId = currentParentId;
    result.reason = REASONS.IN_HIERARCHY;
  }

  // ---- Guard --------------------------------------------------------------
  const childFamily = await collectFamily(companyId, client, { maxDepth: config.maxDepth, maxFamilySize: config.maxFamilySize });
  const childHeight = subtreeHeight(companyId, childFamily.childrenById);

  let rootId = companyId;
  let pathIds = [companyId];

  if (focusParentId) {
    if (linking) {
      const safety = await checkLinkSafety({
        childId: companyId,
        parentId: focusParentId,
        getParentId: (id) => client.getParentId(id),
        childSubtreeHeight: childHeight,
        maxDepth: config.maxDepth,
      });
      result.safety = safety;
      if (!safety.ok) {
        result.action = ACTIONS.REVIEW;
        result.reason = safety.reason;
        return result;
      }
      rootId = safety.ultimateParentId;
      pathIds = safety.chain.slice().reverse().concat([companyId]);
    } else {
      const walk = await walkAncestors(companyId, (id) => client.getParentId(id), config.maxDepth);
      if (walk.cycle || walk.depthExceeded) {
        const reason = walk.cycle ? REASONS.EXISTING_CYCLE : REASONS.DEPTH_EXCEEDED;
        result.safety = { ok: false, reason, chain: walk.chain, cyclePath: walk.cycle ? walk.chain.slice(walk.chain.indexOf(walk.cycleAt)) : null };
        result.action = ACTIONS.REVIEW;
        result.reason = reason;
        return result;
      }
      result.safety = { ok: true, reason: null, chain: walk.chain };
      rootId = walk.chain[walk.chain.length - 1];
      pathIds = walk.chain.slice().reverse();
    }
  } else if (childHeight === 0) {
    // Not a child, not a parent: nothing to link or roll up.
    result.reason = resolution.reason || REASONS.NO_PARENT_SIGNAL;
    return result;
  } else {
    result.reason = REASONS.IN_HIERARCHY;
  }

  // ---- Project the family tree and compute rollups ------------------------
  let family = childFamily;
  if (rootId !== companyId) {
    const rootFamily = await collectFamily(rootId, client, { maxDepth: config.maxDepth, maxFamilySize: config.maxFamilySize });
    family = mergeFamilies(rootFamily, childFamily);
  }
  if (linking) {
    const kids = family.childrenById[focusParentId] || [];
    if (!kids.includes(companyId)) family.childrenById[focusParentId] = kids.concat([companyId]);
    const missing = [companyId, focusParentId].filter((id) => !family.companiesById[id]);
    if (missing.length) (await client.getCompanies(missing)).forEach((c) => (family.companiesById[idOf(c.id)] = c));
  }

  const rollup = computeFamilyRollup(rootId, family.companiesById, family.childrenById, { maxDepth: config.maxDepth, properties: props });
  const effectiveConfig = family.truncated ? Object.assign({}, config, { rollupEnabled: false }) : config;
  const propertyUpdates = buildPropertyUpdates({ rootId, pathIds, focusId: companyId, family, rollup, config: effectiveConfig, syncedAt });

  result.action = linking ? ACTIONS.LINK : ACTIONS.ROLLUP;
  if (linking) result.reason = REASONS.NEW_LINK;
  result.ultimateParentId = rootId;
  result.hierarchyTier = rollup.byId[companyId] ? rollup.byId[companyId].depth + 1 : null;
  result.plannedWrites = {
    associations: linking
      ? [{
          method: 'PUT',
          path: '/crm/v4/objects/companies/' + companyId + '/associations/companies/' + focusParentId,
          associationCategory: 'HUBSPOT_DEFINED',
          associationTypeId: config.associationTypes.primaryParent,
          fromCompanyId: companyId,
          toCompanyId: focusParentId,
        }]
      : [],
    propertyUpdates,
  };
  result.rollupSummary = {
    rootId,
    pathIds,
    familySize: rollup.order.length,
    duplicatesIgnored: rollup.duplicatesIgnored,
    truncated: family.truncated,
    rollupSkippedReason: family.truncated ? REASONS.FAMILY_TRUNCATED : null,
    totals: pathIds.reduce((acc, id) => {
      if (rollup.byId[id]) acc[id] = rollup.byId[id];
      return acc;
    }, {}),
  };

  if (mode.dryRun) return result;

  // ---- Execute (live) ------------------------------------------------------
  const executed = { associations: 0, propertyUpdates: 0 };
  if (linking) {
    await client.associateParent(companyId, focusParentId);
    executed.associations = 1;
    const verified = await client.verifyParentAssociation(companyId, focusParentId);
    result.verification = { checked: true, verified };
    if (!verified) {
      result.action = ACTIONS.REVIEW;
      result.reason = REASONS.VERIFICATION_FAILED;
      result.executedWrites = executed;
      return result;
    }
  }
  if (propertyUpdates.length) {
    await client.batchUpdateCompanies(propertyUpdates);
    executed.propertyUpdates = propertyUpdates.length;
  }
  result.executedWrites = executed;
  return result;
}

/**
 * Process every work item. Per-company failures become `error` results so one bad
 * record never blocks the batch; authentication and configuration failures are
 * re-thrown so the n8n Error Trigger fires.
 */
async function processBatch(workItems, deps) {
  const results = [];
  for (const work of workItems) {
    try {
      results.push(await processCompany(work, deps));
    } catch (err) {
      const classification = classifyError(err);
      if (classification.category === ERROR_CATEGORIES.AUTH || classification.category === ERROR_CATEGORIES.CONFIG) throw err;
      results.push({
        companyId: idOf(work.companyId),
        portalId: idOf(work.portalId),
        action: ACTIONS.ERROR,
        reason: classification.category,
        dryRun: resolveExecutionMode(deps.config || loadConfig({}), work.portalId).dryRun,
        error: classification,
      });
    }
  }
  return results;
}

/**
 * Convert an n8n Error Trigger item into a redacted alert payload.
 */
function buildErrorAlert(errorItem = {}, context = {}) {
  const execution = errorItem.execution || {};
  const workflow = errorItem.workflow || {};
  const err = execution.error || errorItem.error || {};
  const classification = classifyError(err);
  return {
    type: 'hubspot.company_hierarchy.error',
    version: VERSION,
    timestamp: context.timestamp || new Date().toISOString(),
    workflowId: workflow.id || null,
    workflowName: workflow.name || null,
    executionId: execution.id || null,
    lastNodeExecuted: execution.lastNodeExecuted || null,
    mode: execution.mode || null,
    classification,
  };
}

module.exports = {
  VERSION,
  ASSOCIATION_TYPES,
  ACTIONS,
  REASONS,
  ERROR_CATEGORIES,
  DEFAULT_FREE_MAIL_DOMAINS,
  DEFAULT_PARKED_DOMAINS,
  DEFAULT_PROPERTY_NAMES,
  parseBool,
  loadConfig,
  normalizeDomain,
  getPublicSuffix,
  getRootDomain,
  getBrandLabel,
  isSubdomain,
  isFreeMailDomain,
  isParkedDomain,
  isExcludedDomain,
  getCompanyDomain,
  normalizeDuns,
  toCents,
  resolveParentCandidates,
  walkAncestors,
  subtreeHeight,
  checkLinkSafety,
  collectFamily,
  computeFamilyRollup,
  buildPropertyUpdates,
  HubSpotApiError,
  createN8nHttpRequest,
  createHubSpotClient,
  redactSecrets,
  classifyError,
  buildAuditPayload,
  buildReviewTicket,
  resolveExecutionMode,
  processCompany,
  processBatch,
  buildErrorAlert,
};

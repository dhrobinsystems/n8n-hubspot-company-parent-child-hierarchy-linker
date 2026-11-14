'use strict';

/**
 * HubSpot v3 webhook batch filtering.
 *
 * Responsibilities:
 *   - Parse a webhook batch (array of events, or a JSON string of one)
 *   - Keep only company.creation and company.propertyChange events
 *   - Keep only propertyChange events on watched properties
 *   - Enforce the portal allowlist (EXPECTED_PORTAL_ID)
 *   - Drop self-originated changes (HUBSPOT_APP_ID) to prevent webhook loops
 *   - Drop changes to the properties this workflow writes itself
 *   - Deduplicate per company so one batch produces one unit of work per company
 *
 * Zero runtime dependencies. Embedded verbatim into an n8n Code node by scripts/build-workflow.js.
 */

const SUPPORTED_SUBSCRIPTION_TYPES = Object.freeze(['company.creation', 'company.propertyChange']);

const DEFAULT_WATCHED_PROPERTIES = Object.freeze([
  'domain',
  'website',
  'parent_company_domain',
  'duns_number',
  'annualrevenue',
  'hs_parent_company_id',
]);

// Properties written by this workflow. A change to any of these is never a trigger.
const OWNED_PROPERTIES = Object.freeze([
  'hierarchy_tier',
  'ultimate_parent_company_id',
  'hierarchy_last_synced_at',
  'rolled_up_family_arr',
  'rolled_up_child_count',
  'rolled_up_total_deal_value',
]);

const REJECTION_REASONS = Object.freeze({
  MALFORMED_EVENT: 'MALFORMED_EVENT',
  UNSUPPORTED_SUBSCRIPTION: 'UNSUPPORTED_SUBSCRIPTION',
  PORTAL_NOT_ALLOWED: 'PORTAL_NOT_ALLOWED',
  UNWATCHED_PROPERTY: 'UNWATCHED_PROPERTY',
  OWNED_PROPERTY: 'OWNED_PROPERTY',
  SELF_ORIGINATED: 'SELF_ORIGINATED',
  BATCH_LIMIT_EXCEEDED: 'BATCH_LIMIT_EXCEEDED',
  PORTAL_ALLOWLIST_NOT_CONFIGURED: 'PORTAL_ALLOWLIST_NOT_CONFIGURED',
});

function parseList(value, fallback) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return fallback ? fallback.slice() : [];
}

function parseBatch(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) throw new Error('Webhook payload must be a JSON array of events');
    return parsed;
  }
  if (input && typeof input === 'object') return [input];
  throw new Error('Webhook payload must be a JSON array of events');
}

function digitsOnly(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\D/g, '');
}

/**
 * True when a change was made by this integration's own app (loop prevention).
 * HubSpot reports integration-originated changes with changeSource INTEGRATION / API
 * and a sourceId that carries the app ID (formats vary, e.g. "1234567" or "app-1234567").
 */
function isSelfOriginated(event, appId) {
  const normalizedAppId = digitsOnly(appId);
  if (!normalizedAppId) return false;
  const source = String(event.changeSource || '').toUpperCase();
  const fromIntegration = source === 'INTEGRATION' || source === 'API' || source === 'APP';
  if (!fromIntegration) return false;
  return digitsOnly(event.sourceId) === normalizedAppId;
}

function normalizeFilterConfig(config = {}) {
  return {
    expectedPortalId: config.expectedPortalId ? digitsOnly(config.expectedPortalId) : '',
    appId: config.appId ? digitsOnly(config.appId) : '',
    watchedProperties: parseList(config.watchedProperties, DEFAULT_WATCHED_PROPERTIES),
    ownedProperties: parseList(config.ownedProperties, OWNED_PROPERTIES),
    maxEventsPerBatch: Number(config.maxEventsPerBatch) > 0 ? Number(config.maxEventsPerBatch) : 100,
    // Fail closed: without an allowlisted portal ID, no event is processed.
    requirePortalAllowlist: config.requirePortalAllowlist !== false,
  };
}

/**
 * Classify a single event. Returns null when the event should be processed,
 * or a rejection reason string when it should be dropped.
 */
function classifyEvent(event, cfg) {
  if (!event || typeof event !== 'object') return REJECTION_REASONS.MALFORMED_EVENT;
  if (event.objectId === undefined || event.objectId === null || digitsOnly(event.objectId) === '') {
    return REJECTION_REASONS.MALFORMED_EVENT;
  }
  if (!SUPPORTED_SUBSCRIPTION_TYPES.includes(event.subscriptionType)) {
    return REJECTION_REASONS.UNSUPPORTED_SUBSCRIPTION;
  }
  if (!cfg.expectedPortalId && cfg.requirePortalAllowlist) {
    return REJECTION_REASONS.PORTAL_ALLOWLIST_NOT_CONFIGURED;
  }
  if (cfg.expectedPortalId && digitsOnly(event.portalId) !== cfg.expectedPortalId) {
    return REJECTION_REASONS.PORTAL_NOT_ALLOWED;
  }
  if (event.subscriptionType === 'company.propertyChange') {
    const prop = String(event.propertyName || '');
    if (cfg.ownedProperties.includes(prop)) return REJECTION_REASONS.OWNED_PROPERTY;
    if (!cfg.watchedProperties.includes(prop)) return REJECTION_REASONS.UNWATCHED_PROPERTY;
  }
  if (isSelfOriginated(event, cfg.appId)) return REJECTION_REASONS.SELF_ORIGINATED;
  return null;
}

/**
 * Filter and deduplicate a HubSpot webhook batch.
 *
 * @param {Array|string|object} batch
 * @param {object} config { expectedPortalId, appId, watchedProperties, ownedProperties, maxEventsPerBatch, requirePortalAllowlist }
 * @returns {{ companies: Array, rejected: Array, stats: object }}
 */
function filterWebhookBatch(batch, config = {}) {
  const cfg = normalizeFilterConfig(config);
  const events = parseBatch(batch);
  const rejected = [];
  const byCompany = new Map();
  const seenEventIds = new Set();
  let duplicateEvents = 0;

  events.forEach((event, index) => {
    if (index >= cfg.maxEventsPerBatch) {
      rejected.push({ eventId: event && event.eventId, objectId: event && event.objectId, reason: REJECTION_REASONS.BATCH_LIMIT_EXCEEDED });
      return;
    }

    const reason = classifyEvent(event, cfg);
    if (reason) {
      rejected.push({ eventId: event && event.eventId, objectId: event && event.objectId, reason });
      return;
    }

    if (event.eventId !== undefined && event.eventId !== null) {
      const key = String(event.eventId);
      if (seenEventIds.has(key)) {
        duplicateEvents += 1;
        return;
      }
      seenEventIds.add(key);
    }

    const companyId = digitsOnly(event.objectId);
    const occurredAt = Number(event.occurredAt) || 0;
    let entry = byCompany.get(companyId);
    if (!entry) {
      entry = {
        companyId,
        portalId: digitsOnly(event.portalId),
        subscriptionTypes: [],
        propertyNames: [],
        eventIds: [],
        isCreation: false,
        latestOccurredAt: 0,
        maxAttemptNumber: 0,
      };
      byCompany.set(companyId, entry);
    } else {
      duplicateEvents += 1;
    }

    if (!entry.subscriptionTypes.includes(event.subscriptionType)) entry.subscriptionTypes.push(event.subscriptionType);
    if (event.subscriptionType === 'company.creation') entry.isCreation = true;
    if (event.propertyName && !entry.propertyNames.includes(event.propertyName)) entry.propertyNames.push(event.propertyName);
    if (event.eventId !== undefined && event.eventId !== null) entry.eventIds.push(String(event.eventId));
    if (occurredAt > entry.latestOccurredAt) entry.latestOccurredAt = occurredAt;
    const attempt = Number(event.attemptNumber) || 0;
    if (attempt > entry.maxAttemptNumber) entry.maxAttemptNumber = attempt;
  });

  const companies = Array.from(byCompany.values()).sort((a, b) => a.latestOccurredAt - b.latestOccurredAt);
  companies.forEach((c) => c.propertyNames.sort());

  return {
    companies,
    rejected,
    stats: {
      received: events.length,
      accepted: companies.length,
      rejected: rejected.length,
      duplicatesCollapsed: duplicateEvents,
    },
  };
}

module.exports = {
  SUPPORTED_SUBSCRIPTION_TYPES,
  DEFAULT_WATCHED_PROPERTIES,
  OWNED_PROPERTIES,
  REJECTION_REASONS,
  parseList,
  parseBatch,
  digitsOnly,
  isSelfOriginated,
  normalizeFilterConfig,
  classifyEvent,
  filterWebhookBatch,
};

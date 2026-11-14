'use strict';

/**
 * HubSpot webhook signature verification (X-HubSpot-Signature-v3).
 *
 * v3 signature = base64( HMAC-SHA256( clientSecret, method + uri + rawBody + timestamp ) )
 *
 * Guards implemented here:
 *   - HMAC-SHA256 v3 signature check with constant-time comparison
 *   - Replay window check on X-HubSpot-Request-Timestamp (SIGNATURE_MAX_AGE_MS)
 *   - Rejection of timestamps from the future beyond a small clock-skew allowance
 *
 * Zero runtime dependencies beyond Node's built-in `crypto`.
 * This file is embedded verbatim into an n8n Code node by scripts/build-workflow.js.
 */

const crypto = require('crypto');

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_FUTURE_SKEW_MS = 60 * 1000;

// HubSpot asks integrators to decode these specific URL-encoded characters
// in the request URI before computing the v3 signature.
const URI_DECODE_MAP = {
  '%3A': ':',
  '%2F': '/',
  '%3F': '?',
  '%40': '@',
  '%21': '!',
  '%24': '$',
  '%27': "'",
  '%28': '(',
  '%29': ')',
  '%2A': '*',
  '%2C': ',',
  '%3B': ';',
};

const SIGNATURE_ERRORS = Object.freeze({
  MISSING_SECRET: 'MISSING_SECRET',
  MISSING_SIGNATURE: 'MISSING_SIGNATURE',
  MISSING_TIMESTAMP: 'MISSING_TIMESTAMP',
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP',
  TIMESTAMP_EXPIRED: 'TIMESTAMP_EXPIRED',
  TIMESTAMP_IN_FUTURE: 'TIMESTAMP_IN_FUTURE',
  SIGNATURE_MISMATCH: 'SIGNATURE_MISMATCH',
});

function decodeHubSpotUri(uri) {
  return String(uri || '').replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (match) => {
    return URI_DECODE_MAP[match.toUpperCase()] || match;
  });
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const target = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function computeSignatureV3({ clientSecret, method, uri, rawBody, timestamp }) {
  const source =
    String(method || 'POST').toUpperCase() +
    decodeHubSpotUri(uri) +
    (rawBody === undefined || rawBody === null ? '' : String(rawBody)) +
    String(timestamp);
  return crypto.createHmac('sha256', String(clientSecret)).update(source, 'utf8').digest('base64');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length so timing does not leak the length check.
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a HubSpot v3 webhook request.
 *
 * @param {object} params
 * @param {string} params.clientSecret  HubSpot app client secret
 * @param {string} params.method        HTTP method (POST)
 * @param {string} params.uri           Full request URI as HubSpot called it (e.g. https://your-n8n-webhook-domain.com/webhook/path?query)
 * @param {string} params.rawBody       Raw, unparsed request body
 * @param {object} params.headers       Request headers
 * @param {number} [params.now]         Current epoch ms (injectable for tests)
 * @param {number} [params.maxAgeMs]    Replay window (SIGNATURE_MAX_AGE_MS)
 * @param {number} [params.futureSkewMs] Allowed clock skew for future timestamps
 * @returns {{ valid: boolean, reason: string|null, timestamp: number|null, ageMs: number|null }}
 */
function verifyHubSpotSignatureV3(params) {
  const {
    clientSecret,
    method = 'POST',
    uri,
    rawBody,
    headers,
    now = Date.now(),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    futureSkewMs = DEFAULT_FUTURE_SKEW_MS,
  } = params || {};

  const fail = (reason, timestamp = null, ageMs = null) => ({ valid: false, reason, timestamp, ageMs });

  if (!clientSecret || /^REPLACE_WITH_/.test(String(clientSecret))) {
    return fail(SIGNATURE_ERRORS.MISSING_SECRET);
  }

  const signature = getHeader(headers, 'x-hubspot-signature-v3');
  if (!signature) return fail(SIGNATURE_ERRORS.MISSING_SIGNATURE);

  const timestampHeader = getHeader(headers, 'x-hubspot-request-timestamp');
  if (timestampHeader === undefined || timestampHeader === null || timestampHeader === '') {
    return fail(SIGNATURE_ERRORS.MISSING_TIMESTAMP);
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return fail(SIGNATURE_ERRORS.INVALID_TIMESTAMP);
  }

  const ageMs = Number(now) - timestamp;
  if (ageMs > Number(maxAgeMs)) return fail(SIGNATURE_ERRORS.TIMESTAMP_EXPIRED, timestamp, ageMs);
  if (ageMs < -Number(futureSkewMs)) return fail(SIGNATURE_ERRORS.TIMESTAMP_IN_FUTURE, timestamp, ageMs);

  const expected = computeSignatureV3({
    clientSecret,
    method,
    uri,
    rawBody,
    timestamp: timestampHeader,
  });

  if (!safeEqual(expected, signature)) {
    return fail(SIGNATURE_ERRORS.SIGNATURE_MISMATCH, timestamp, ageMs);
  }

  return { valid: true, reason: null, timestamp, ageMs };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_FUTURE_SKEW_MS,
  SIGNATURE_ERRORS,
  decodeHubSpotUri,
  getHeader,
  computeSignatureV3,
  safeEqual,
  verifyHubSpotSignatureV3,
};

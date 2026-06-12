const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");
const { createHash, randomUUID, timingSafeEqual } = require('crypto');
const { PostHog } = require('posthog-node');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

// CORS configuration for web requests
const cors = require('cors')({ origin: true });

// Admin SDK for Realtime Database access
const admin = require('firebase-admin');
admin.initializeApp();

// 🔐 SECURE: Define Stripe secret key using Firebase v2 Secret Manager
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeSecretKeyDmv = defineSecret("STRIPE_SECRET_KEY_DMV");
const stripeSecretKeyCre8 = defineSecret("STRIPE_SECRET_KEY_CRE8");
const stripeSecretKeyBsyym = defineSecret("STRIPE_SECRET_KEY_BSYYM");


// 🔐 SECURE: Define Cora secrets
const coraCert = defineSecret("CORA_CERT");
const coraKey = defineSecret("CORA_KEY");
const coraClientId = defineSecret("CORA_CLIENT_ID");

// 🔐 SECURE: Define PagBank secrets
const pagbankToken = defineSecret("PAGBANK_TOKEN");
const upstashRedisRestUrl = defineSecret("UPSTASH_REDIS_REST_URL");
const upstashRedisRestToken = defineSecret("UPSTASH_REDIS_REST_TOKEN");
const docsBasicAuthPassword = defineSecret("DOCS_BASIC_AUTH_PASSWORD");

const CoraClient = require('./src/cora');
const { seedTenants } = require('./src/seedTenants');
const { generateTags, generateTagsBatch } = require('./src/generateTags');

const PIX_WEBHOOK_PROXY_PREFIX = '/api/webhook-pix/';
const PIX_WEBHOOK_PROXY_TARGET_ORIGIN = 'https://giving.onetapgo.site';
const PIX_WEBHOOK_PROXY_TIMEOUT_MS = 15000;
const PIX_WEBHOOK_REDIS_CHANNEL = 'webhook-pix-events';
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || process.env.POSTHOG_PROJECT_API_KEY || 'phc_Cmw1QqdkzzdWkgRuqRNze8vCGmnVnISDjazikU4x1In';
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const REPORTING_SETTINGS_DOC_PATH = 'site_config/reporting_settings';
const REPORTING_SETTINGS_CACHE_TTL_MS = 60 * 1000;
const BRAZIL_REGION = 'southamerica-east1';
const FIRESTORE_REGION = 'us-east1';
const TAG_REDIRECT_REDIS_KEY_PREFIX = 'tag_redirect:';
const TAG_REDIRECT_REDIS_TTL_SECONDS = 60 * 60 * 24 * 14;
const TAG_SCAN_DELTA_REDIS_KEY_PREFIX = 'tag_scan_delta:';
const TAG_SCAN_LAST_MS_REDIS_KEY_PREFIX = 'tag_scan_last_ms:';
const TAG_SCAN_DIRTY_REDIS_SET_KEY = 'tag_scan_dirty_ids';
const TAG_SCAN_FLUSH_BATCH_SIZE = 200;
const DOCS_BASIC_AUTH_USERNAME = 'docs';
const DOCS_ROUTE_PREFIX = '/docs/esp8266-arduino';
const DOCS_BASE_DIR = path.join(__dirname, 'docs', 'esp8266-arduino');
const TAG_REDIRECT_TIME_ZONE = 'America/Sao_Paulo';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const REQUEST_HEADER_BLACKLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-length',
  'host'
]);

const RESPONSE_HEADER_BLACKLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-length'
]);

let hasLoggedMissingPixWebhookRedisUrl = false;
let reportingSettingsCache = {
  expiresAt: 0,
  value: null,
};

function getDocsContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.gz': 'application/gzip',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
  };

  return contentTypes[extension] || 'application/octet-stream';
}

function secureCompareStrings(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuthorizationHeader(headerValue = '') {
  if (!headerValue.startsWith('Basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch (error) {
    return null;
  }
}

function resolveDocsFilePath(requestPath = '') {
  let relativePath = String(requestPath || '/');

  if (relativePath.startsWith(DOCS_ROUTE_PREFIX)) {
    relativePath = relativePath.slice(DOCS_ROUTE_PREFIX.length) || '/';
  }

  if (!relativePath.startsWith('/')) {
    relativePath = `/${relativePath}`;
  }

  const normalizedRelativePath = path.posix.normalize(relativePath);
  const safeRelativePath = normalizedRelativePath === '/' ? '/index.html' : normalizedRelativePath;
  const finalRelativePath = safeRelativePath.endsWith('/') ? `${safeRelativePath}index.html` : safeRelativePath;
  const absolutePath = path.resolve(DOCS_BASE_DIR, `.${finalRelativePath}`);

  if (!absolutePath.startsWith(DOCS_BASE_DIR)) {
    return null;
  }

  return absolutePath;
}

function normalizeLookupValue(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizeAlphaNumeric(value = '') {
  return normalizeLookupValue(value).replace(/[^a-z0-9]/g, '');
}

function sanitizeTenantLookup(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '');
}

function buildCanonicalTagIdentity(...values) {
  const canonicalValue = values
    .map((value) => sanitizeTenantLookup(value))
    .find(Boolean);

  if (!canonicalValue) {
    return null;
  }

  return {
    tenant: canonicalValue,
  };
}

function buildLegacyTagIdentityCleanup() {
  return {
    tenantId: admin.firestore.FieldValue.delete(),
    slug: admin.firestore.FieldValue.delete(),
    client_slug: admin.firestore.FieldValue.delete(),
    clientSlug: admin.firestore.FieldValue.delete(),
  };
}

function normalizeTagId(value = '') {
  return String(value || '').trim();
}

function parseIgnoredTagIds(rawValue) {
  if (Array.isArray(rawValue)) {
    return Array.from(new Set(rawValue.map(normalizeTagId).filter(Boolean)));
  }

  return [];
}

function buildReportingSettings({ ignoredTagIds = [] } = {}) {
  return {
    ignoredTagIds: parseIgnoredTagIds(ignoredTagIds),
  };
}

async function getReportingSettings(db, { forceRefresh = false } = {}) {
  const now = Date.now();

  if (!forceRefresh && reportingSettingsCache.value && reportingSettingsCache.expiresAt > now) {
    return reportingSettingsCache.value;
  }

  let ignoredTagIds = [];

  try {
    const settingsDoc = await db.doc(REPORTING_SETTINGS_DOC_PATH).get();
    ignoredTagIds = parseIgnoredTagIds(settingsDoc.data()?.ignoredTagIds || []);
  } catch (error) {
    logger.warn('Failed to load reporting settings from Firestore', {
      error: error.message || error,
    });
  }

  const value = buildReportingSettings({ ignoredTagIds });
  reportingSettingsCache = {
    expiresAt: now + REPORTING_SETTINGS_CACHE_TTL_MS,
    value,
  };

  return value;
}

function clearReportingSettingsCache() {
  reportingSettingsCache = {
    expiresAt: 0,
    value: null,
  };
}

function isIgnoredTagForReporting(tagId, reportingSettings) {
  if (!tagId) {
    return false;
  }

  return reportingSettings.ignoredTagIds.includes(normalizeTagId(tagId));
}

function getUpstashRestConfig() {
  const url = upstashRedisRestUrl.value() || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = upstashRedisRestToken.value() || process.env.UPSTASH_REDIS_REST_TOKEN || '';

  return {
    url: String(url || '').trim().replace(/\/+$/, ''),
    token: String(token || '').trim(),
  };
}

function getTagRedirectRedisKey(tagId) {
  return `${TAG_REDIRECT_REDIS_KEY_PREFIX}${normalizeTagId(tagId)}`;
}

function getTagScanDeltaRedisKey(tagId) {
  return `${TAG_SCAN_DELTA_REDIS_KEY_PREFIX}${normalizeTagId(tagId)}`;
}

function getTagScanLastMsRedisKey(tagId) {
  return `${TAG_SCAN_LAST_MS_REDIS_KEY_PREFIX}${normalizeTagId(tagId)}`;
}

async function sendUpstashRestCommand(commandParts) {
  const { url, token } = getUpstashRestConfig();

  if (!url || !token) {
    return { ok: false, skipped: true, error: 'Upstash REST credentials are not configured' };
  }

  const commandPath = commandParts.map((part) => encodeURIComponent(String(part))).join('/');
  const response = await fetch(`${url}/${commandPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Upstash REST command failed with status ${response.status}`);
  }

  return response.json();
}

async function getTagRedirectCache(tagId) {
  const key = getTagRedirectRedisKey(tagId);
  const response = await sendUpstashRestCommand(['get', key]);
  const rawValue = response?.result;

  if (!rawValue) {
    return null;
  }

  try {
    const payload = JSON.parse(rawValue);
    const tenant = sanitizeTenantLookup(payload?.tenant || payload?.clientSlug || '');

    return {
      ...payload,
      tenant: tenant || 'fallback',
      clientSlug: tenant || payload?.clientSlug || 'fallback',
    };
  } catch (error) {
    logger.warn('Invalid JSON payload found in tag redirect cache', { tagId });
    return null;
  }
}

async function setTagRedirectCache(tagId, payload) {
  const key = getTagRedirectRedisKey(tagId);
  await sendUpstashRestCommand([
    'set',
    key,
    JSON.stringify(payload),
    'EX',
    TAG_REDIRECT_REDIS_TTL_SECONDS,
  ]);
}

async function deleteTagRedirectCache(tagId) {
  const key = getTagRedirectRedisKey(tagId);
  await sendUpstashRestCommand(['del', key]);
}

async function enqueueTagScanMetric(tagId, occurredAt = new Date()) {
  const normalizedTagId = normalizeTagId(tagId);
  if (!normalizedTagId) {
    return { queued: false, reason: 'missing_tag_id' };
  }

  const occurredAtMs = occurredAt instanceof Date ? occurredAt.getTime() : new Date(occurredAt).getTime();
  if (!Number.isFinite(occurredAtMs)) {
    return { queued: false, reason: 'invalid_timestamp' };
  }

  const response = await sendUpstashRestCommand([
    'EVAL',
    `
local delta = redis.call('INCR', KEYS[1])
local currentLastMs = tonumber(redis.call('GET', KEYS[2]) or '0')
local nextLastMs = tonumber(ARGV[2]) or 0
if nextLastMs > currentLastMs then
  redis.call('SET', KEYS[2], ARGV[2])
end
redis.call('SADD', KEYS[3], ARGV[1])
return {delta, redis.call('GET', KEYS[2])}
    `.trim(),
    '3',
    getTagScanDeltaRedisKey(normalizedTagId),
    getTagScanLastMsRedisKey(normalizedTagId),
    TAG_SCAN_DIRTY_REDIS_SET_KEY,
    normalizedTagId,
    String(occurredAtMs),
  ]);

  const result = Array.isArray(response?.result) ? response.result : [];
  return {
    queued: true,
    tagId: normalizedTagId,
    pendingDelta: Number(result[0] || 0),
    lastScanAtMs: Number(result[1] || occurredAtMs),
  };
}

async function getDirtyTagScanIds() {
  const response = await sendUpstashRestCommand(['SMEMBERS', TAG_SCAN_DIRTY_REDIS_SET_KEY]);
  return Array.isArray(response?.result)
    ? response.result.map(normalizeTagId).filter(Boolean)
    : [];
}

async function getPendingTagScanMetric(tagId) {
  const normalizedTagId = normalizeTagId(tagId);
  if (!normalizedTagId) {
    return null;
  }

  const [deltaResponse, lastMsResponse] = await Promise.all([
    sendUpstashRestCommand(['GET', getTagScanDeltaRedisKey(normalizedTagId)]),
    sendUpstashRestCommand(['GET', getTagScanLastMsRedisKey(normalizedTagId)]),
  ]);

  const pendingDelta = Number(deltaResponse?.result || 0);
  const lastScanAtMs = Number(lastMsResponse?.result || 0);

  if (pendingDelta <= 0 && lastScanAtMs <= 0) {
    return null;
  }

  return {
    tagId: normalizedTagId,
    pendingDelta,
    lastScanAtMs: lastScanAtMs > 0 ? lastScanAtMs : null,
  };
}

async function acknowledgeFlushedTagScanMetric(tagId, { appliedDelta = 0, appliedLastScanAtMs = null } = {}) {
  const normalizedTagId = normalizeTagId(tagId);
  if (!normalizedTagId) {
    return { acknowledged: false, reason: 'missing_tag_id' };
  }

  await sendUpstashRestCommand([
    'EVAL',
    `
local currentDelta = tonumber(redis.call('GET', KEYS[1]) or '0')
local appliedDelta = tonumber(ARGV[2]) or 0
if currentDelta > 0 and appliedDelta > 0 then
  local remainingDelta = currentDelta - appliedDelta
  if remainingDelta > 0 then
    redis.call('SET', KEYS[1], tostring(remainingDelta))
  else
    redis.call('DEL', KEYS[1])
  end
end

local currentLastMs = redis.call('GET', KEYS[2])
local appliedLastMs = tonumber(ARGV[3]) or 0
if currentLastMs and appliedLastMs > 0 and tonumber(currentLastMs) <= appliedLastMs then
  redis.call('DEL', KEYS[2])
end

if redis.call('EXISTS', KEYS[1]) == 0 and redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('SREM', KEYS[3], ARGV[1])
end

return {redis.call('GET', KEYS[1]) or '0', redis.call('GET', KEYS[2]) or '0'}
    `.trim(),
    '3',
    getTagScanDeltaRedisKey(normalizedTagId),
    getTagScanLastMsRedisKey(normalizedTagId),
    TAG_SCAN_DIRTY_REDIS_SET_KEY,
    normalizedTagId,
    String(appliedDelta),
    String(appliedLastScanAtMs || 0),
  ]);

  return {
    acknowledged: true,
    tagId: normalizedTagId,
  };
}

function getDirectTagRedirectUrl(data = {}) {
  return [
    data.redirect_url,
    data.redirect_override,
    data.target_url,
    data.url,
    data.redirectUrl
  ].find((value) => typeof value === 'string' && value.trim().length > 0) || null;
}

function getTagSectorId(data = {}) {
  return sanitizeSectorId(data.sector || data.sectorId || data.setor || '');
}

function getDirectSectorRedirectUrl(data = {}) {
  return [
    data.redirect_url,
    data.redirectUrl,
    data.target_url,
    data.url,
    data.fallbackUrl
  ].find((value) => typeof value === 'string' && value.trim().length > 0) || null;
}

async function getFallbackRedirectUrl(db, caches = {}) {
  if (typeof caches.fallbackUrl === 'string' && caches.fallbackUrl.trim()) {
    return caches.fallbackUrl;
  }

  const fallbackDoc = await db.doc('site_config/fallback').get();
  const fallbackUrl = fallbackDoc.exists && typeof fallbackDoc.data()?.url === 'string' && fallbackDoc.data().url.trim() ?
    fallbackDoc.data().url.trim() :
    '/';

  caches.fallbackUrl = fallbackUrl;
  return fallbackUrl;
}

async function getClientBaseUrl(db, tenant, caches = {}) {
  if (!tenant) {
    return null;
  }

  if (!caches.clientBaseUrls) {
    caches.clientBaseUrls = new Map();
  }

  if (caches.clientBaseUrls.has(tenant)) {
    return caches.clientBaseUrls.get(tenant);
  }

  const clientDoc = await db.collection('clients').doc(tenant).get();
  const baseUrl = typeof clientDoc.data()?.base_url === 'string' && clientDoc.data().base_url.trim() ?
    clientDoc.data().base_url.trim() :
    null;

  caches.clientBaseUrls.set(tenant, baseUrl);
  return baseUrl;
}

function resolveTagTenant(data = {}) {
  return buildCanonicalTagIdentity(
    data.tenant,
    data.tenantId,
    data.slug,
    data.client_slug,
    data.clientSlug
  )?.tenant || 'fallback';
}

async function buildTagRedirectPayloadFromSnapshot(db, tagDoc, { reportingSettings, caches = {} } = {}) {
  if (!tagDoc.exists) {
    return null;
  }

  const data = tagDoc.data() || {};
  const tenant = resolveTagTenant(data);
  const sector = getTagSectorId(data);
  const directTargetUrl = getDirectTagRedirectUrl(data);
  let destinationUrl = directTargetUrl;
  let redirectSource = directTargetUrl ? 'tag_redirect_url' : 'fallback';

  if (!destinationUrl && tenant && tenant !== 'fallback') {
    const clientBaseUrl = await getClientBaseUrl(db, tenant, caches);
    if (clientBaseUrl) {
      destinationUrl = clientBaseUrl;
      redirectSource = 'client_base_url';
    }
  }

  if (!destinationUrl) {
    destinationUrl = await getFallbackRedirectUrl(db, caches);
    redirectSource = 'fallback';
  }

  return {
    id: tagDoc.id,
    tagFound: true,
    tenant,
    clientSlug: tenant,
    sector: sector || null,
    tagDestinationUrl: directTargetUrl || null,
    destinationUrl,
    redirectSource,
    reportingIgnored: isIgnoredTagForReporting(tagDoc.id, reportingSettings || buildReportingSettings()),
    status: typeof data.status === 'string' ? data.status : null,
    updatedAt: parseFirestoreTimestamp(data.updated_at) || parseFirestoreTimestamp(data.updatedAt) || parseFirestoreTimestamp(data.createdAt),
  };
}

async function syncTagSnapshotToRedis(db, tagDoc, { reportingSettings, caches = {} } = {}) {
  if (!tagDoc.exists) {
    await deleteTagRedirectCache(tagDoc.id);
    return { deleted: true, tagId: tagDoc.id };
  }

  const payload = await buildTagRedirectPayloadFromSnapshot(db, tagDoc, { reportingSettings, caches });
  await setTagRedirectCache(tagDoc.id, payload);
  return { updated: true, tagId: tagDoc.id, payload };
}

function shouldEnableRedirectDebug(req) {
  const debugValue = String(req.query?.debug || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(debugValue);
}

function getRequestHeaderValue(req, name) {
  const value = req.get(name);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function buildRedirectDistinctId(req, { tagId, routeType, tenant }) {
  const explicitId = getRequestHeaderValue(req, 'X-PostHog-Distinct-Id')
    || getRequestHeaderValue(req, 'X-GA-Client-ID')
    || String(req.query?.ph_distinct_id || '').trim()
    || String(req.query?.distinct_id || '').trim()
    || String(req.query?.cid || '').trim();

  if (explicitId) {
    return explicitId;
  }

  const fingerprintSource = [
    tagId || 'auto',
    routeType || 'unknown',
    tenant || 'fallback',
    req.ip || '',
    getRequestHeaderValue(req, 'User-Agent'),
    getRequestHeaderValue(req, 'Accept-Language'),
    getRequestHeaderValue(req, 'X-Forwarded-For'),
  ].join('|');

  return `scan_${createHash('sha256').update(fingerprintSource).digest('hex').slice(0, 32)}`;
}

function buildRedirectPosthogProperties(req, {
  tagId,
  tenant,
  sector,
  destinationUrl,
  redirectSource,
  routeType,
  status,
  tagFound = false,
  reportingIgnored = false,
}) {
  let redirectHost = '';
  try {
    redirectHost = new URL(destinationUrl).host;
  } catch (error) {
    redirectHost = '';
  }

  return {
    event_origin: 'firebase_function',
    route_type: routeType,
    tag_id: tagId || 'auto_redirect',
    tenant: tenant || 'fallback',
    client_slug: tenant || 'fallback',
    sector: sector || null,
    redirect_source: redirectSource || 'fallback',
    redirect_url: destinationUrl,
    redirect_host: redirectHost,
    status: typeof status === 'string' ? status : 'unknown',
    tag_found: Boolean(tagFound),
    reporting_ignored: Boolean(reportingIgnored),
    request_path: getRedirectRequestPath(req),
    request_host: getRequestHeaderValue(req, 'host') || req.hostname || '',
    request_method: req.method,
    user_agent: getRequestHeaderValue(req, 'User-Agent'),
    referer: getRequestHeaderValue(req, 'Referer'),
  };
}

async function sendRedirectPosthogEvent(req, context) {
  if (!POSTHOG_API_KEY || context.reportingIgnored) {
    return;
  }

  const posthog = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: 3000,
  });

  try {
    posthog.capture({
      distinctId: buildRedirectDistinctId(req, {
        tagId: context.tagId,
        routeType: context.routeType,
        tenant: context.tenant,
      }),
      event: 'redirect_scan',
      properties: buildRedirectPosthogProperties(req, context),
    });
    await posthog._shutdown(3000);
  } catch (error) {
    logger.warn('Background PostHog redirect_scan failed', {
      tagId: context.tagId,
      error: error.message || error,
    });
  }
}

function createTimingCollector() {
  const startedAt = process.hrtime.bigint();
  const timings = [];

  return {
    start() {
      return process.hrtime.bigint();
    },
    end(step, startedStepAt) {
      const durationMs = Number(process.hrtime.bigint() - startedStepAt) / 1e6;
      timings.push({ step, durationMs: Number(durationMs.toFixed(2)) });
    },
    applyHeaders(res) {
      const totalMs = Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2));
      const items = [...timings, { step: 'total', durationMs: totalMs }];

      res.set('Server-Timing', items.map(({ step, durationMs }) => `${step};dur=${durationMs}`).join(', '));
      res.set('X-OneTapGo-Debug-Timings', items.map(({ step, durationMs }) => `${step}=${durationMs}ms`).join('; '));
    }
  };
}

function appendTagRedirectParameters(url, tagId, campaign) {
  if (!url) {
    return url;
  }

  const trimmedUrl = String(url).trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    return trimmedUrl;
  }

  const parsed = new URL(trimmedUrl);
  parsed.searchParams.set('utm_source', 'onetapgo');
  parsed.searchParams.set('utm_medium', 'nfc');
  parsed.searchParams.set('utm_campaign', campaign || 'fallback');
  parsed.searchParams.set('utm_content', tagId || 'unknown');
  parsed.searchParams.set('utm_timestamp', new Date().toISOString());
  return parsed.toString();
}

function getZonedNowParts(date = new Date(), timeZone = TAG_REDIRECT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: weekdayMap[values.weekday] ?? 0,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function parseScheduleTime(value, fallback = 0) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return fallback;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }

  return hour * 60 + minute;
}

function normalizeScheduleWeekday(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) {
    return value;
  }

  const normalized = normalizeLookupValue(value);
  const weekdayMap = {
    sunday: 0,
    sun: 0,
    domingo: 0,
    monday: 1,
    mon: 1,
    segunda: 1,
    tuesday: 2,
    tue: 2,
    terca: 2,
    quarta: 3,
    wednesday: 3,
    wed: 3,
    quinta: 4,
    thursday: 4,
    thu: 4,
    sexta: 5,
    friday: 5,
    fri: 5,
    sabado: 6,
    saturday: 6,
    sat: 6,
  };

  if (/^[0-6]$/.test(normalized)) {
    return Number(normalized);
  }

  return weekdayMap[normalized];
}

function getScheduleUrl(schedule = {}) {
  return normalizeTenantTagUrl(schedule.url || schedule.redirectUrl || schedule.redirect_url || schedule.target_url);
}

function scheduleMatchesNow(schedule = {}, nowParts = getZonedNowParts(), index = 0) {
  if (!schedule || schedule.active === false || schedule.enabled === false) {
    return null;
  }

  const url = getScheduleUrl(schedule);
  if (!url || !isValidHttpUrl(url)) {
    return null;
  }

  const startTime = schedule.startTime || schedule.time || schedule.startsAtTime || '00:00';
  const endTime = schedule.endTime || schedule.endsAtTime || null;
  const startMinutes = parseScheduleTime(startTime, 0);
  const endMinutes = endTime ? parseScheduleTime(endTime, 24 * 60 - 1) : null;

  if (nowParts.minutes < startMinutes) {
    return null;
  }

  if (endMinutes != null && nowParts.minutes > endMinutes) {
    return null;
  }

  const date = typeof schedule.date === 'string' && schedule.date.trim() ?
    schedule.date.trim() :
    (typeof schedule.specificDate === 'string' && schedule.specificDate.trim() ? schedule.specificDate.trim() : null);

  if (date) {
    return date === nowParts.date ? {
      type: 'date',
      url,
      startMinutes,
      priority: Number.isFinite(Number(schedule.priority)) ? Number(schedule.priority) : 0,
      index,
      scheduleId: schedule.id || null,
    } : null;
  }

  const rawDays = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek :
    (Array.isArray(schedule.weekdays) ? schedule.weekdays : []);
  const weekdays = rawDays
    .map((day) => normalizeScheduleWeekday(day))
    .filter((day) => Number.isInteger(day));

  if (weekdays.length === 0 || !weekdays.includes(nowParts.weekday)) {
    return null;
  }

  return {
    type: 'weekly',
    url,
    startMinutes,
    priority: Number.isFinite(Number(schedule.priority)) ? Number(schedule.priority) : 0,
    index,
    scheduleId: schedule.id || null,
  };
}

function pickActiveSectorSchedule(schedules = [], now = new Date()) {
  if (!Array.isArray(schedules) || schedules.length === 0) {
    return null;
  }

  const nowParts = getZonedNowParts(now);
  const matches = schedules
    .map((schedule, index) => scheduleMatchesNow(schedule, nowParts, index))
    .filter(Boolean);

  if (matches.length === 0) {
    return null;
  }

  matches.sort((left, right) => {
    const typePriority = { date: 2, weekly: 1 };
    if (typePriority[right.type] !== typePriority[left.type]) {
      return typePriority[right.type] - typePriority[left.type];
    }
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    if (right.startMinutes !== left.startMinutes) {
      return right.startMinutes - left.startMinutes;
    }
    return right.index - left.index;
  });

  return matches[0];
}

async function resolveSectorRedirect(db, payload, { caches = {}, now = new Date() } = {}) {
  if (!payload?.tenant || !payload?.sector || payload.tenant === 'fallback') {
    return null;
  }

  if (!caches.sectorRedirects) {
    caches.sectorRedirects = new Map();
  }

  const cacheKey = `${payload.tenant}:${payload.sector}`;
  let sectorData = caches.sectorRedirects.get(cacheKey);

  if (!sectorData) {
    const sectorDoc = await db
      .collection('tenants')
      .doc(payload.tenant)
      .collection('sectors')
      .doc(payload.sector)
      .get();

    if (!sectorDoc.exists) {
      caches.sectorRedirects.set(cacheKey, { exists: false });
      return null;
    }

    sectorData = { exists: true, ...sectorDoc.data() };
    caches.sectorRedirects.set(cacheKey, sectorData);
  }

  if (!sectorData.exists || sectorData.active === false || sectorData.enabled === false) {
    return null;
  }

  const activeSchedule = pickActiveSectorSchedule(sectorData.schedules, now);
  if (activeSchedule) {
    return {
      destinationUrl: activeSchedule.url,
      redirectSource: `sector_${activeSchedule.type}_schedule`,
      scheduleId: activeSchedule.scheduleId,
    };
  }

  const directUrl = getDirectSectorRedirectUrl(sectorData);
  if (directUrl && isValidHttpUrl(directUrl)) {
    return {
      destinationUrl: directUrl,
      redirectSource: 'sector_redirect_url',
      scheduleId: null,
    };
  }

  return null;
}

async function resolveFinalTagRedirectPayload(db, payload, { caches = {}, now = new Date() } = {}) {
  const sectorRedirect = await resolveSectorRedirect(db, payload, { caches, now });
  if (!sectorRedirect) {
    return payload;
  }

  return {
    ...payload,
    destinationUrl: sectorRedirect.destinationUrl,
    redirectSource: sectorRedirect.redirectSource,
    sectorScheduleId: sectorRedirect.scheduleId,
  };
}

function getRedirectRequestPath(req) {
  const originalPath = String(req.originalUrl || '').split('?')[0];
  if (originalPath) {
    return originalPath;
  }

  return String(req.path || '');
}

function getLastPathSegment(pathValue = '') {
  const parts = String(pathValue || '').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

async function resolveTagRedirectFromFirestore(db, tagId, { reportingSettings, caches = {}, timings = null } = {}) {
  const readStartedAt = timings ? timings.start() : null;
  const tagDoc = await db.collection('tags').doc(tagId).get();
  if (timings && readStartedAt) {
    timings.end('firestore_get', readStartedAt);
  }

  if (!tagDoc.exists) {
    return null;
  }

  const payloadStartedAt = timings ? timings.start() : null;
  const payload = await buildTagRedirectPayloadFromSnapshot(db, tagDoc, { reportingSettings, caches });
  if (timings && payloadStartedAt) {
    timings.end('build_payload', payloadStartedAt);
  }

  const cacheSetStartedAt = timings ? timings.start() : null;
  await setTagRedirectCache(tagId, payload);
  if (timings && cacheSetStartedAt) {
    timings.end('redis_set', cacheSetStartedAt);
  }

  return payload;
}

async function getAutoRedirectUrl(db, timings = null) {
  const startedAt = timings ? timings.start() : null;
  const doc = await db.doc('site_config/auto_redirect').get();
  if (timings && startedAt) {
    timings.end('auto_redirect_get', startedAt);
  }

  if (doc.exists && typeof doc.data()?.url === 'string' && doc.data().url.trim()) {
    return doc.data().url.trim();
  }

  return '/';
}

function flattenFormValues(value, values = []) {
  if (value == null) {
    return values;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => flattenFormValues(entry, values));
    return values;
  }

  if (typeof value === 'object') {
    Object.values(value).forEach((entry) => flattenFormValues(entry, values));
    return values;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    values.push(String(value));
  }

  return values;
}

function firstNonEmptyValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function buildFormSubmissionSearchFields({ churchSlug, churchName, formType, formData, destination, sourcePath }) {
  const payload = formData && typeof formData === 'object' && !Array.isArray(formData) ? formData : {};
  const flattenedValues = flattenFormValues(payload);
  const searchText = [
    churchSlug,
    churchName,
    formType,
    destination,
    sourcePath,
    ...flattenedValues,
  ]
    .filter(Boolean)
    .join(' ');

  const fullName = firstNonEmptyValue(
    payload.fullName,
    payload.name,
    payload.nome,
    payload.personName,
    payload.contactName
  );

  const email = firstNonEmptyValue(
    payload.email,
    payload.emailAddress,
    payload.mail
  );

  const phone = firstNonEmptyValue(
    payload.phone,
    payload.whatsapp,
    payload.telefone,
    payload.mobile,
    payload.celular
  );

  const document = firstNonEmptyValue(
    payload.document,
    payload.documentNumber,
    payload.cpf,
    payload.cnpj,
    payload.cpfCnpj
  );

  return {
    tenant: sanitizeTenantLookup(churchSlug),
    searchTextNormalized: normalizeLookupValue(searchText),
    fullName,
    fullNameNormalized: fullName ? normalizeLookupValue(fullName) : null,
    email: email ? email.toLowerCase() : null,
    emailNormalized: email ? normalizeLookupValue(email) : null,
    phone,
    phoneDigits: phone ? String(phone).replace(/\D/g, '') : null,
    document,
    documentDigits: document ? String(document).replace(/\D/g, '') : null,
  };
}

function buildSubmissionLookupIndex(submission) {
  const formData = submission?.formData && typeof submission.formData === 'object' && !Array.isArray(submission.formData) ?
    submission.formData :
    {};
  const metadataFields = buildFormSubmissionSearchFields({
    churchSlug: submission?.tenant || submission?.churchSlug,
    churchName: submission?.churchName,
    formType: submission?.formType,
    formData,
    destination: submission?.destination,
    sourcePath: submission?.sourcePath
  });

  return {
    tenant: sanitizeTenantLookup(submission?.tenant || submission?.churchSlug),
    formType: typeof submission?.formType === 'string' ? submission.formType.trim() : '',
    searchTextNormalized: metadataFields.searchTextNormalized,
    fullNameNormalized: metadataFields.fullNameNormalized,
    emailNormalized: metadataFields.emailNormalized,
    phoneDigits: metadataFields.phoneDigits,
    documentDigits: metadataFields.documentDigits,
  };
}

function matchesSubmissionFilters(lookup, filters) {
  if (filters.formType && lookup.formType !== filters.formType) {
    return false;
  }

  if (filters.name && !(lookup.fullNameNormalized || '').includes(filters.name)) {
    return false;
  }

  if (filters.email && !(lookup.emailNormalized || '').includes(filters.email)) {
    return false;
  }

  if (filters.phone && !(lookup.phoneDigits || '').includes(filters.phone)) {
    return false;
  }

  if (filters.document && !(lookup.documentDigits || '').includes(filters.document)) {
    return false;
  }

  if (filters.q) {
    const exactDocumentMatch = (lookup.documentDigits || '').includes(filters.qAlphaNumeric);
    const exactPhoneMatch = (lookup.phoneDigits || '').includes(filters.qDigits);
    const textMatch = (lookup.searchTextNormalized || '').includes(filters.q);

    if (!textMatch && !exactDocumentMatch && !exactPhoneMatch) {
      return false;
    }
  }

  return true;
}

function serializeSubmission(doc) {
  const data = doc.data();
  const createdAt = data.createdAt && typeof data.createdAt.toDate === 'function' ?
    data.createdAt.toDate().toISOString() :
    null;
  const updatedAt = data.updatedAt && typeof data.updatedAt.toDate === 'function' ?
    data.updatedAt.toDate().toISOString() :
    null;

  return {
    id: doc.id,
    tenant: data.tenant || data.churchSlug || null,
    churchSlug: data.churchSlug || null,
    churchName: data.churchName || null,
    formType: data.formType || null,
    formData: data.formData || {},
    destination: data.destination || null,
    sourcePath: data.sourcePath || null,
    referer: data.referer || null,
    origin: data.origin || null,
    createdAt,
    updatedAt,
  };
}

function parseFirestoreTimestamp(value) {
  if (!value) {
    return null;
  }

  if (typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return null;
}

function getTagListFilter(req) {
  const value = sanitizeTenantLookup(req.query.tenant);
  const sector = sanitizeSectorId(req.query.sector || req.query.setor || '');
  return value ? { field: 'tenant', value, sector: sector || null } : null;
}

function parseTagListLimit(rawValue) {
  if (rawValue == null || rawValue === '') {
    return 200;
  }

  const parsed = Number.parseInt(String(rawValue), 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) {
    return null;
  }

  return parsed;
}

function encodeTagCursor(docId) {
  return Buffer.from(String(docId), 'utf8').toString('base64url');
}

function decodeTagCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.trim()) {
    return null;
  }

  try {
    const normalizedCursor = cursor.trim();
    const decoded = Buffer.from(normalizedCursor, 'base64url').toString('utf8');

    if (!decoded) {
      return null;
    }

    if (encodeTagCursor(decoded) !== normalizedCursor) {
      return null;
    }

    return decoded;
  } catch (error) {
    return null;
  }
}

function serializeTag(doc) {
  const data = doc.data();

  return {
    id: doc.id,
    uid: data.uid || null,
    tenant: data.tenant || null,
    tenantId: data.tenantId || null,
    sector: data.sector || data.sectorId || data.setor || null,
    status: data.status || null,
    redirect_url: data.redirect_url || null,
    redirect_override: data.redirect_override || null,
    target_url: data.target_url || null,
    url: data.url || null,
    redirectUrl: data.redirectUrl || null,
    scan_count: typeof data.scan_count === 'number' ? data.scan_count : 0,
    provisioned_by: data.provisioned_by || null,
    provisioned_at: parseFirestoreTimestamp(data.provisioned_at),
    last_scan_at: parseFirestoreTimestamp(data.last_scan_at),
    updated_at: parseFirestoreTimestamp(data.updated_at),
    updatedAt: parseFirestoreTimestamp(data.updatedAt),
    createdAt: parseFirestoreTimestamp(data.createdAt),
  };
}

function tagMatchesSector(doc, sector) {
  if (!sector) {
    return true;
  }

  return getTagSectorId(doc.data() || {}) === sector;
}

function buildTagKpis(snapshot, filter, reportingSettings = buildReportingSettings()) {
  const statusBreakdown = {};
  const activeUrls = new Map();
  const ignoredTagIds = new Set(reportingSettings.ignoredTagIds || []);
  let ignoredTagsCount = 0;
  let includedTags = 0;
  let totalScans = 0;
  let activeTags = 0;
  let inactiveTags = 0;
  let tagsWithScans = 0;
  let tagsWithoutScans = 0;
  let tagsWithRedirect = 0;
  let tagsWithoutRedirect = 0;
  let latestScanDate = null;
  let latestUpdateDate = null;

  snapshot.docs.forEach((doc) => {
    if (ignoredTagIds.has(doc.id)) {
      ignoredTagsCount += 1;
      return;
    }

    const data = doc.data();
    if (!tagMatchesSector(doc, filter.sector)) {
      return;
    }

    const status = typeof data.status === 'string' && data.status.trim() ? data.status.trim().toLowerCase() : 'unknown';
    const scanCount = typeof data.scan_count === 'number' ? data.scan_count : 0;
    const redirectUrl = [
      data.redirect_url,
      data.redirect_override,
      data.target_url,
      data.url,
      data.redirectUrl
    ].find((value) => typeof value === 'string' && value.trim());
    const lastScanAt = data.last_scan_at && typeof data.last_scan_at.toDate === 'function' ? data.last_scan_at.toDate() : null;
    const updatedAt = [
      data.updated_at,
      data.updatedAt,
      data.createdAt
    ].find((value) => value && typeof value.toDate === 'function');
    const updatedAtDate = updatedAt ? updatedAt.toDate() : null;
    includedTags += 1;

    statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
    totalScans += scanCount;

    if (status === 'active') {
      activeTags += 1;
    } else {
      inactiveTags += 1;
    }

    if (scanCount > 0) {
      tagsWithScans += 1;
    } else {
      tagsWithoutScans += 1;
    }

    if (redirectUrl) {
      tagsWithRedirect += 1;
      activeUrls.set(redirectUrl, (activeUrls.get(redirectUrl) || 0) + 1);
    } else {
      tagsWithoutRedirect += 1;
    }

    if (lastScanAt && (!latestScanDate || lastScanAt > latestScanDate)) {
      latestScanDate = lastScanAt;
    }

    if (updatedAtDate && (!latestUpdateDate || updatedAtDate > latestUpdateDate)) {
      latestUpdateDate = updatedAtDate;
    }
  });

  return {
    success: true,
    filters: {
      field: filter.field,
      value: filter.value,
      sector: filter.sector || null,
    },
    kpis: {
      total_tags: includedTags,
      active_tags: activeTags,
      inactive_tags: inactiveTags,
      tags_with_scans: tagsWithScans,
      tags_without_scans: tagsWithoutScans,
      tags_with_redirect: tagsWithRedirect,
      tags_without_redirect: tagsWithoutRedirect,
      total_scans: totalScans,
      average_scans_per_tag: includedTags > 0 ? Number((totalScans / includedTags).toFixed(2)) : 0,
      latest_scan_at: latestScanDate ? latestScanDate.toISOString() : null,
      latest_updated_at: latestUpdateDate ? latestUpdateDate.toISOString() : null,
      ignored_tags_count: ignoredTagsCount,
      status_breakdown: statusBreakdown,
      active_urls: Array.from(activeUrls.entries())
        .sort((left, right) => {
          if (right[1] !== left[1]) {
            return right[1] - left[1];
          }

          return left[0].localeCompare(right[0]);
        })
        .map(([url, count]) => ({ url, count })),
    }
  };
}

async function listTags(req, res) {
  const filter = getTagListFilter(req);

  if (!filter) {
    return res.status(400).json({
      success: false,
      error: 'tenant is required'
    });
  }

  const limit = parseTagListLimit(req.query.limit);

  if (!limit) {
    return res.status(400).json({
      success: false,
      error: 'limit must be a positive integer'
    });
  }

  const cursor = req.query.cursor ? decodeTagCursor(req.query.cursor) : null;

  if (req.query.cursor && !cursor) {
    return res.status(400).json({
      success: false,
      error: 'cursor is invalid'
    });
  }

  try {
    const db = admin.firestore();
    let query = db.collection('tags')
      .where(filter.field, '==', filter.value)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(limit + 1);

    if (filter.sector) {
      query = db.collection('tags')
        .where(filter.field, '==', filter.value)
        .where('sector', '==', filter.sector)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(limit + 1);
    }

    if (cursor) {
      query = query.startAfter(cursor);
    }

    const snapshot = await query.get();
    const hasMore = snapshot.docs.length > limit;
    const pageDocs = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
    const nextCursor = hasMore && pageDocs.length > 0 ? encodeTagCursor(pageDocs[pageDocs.length - 1].id) : null;

    return res.status(200).json({
      success: true,
      filters: {
        field: filter.field,
        value: filter.value,
        sector: filter.sector || null,
        limit
      },
      count: pageDocs.length,
      tags: pageDocs.map((doc) => serializeTag(doc)),
      pagination: {
        nextCursor,
        hasMore
      }
    });
  } catch (error) {
    logger.error('Error listing tags', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error'
    });
  }
}

async function getTagKpis(req, res) {
  const filter = getTagListFilter(req);

  if (!filter) {
    return res.status(400).json({
      success: false,
      error: 'tenant is required'
    });
  }

  try {
    const db = admin.firestore();
    const snapshot = await db.collection('tags')
      .where(filter.field, '==', filter.value)
      .get();
    const reportingSettings = await getReportingSettings(db);

    return res.status(200).json(buildTagKpis(snapshot, filter, reportingSettings));
  } catch (error) {
    logger.error('Error fetching tag KPIs', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error'
    });
  }
}

async function queryFormSubmissions(req, res) {
  const tenantParam = req.query.tenant || req.query.churchSlug || req.query.slug;
  const tenant = sanitizeTenantLookup(tenantParam);

  if (!tenant) {
    return res.status(400).json({
      success: false,
      error: 'tenant is required'
    });
  }

  const formType = typeof req.query.formType === 'string' && req.query.formType.trim() ?
    req.query.formType.trim() :
    null;
  const name = typeof req.query.name === 'string' && req.query.name.trim() ?
    normalizeLookupValue(req.query.name) :
    null;
  const email = typeof req.query.email === 'string' && req.query.email.trim() ?
    normalizeLookupValue(req.query.email) :
    null;
  const phone = typeof req.query.phone === 'string' && req.query.phone.trim() ?
    String(req.query.phone).replace(/\D/g, '') :
    null;
  const document = typeof req.query.document === 'string' && req.query.document.trim() ?
    String(req.query.document).replace(/\D/g, '') :
    null;
  const q = typeof req.query.q === 'string' && req.query.q.trim() ?
    normalizeLookupValue(req.query.q) :
    null;
  const rawLimit = Number.parseInt(String(req.query.limit || '20'), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
  const scanLimit = Math.min(Math.max(limit * 5, 20), 300);

  const filters = {
    formType,
    name,
    email,
    phone,
    document,
    q,
    qDigits: q ? q.replace(/\D/g, '') : '',
    qAlphaNumeric: q ? normalizeAlphaNumeric(q) : '',
  };

  try {
    const db = admin.firestore();
    let snapshot;

    const primaryQuery = db.collection('form_submissions')
      .where('tenant', '==', tenant)
      .orderBy('createdAt', 'desc')
      .limit(scanLimit);

    try {
      snapshot = await (formType ?
        primaryQuery.where('formType', '==', formType).get() :
        primaryQuery.get());
    } catch (tenantIndexedError) {
      logger.warn('queryFormSubmissions: falling back to churchSlug filter', {
        tenant,
        error: tenantIndexedError.message
      });
    }

    if (!snapshot || snapshot.empty) {
      let fallbackQuery = db.collection('form_submissions')
        .where('churchSlug', '==', tenant)
        .orderBy('createdAt', 'desc')
        .limit(scanLimit);

      if (formType) {
        fallbackQuery = fallbackQuery.where('formType', '==', formType);
      }

      snapshot = await fallbackQuery.get();
    }

    const results = snapshot.docs
      .filter((doc) => matchesSubmissionFilters(buildSubmissionLookupIndex(doc.data()), filters))
      .slice(0, limit)
      .map((doc) => serializeSubmission(doc));

    return res.status(200).json({
      success: true,
      filters: {
        tenant,
        ...(formType ? { formType } : {}),
        ...(name ? { name: req.query.name } : {}),
        ...(email ? { email: req.query.email } : {}),
        ...(phone ? { phone: req.query.phone } : {}),
        ...(document ? { document: req.query.document } : {}),
        ...(q ? { q: req.query.q } : {}),
        limit,
      },
      count: results.length,
      submissions: results
    });
  } catch (error) {
    logger.error('Error querying form submissions', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error'
    });
  }
}

function extractPixWebhookCnpj(pathname = '') {
  const normalizedPath = pathname.endsWith('/') && pathname.length > PIX_WEBHOOK_PROXY_PREFIX.length ?
    pathname.slice(0, -1) :
    pathname;

  if (!normalizedPath.startsWith(PIX_WEBHOOK_PROXY_PREFIX)) {
    return null;
  }

  const cnpj = normalizedPath.slice(PIX_WEBHOOK_PROXY_PREFIX.length);
  return /^\d{14}$/.test(cnpj) ? cnpj : null;
}

function buildPixWebhookTargetUrl(req) {
  const originalUrl = req.originalUrl || req.url || req.path || '/';
  return new URL(originalUrl, PIX_WEBHOOK_PROXY_TARGET_ORIGIN).toString();
}

function buildProxyRequestHeaders(headers = {}) {
  const proxyHeaders = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value == null) {
      continue;
    }

    const normalizedName = name.toLowerCase();
    if (REQUEST_HEADER_BLACKLIST.has(normalizedName)) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => proxyHeaders.append(name, entry));
      continue;
    }

    proxyHeaders.set(name, value);
  }

  proxyHeaders.set('x-proxy-by', 'onetapgo-firebase');

  return proxyHeaders;
}

function applyProxyResponseHeaders(upstreamHeaders, res) {
  if (typeof upstreamHeaders.getSetCookie === 'function') {
    const setCookieHeaders = upstreamHeaders.getSetCookie();
    if (setCookieHeaders.length > 0) {
      res.set('set-cookie', setCookieHeaders);
    }
  }

  upstreamHeaders.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') {
      return;
    }

    if (RESPONSE_HEADER_BLACKLIST.has(name.toLowerCase())) {
      return;
    }

    res.set(name, value);
  });
}

function shouldForwardRequestBody(method = '') {
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD';
}

function getPixWebhookRedisUrl() {
  return process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL || '';
}

function encodeRedisCommand(parts) {
  const chunks = [`*${parts.length}\r\n`];

  parts.forEach((part) => {
    const value = String(part);
    chunks.push(`$${Buffer.byteLength(value)}\r\n${value}\r\n`);
  });

  return chunks.join('');
}

function parseRedisReply(buffer) {
  if (!buffer || buffer.length === 0) {
    return null;
  }

  const prefix = String.fromCharCode(buffer[0]);
  const lineEnd = buffer.indexOf('\r\n');

  if (lineEnd === -1) {
    return null;
  }

  const header = buffer.slice(1, lineEnd).toString();

  if (prefix === '+' || prefix === '-' || prefix === ':') {
    return {
      type: prefix,
      value: header,
      bytesConsumed: lineEnd + 2
    };
  }

  if (prefix === '$') {
    const length = Number.parseInt(header, 10);

    if (Number.isNaN(length)) {
      throw new Error('Invalid Redis bulk reply length');
    }

    if (length === -1) {
      return {
        type: prefix,
        value: null,
        bytesConsumed: lineEnd + 2
      };
    }

    const valueStart = lineEnd + 2;
    const valueEnd = valueStart + length;
    const totalBytes = valueEnd + 2;

    if (buffer.length < totalBytes) {
      return null;
    }

    return {
      type: prefix,
      value: buffer.slice(valueStart, valueEnd).toString(),
      bytesConsumed: totalBytes
    };
  }

  throw new Error(`Unsupported Redis reply type: ${prefix}`);
}

function connectPixWebhookRedis(redisUrlString) {
  return new Promise((resolve, reject) => {
    const redisUrl = new URL(redisUrlString);
    const socket = tls.connect({
      host: redisUrl.hostname,
      port: Number.parseInt(redisUrl.port || '6379', 10),
      servername: redisUrl.hostname
    });

    const cleanup = () => {
      socket.off('secureConnect', onSecureConnect);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };

    const onSecureConnect = () => {
      cleanup();
      resolve({ redisUrl, socket });
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onTimeout = () => {
      cleanup();
      socket.destroy(new Error('Redis TLS connection timed out'));
      reject(new Error('Redis TLS connection timed out'));
    };

    socket.setTimeout(PIX_WEBHOOK_PROXY_TIMEOUT_MS);
    socket.once('secureConnect', onSecureConnect);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

function sendRedisCommand(socket, parts) {
  return new Promise((resolve, reject) => {
    let bufferedResponse = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
    };

    const succeed = (reply) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(reply);
    };

    const fail = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk) => {
      bufferedResponse = Buffer.concat([bufferedResponse, chunk]);

      let reply;
      try {
        reply = parseRedisReply(bufferedResponse);
      } catch (error) {
        fail(error);
        return;
      }

      if (!reply) {
        return;
      }

      if (reply.type === '-') {
        fail(new Error(`Redis command failed: ${reply.value}`));
        return;
      }

      succeed(reply);
    };

    const onError = (error) => fail(error);
    const onClose = () => fail(new Error('Redis connection closed unexpectedly'));
    const onTimeout = () => fail(new Error('Redis command timed out'));

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('timeout', onTimeout);
    socket.write(encodeRedisCommand(parts));
  });
}

async function publishPixWebhookRedisEvent(payload) {
  const redisUrlString = getPixWebhookRedisUrl();

  if (!redisUrlString) {
    if (!hasLoggedMissingPixWebhookRedisUrl) {
      logger.warn('proxyPixWebhook Redis publish skipped because UPSTASH_REDIS_URL is not configured');
      hasLoggedMissingPixWebhookRedisUrl = true;
    }

    return null;
  }

  let socket;

  try {
    const connection = await connectPixWebhookRedis(redisUrlString);
    const redisUrl = connection.redisUrl;
    socket = connection.socket;

    const username = decodeURIComponent(redisUrl.username || '');
    const password = decodeURIComponent(redisUrl.password || '');

    if (password) {
      const authCommand = username ? ['AUTH', username, password] : ['AUTH', password];
      await sendRedisCommand(socket, authCommand);
    }

    const publishReply = await sendRedisCommand(socket, [
      'PUBLISH',
      process.env.PIX_WEBHOOK_REDIS_CHANNEL || PIX_WEBHOOK_REDIS_CHANNEL,
      JSON.stringify(payload)
    ]);

    await sendRedisCommand(socket, ['QUIT']).catch(() => null);
    socket.end();

    return Number.parseInt(publishReply.value || '0', 10);
  } catch (error) {
    if (socket) {
      socket.destroy();
    }

    logger.error('proxyPixWebhook Redis publish failed', {
      event: payload.event,
      cnpj: payload.cnpj,
      error: error.message
    });

    return null;
  }
}

function publishPixWebhookRedisEventAsync(payload) {
  void publishPixWebhookRedisEvent(payload);
}

exports.proxyPixWebhook = onRequest(
  {
    maxInstances: 5,
    timeoutSeconds: 30
  },
  async (req, res) => {
    const startedAt = Date.now();
    const cnpj = extractPixWebhookCnpj(req.path);

    if (!cnpj) {
      logger.warn('proxyPixWebhook rejected invalid path', {
        method: req.method,
        path: req.path
      });
      res.status(400).json({ error: 'Invalid webhook PIX path' });
      return;
    }

    const targetUrl = buildPixWebhookTargetUrl(req);

    try {
      const upstreamResponse = await fetch(targetUrl, {
        method: req.method,
        headers: buildProxyRequestHeaders(req.headers),
        body: shouldForwardRequestBody(req.method) ? (req.rawBody || Buffer.alloc(0)) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(PIX_WEBHOOK_PROXY_TIMEOUT_MS)
      });

      const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());

      applyProxyResponseHeaders(upstreamResponse.headers, res);

      const durationMs = Date.now() - startedAt;
      const redisPayload = {
        event: 'proxy_success',
        timestamp: new Date().toISOString(),
        method: req.method,
        cnpj,
        path: req.path,
        targetUrl,
        status: upstreamResponse.status,
        durationMs
      };

      logger.info('proxyPixWebhook forwarded request', {
        method: req.method,
        cnpj,
        targetUrl,
        status: upstreamResponse.status,
        durationMs
      });

      res.status(upstreamResponse.status);

      if (req.method.toUpperCase() === 'HEAD') {
        res.end();
        publishPixWebhookRedisEventAsync(redisPayload);
        return;
      }

      res.send(responseBuffer);
      publishPixWebhookRedisEventAsync(redisPayload);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const redisPayload = {
        event: 'proxy_error',
        timestamp: new Date().toISOString(),
        method: req.method,
        cnpj,
        path: req.path,
        targetUrl,
        durationMs,
        error: error.message
      };

      logger.error('proxyPixWebhook upstream request failed', {
        method: req.method,
        cnpj,
        targetUrl,
        durationMs,
        error: error.message
      });

      res.status(502).json({ error: 'Failed to reach upstream webhook' });
      publishPixWebhookRedisEventAsync(redisPayload);
    }
  }
);

// --- PAGBANK GOOGLE PAY FUNCTION ---
exports.createPagBankOrder = onRequest(
  {
    cors: true,
    maxInstances: 3,
    secrets: [pagbankToken]
  },
  async (req, res) => {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    try {
      const { amount, googlePayToken, customer, referenceId } = req.body;
      const token = pagbankToken.value();

      if (!token) {
        logger.error('PagBank token not configured');
        return res.status(500).json({ error: 'PagBank configuration missing' });
      }

      const axios = require('axios');
      const isSandbox = true; // Set to false for production
      const baseUrl = isSandbox ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com';

      const orderPayload = {
        reference_id: referenceId || `order-${Date.now()}`,
        customer: {
          name: customer?.name || "Pagador IARCA",
          email: customer?.email || "contato@iarca.org",
          tax_id:  "33586973802", //customer?.document?.replace(/\D/g, '') || remover meu CPF e colocar um genérico
          phones: [{ country: "55", area: "11", number: "999999999", type: "MOBILE" }]
        },
        items: [{
          name: "Doação IARCA Church",
          quantity: 1,
          unit_amount: Math.round(amount * 100)
        }],
        charges: [{
          reference_id: `charge-${Date.now()}`,
          amount: { value: Math.round(amount * 100), currency: "BRL" },
          payment_method: {
            type: "CREDIT_CARD",
            installments: 1,
            capture: true,
            card: {
              wallet: {
                type: "GOOGLE_PAY",
                key: googlePayToken
              }
            }
          }
        }]
      };

      logger.info('Sending order to PagBank', { referenceId: orderPayload.reference_id });

      const response = await axios.post(`${baseUrl}/orders`, orderPayload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      logger.info('PagBank response success', { orderId: response.data.id });
      res.json(response.data);

    } catch (error) {
      const errorData = error.response?.data || error.message;
      logger.error('Error creating PagBank order:', errorData);
      res.status(500).json({
        error: 'Failed to process PagBank payment',
        details: errorData
      });
    }
  }
);

// --- NEW LOGGING FUNCTION ---
exports.logEvent = onRequest({ cors: true, maxInstances: 10 }, async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
    }

    try {
        const { eventType, data } = req.body;

        if (!eventType || !data) {
            logger.warn("logEvent: Missing eventType or data", { body: req.body });
            return res.status(400).json({ success: false, error: "Missing eventType or data" });
        }

        const db = admin.firestore();
        const now = admin.firestore.FieldValue.serverTimestamp();

        // Enrich data with server-side information
        const enrichedData = {
            ...data,
            serverTimestamp: now,
            ipAddress: req.ip, // Automatically captured by Cloud Functions
            userAgent: req.get('User-Agent'),
        };

        // 1. Log to a generic 'events' collection for auditing
        const eventLogRef = await db.collection('events').add({
            eventType,
            ...enrichedData,
        });
        logger.info(`Event '${eventType}' logged with ID: ${eventLogRef.id}`, { data });


        // 2. Handle specific event types for structured data
        switch (eventType) {
            case 'payment_intent_success':
                await db.collection('payments').doc(data.stripePaymentIntentId).set({
                    ...enrichedData,
                    status: 'success'
                }, { merge: true });
                logger.info(`Payment record '${data.stripePaymentIntentId}' updated to success.`);
                break;

            case 'payment_intent_failure':
                await db.collection('payments').doc(data.stripePaymentIntentId).set({
                    ...enrichedData,
                    status: 'failed'
                }, { merge: true });
                logger.warn(`Payment record '${data.stripePaymentIntentId}' updated to failed.`);
                break;
            
            case 'payment_intent_initiated':
                 await db.collection('payments').doc(data.stripePaymentIntentId).set({
                    ...enrichedData,
                    status: 'initiated'
                }, { merge: true });
                logger.info(`Payment record '${data.stripePaymentIntentId}' created.`);
                break;

            // Example for other events
            case 'user_profile_update':
                if (data.userId) {
                    await db.collection('users').doc(data.userId).set(data, { merge: true });
                    logger.info(`User profile '${data.userId}' updated.`);
                }
                break;

            default:
                logger.info(`No specific handler for eventType: ${eventType}. Logged to 'events' only.`);
        }

        return res.status(200).json({ success: true, eventId: eventLogRef.id });

    } catch (error) {
        logger.error("Error in logEvent function:", error);
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

exports.saveFormSubmission = onRequest({ cors: true, maxInstances: 10 }, async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    if (req.method === 'GET') {
        return queryFormSubmissions(req, res);
    }

    if (req.method !== 'POST') {
        res.set('Allow', 'GET, POST, OPTIONS');
        res.status(405).json({ success: false, error: 'Method Not Allowed' });
        return;
    }

    try {
        const {
            churchSlug,
            churchName,
            formType,
            formData,
            destination,
            sourcePath
        } = req.body || {};

        if (!churchSlug || !formType || !formData || typeof formData !== 'object' || Array.isArray(formData)) {
            logger.warn('saveFormSubmission: invalid payload', { body: req.body });
            return res.status(400).json({
                success: false,
                error: 'Missing churchSlug, formType or formData'
            });
        }

        const db = admin.firestore();
        const searchFields = buildFormSubmissionSearchFields({
            churchSlug,
            churchName,
            formType,
            formData,
            destination,
            sourcePath: sourcePath ? String(sourcePath).trim() : req.path,
        });
        const submissionRef = await db.collection('form_submissions').add({
            churchSlug: String(churchSlug).trim(),
            tenant: searchFields.tenant,
            churchName: churchName ? String(churchName).trim() : null,
            formType: String(formType).trim(),
            formData,
            destination: destination ? String(destination).trim() : null,
            sourcePath: sourcePath ? String(sourcePath).trim() : req.path,
            referer: req.get('referer') || null,
            origin: req.get('origin') || null,
            userAgent: req.get('user-agent') || null,
            ipAddress: req.ip || null,
            searchTextNormalized: searchFields.searchTextNormalized,
            fullName: searchFields.fullName,
            fullNameNormalized: searchFields.fullNameNormalized,
            email: searchFields.email,
            emailNormalized: searchFields.emailNormalized,
            phone: searchFields.phone,
            phoneDigits: searchFields.phoneDigits,
            document: searchFields.document,
            documentDigits: searchFields.documentDigits,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        logger.info('Form submission saved', {
            submissionId: submissionRef.id,
            churchSlug,
            formType
        });

        return res.status(200).json({
            success: true,
            submissionId: submissionRef.id
        });
    } catch (error) {
        logger.error('Error saving form submission', error);
        return res.status(500).json({
            success: false,
            error: 'Internal Server Error'
        });
    }
});


// Create Payment Intent for Stripe
exports.createPaymentIntent = onRequest(
  {
    cors: true,
    maxInstances: 3, // Set max instances for cost control
    secrets: [stripeSecretKey,stripeSecretKeyDmv,stripeSecretKeyCre8,stripeSecretKeyBsyym] // Make secret available to this function
  },
  async (req, res) => {
    // Handle CORS preflight
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    try {
      //Lookup for the domain in request headers if needed for multi-tenant logic then select which stripeSecretKey to use
      const domain = req.get('Origin') || req.get('Referer') || 'unknown';
      logger.info('createPaymentIntent called from domain:', domain);

      if(domain.includes('rcsp.com.br') || domain.includes('rcsp.onetapgo.site') || domain.includes('wasser-c430a.web.app') || domain.includes('cre8.onetapgo.site')) {
        logger.info('Using CRE8 Connect Stripe configuration');
        secretKeyValue = stripeSecretKeyCre8.value();
      }else if(domain.includes('taptosow-staging.web.app') || domain.includes('dmv.onetapgo.site') || domain.includes('rampchurchdmv.onetapgo.site') || domain.includes('rampdmv.web.app')){
        logger.info('Using DMV Stripe Account configuration');
        secretKeyValue = stripeSecretKeyDmv.value();
      }else if(domain.includes('bishopyounger.com', 'bsyym.onetapgo.site')){
        logger.info('Using Bishopyounger Stripe configuration');
        secretKeyValue = stripeSecretKeyBsyym.value();
      }else if(domain.includes('onetapgo.site')){
        logger.info('Using OneTapGo Default Stripe configuration for onetapgo.site');
        secretKeyValue = stripeSecretKey.value();
      } else {
        logger.info('Using OneTapGo Default Stripe configuration');
        secretKeyValue = stripeSecretKey.value(); 
      }
      
          // 🔐 SECURE: Get Stripe secret key from Firebase v2 Secret Manager
      //const secretKeyValue = stripeSecretKey.value();

      if (!secretKeyValue || secretKeyValue.length === 0) {
        logger.error('Stripe secret key not configured in Secret Manager');
        res.status(500).json({
          success: false,
          error: '🔑 Stripe Secret Key Missing',
          instructions: [
            '1. Configure securely: firebase functions:secrets:set STRIPE_SECRET_KEY',
            '2. Enter your Stripe secret key when prompted (sk_test_...)',
            '3. Deploy: firebase deploy --only functions',
            '4. Your key is stored securely in Google Secret Manager! 🔐'
          ],
          security_note: 'Keys stored in Google Secret Manager - never in source code! 🔐',
          migration_note: 'Updated to Firebase Functions v2 with enhanced security'
        });
        return;
      }

      const stripe = require('stripe')(secretKeyValue);
      const { amount: rawAmount, currency = 'usd', metadata = {}, stripeAccountId, customer = {}, paymentMethodTypes = ['card','apple_pay','google_pay','link','amazon_pay','crypto'] } = req.body;

      // Log incoming request body for debugging discrepancies between UI and Stripe
      logger.info('createPaymentIntent request body:', req.body);

      // Coerce amount to number and normalize to 2 decimal places
      const amount = typeof rawAmount === 'string' ? parseFloat(rawAmount) : rawAmount;
      if (Number.isNaN(amount)) {
        logger.error('Invalid amount received in request:', rawAmount);
        res.status(400).json({ error: 'Invalid amount' });
        return;
      }

      const cents = Math.round(amount * 100);
      const normalizedAmount = cents / 100;
      if (Math.abs(normalizedAmount - amount) > 0.00001) {
        logger.warn('Amount normalized to 2 decimals', { received: amount, normalized: normalizedAmount });
      }

      // Validate currency
      const supportedCurrencies = ['brl', 'usd', 'eur', 'gbp', 'cad', 'aud', 'jpy'];
      if (!supportedCurrencies.includes(currency.toLowerCase())) {
        res.status(400).json({ error: 'Unsupported currency' });
        return;
      }

      if (!amount || amount <= 0) {
        res.status(400).json({ error: 'Invalid amount' });
        return;
      }

      // Extract stripeAccountId from request (from tenant config)
      // Use provided stripeAccountId or fall back to metadata.stripeAccountId
      const accountId = stripeAccountId || metadata.stripeAccountId;

      if (!accountId) {
        logger.error('No stripeAccountId provided in request');
        res.status(400).json({ error: 'Stripe account ID is required' });
        return;
      }

      logger.info('Creating PaymentIntent for Stripe Connect account:', accountId);

      // Create a PaymentIntent with Stripe
      const amountInCents = cents; // already computed above

      // Prepare metadata with stripeAccountId included
      const paymentIntentMetadata = {
        ...metadata,
        stripeAccountId: accountId,
        source: 'OneTapGo Giving Platform',
        currency: currency.toUpperCase(),
      };

      // Add customer specific data to metadata if provided
      // if (customer.name) paymentIntentMetadata.customer_name = customer.name;
      // if (customer.email) paymentIntentMetadata.customer_email = customer.email;

      // // Handle CPF/CNPJ for BRL currency
      // if (currency.toLowerCase() === 'brl' || customer.taxId) {
      //   need to read and implement https://docs.stripe.com/api/tax_ids/customer_create
      // }

      // Add ZIP code if provided
      // if (customer.zipCode) {
      //   paymentIntentMetadata.postal_code = customer.zipCode;
      // }

      //payment_method_types: paymentMethodTypes

      const paymentIntentOptions = {
        amount: amountInCents,
        currency: currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: paymentIntentMetadata,
        
      };

      logger.info('Payment Intent options prepared:', paymentIntentOptions);
      const paymentIntent = await stripe.paymentIntents.create(paymentIntentOptions, { stripeAccount: accountId });

      logger.info('Payment Intent created:', paymentIntentOptions, { paymentIntentId: paymentIntent.id },paymentIntent);

      res.json({
        clientSecret: paymentIntent.client_secret,
      });
    } catch (error) {
      logger.error('Error creating payment intent:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

// Create PIX Charge via Cora
exports.createCoraPixCharge = onRequest(
  {
    cors: true,
    maxInstances: 3,
    secrets: [coraCert, coraKey, coraClientId]
  },
  async (req, res) => {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    try {
      console.log('Creating Cora PIX charge...');
      const cert = coraCert.value();
      const key = coraKey.value();
      const clientId = coraClientId.value(); // Optional, will check if empty

      if (!cert || !key) {
        console.error('Cora certificates not configured');
        res.status(500).json({ error: 'Server configuration error' });
        return;
      }

      const cora = new CoraClient(cert, key, clientId, true);

      const { amount, customer, serviceName, serviceDesc } = req.body;

      // if (!amount || !customer || !customer.name || !customer.document) {
      //   res.status(400).json({ error: 'Missing required fields (amount, customer.name, customer.document)' });
      //   return;
      // }

      const invoice = await cora.createInvoice(amount, customer, serviceName, serviceDesc);

      // Extract PIX info from Cora response
      // Usually in response.payment_options.pix.code or similar
      // Let's assume standard Cora V2 response structure or handle if it's missing
      // Typically: { id, ..., payment_options: { pix: { code: "..." }, bank_slip: { ... } } }

      // Safety check for PIX code
      const pixCode = invoice.pix?.emv || invoice.payment_options?.pix?.code || invoice.pix_emv;

      if (!pixCode) {
        logger.warn('PIX code not found in Cora response', invoice);
        // It might be that the invoice is created but PIX details are elsewhere? 
        // Normally they are in payment_options.
        // We return the whole invoice just in case relevant data is there.
      }

      res.json({
        success: true,
        invoiceId: invoice.id,
        pixCode: pixCode,
        fullResponse: invoice // For debugging/frontend flexibility
      });

    } catch (error) {
      logger.error('Error creating Cora PIX charge:', error);
      res.status(500).json({
        error: 'Failed to create PIX charge',
        details: error.message
      });
    }
  });

// Check PIX Charge status via Cora
exports.checkCoraPixStatus = onRequest(
  {
    cors: true,
    maxInstances: 3,
    secrets: [coraCert, coraKey, coraClientId]
  },
  async (req, res) => {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    try {
      const { invoiceId } = req.body;
      if (!invoiceId) {
        res.status(400).json({ error: 'Missing invoiceId' });
        return;
      }

      const cert = coraCert.value();
      const key = coraKey.value();
      const clientId = coraClientId.value();

      const cora = new CoraClient(cert, key, clientId, true);
      const invoice = await cora.getInvoice(invoiceId);

      res.json({
        success: true,
        status: invoice.status, // OPEN, PAID, CANCELLED, etc.
        invoice: invoice
      });

    } catch (error) {
      logger.error('Error checking Cora PIX status:', error);
      res.status(500).json({
        error: 'Failed to check status',
        details: error.message
      });
    }
  });


// verifyApplePayDomain endpoint
// Programmatically registers and verifies a domain for Apple Pay
// Usage: POST { domain: "example.com", stripeAccountId: "acct_..." }
exports.verifyApplePayDomain = onRequest(
  {
    cors: true,
    maxInstances: 3,
    secrets: [stripeSecretKey]
  },
  async (req, res) => {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    try {
      const { domain = "wasser-c430a.web.app", stripeAccountId = "acct_1SkWViGa44Ztl1iO" } = req.body;
      const stripe = require('stripe')(stripeSecretKey.value());

      logger.info(`🍎 Verifying Apple Pay domain: ${domain} for account: ${stripeAccountId}`);

      const applePayDomain = await stripe.applePayDomains.create({
        domain_name: domain
      }, {
        stripeAccount: stripeAccountId
      });

      logger.info('✅ Apple Pay domain verified successfully:', applePayDomain);
      res.json({ success: true, data: applePayDomain });
    } catch (error) {
      logger.error('💥 Error verifying Apple Pay domain:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        details: 'Ensure the file is available at https://[domain]/.well-known/apple-developer-merchantid-domain-association'
      });
    }
  }
);

// Get Stripe Public Key for Frontend
exports.getStripePublicKey = onRequest(
  {
    cors: true,
    maxInstances: 3,
  },
  async (req, res) => {
    // CORS preflight
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'GET') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    try {
      const db = admin.firestore();
      const domain = req.get('Origin') || req.get('Referer') || ''; // Re-added domain declaration
      const uri = req.path || ''; // Get URI from req.path
      logger.info('getStripePublicKey called from domain:', domain, 'and URI:', uri);

      let tenantSlug = 'default'; // Default tenant

      // Determine tenant based on domain or URI
      // This logic should mirror the one in createPaymentIntent for consistency
      if (domain.includes('rampchurchdmv.onetapgo.site') || domain.includes('rampdmv.web.app') || uri.includes('/rampchurchdmv')) {
        tenantSlug = 'rampchurchdmv';
      } else if (domain.includes('cre8.onetapgo.site') || domain.includes('rcsp.onetapgo.site') || domain.includes('wasser-c430a.web.app') || uri.includes('/cre8onetapgo')) {
        tenantSlug = 'cre8onetapgo';
      } else if (domain.includes('bsyym.onetapgo.site') || domain.includes('bishopyounger.com') || uri.includes('/bishopsyyoungerministries')) {
        tenantSlug = 'bishopsyyoungerministries';
      } else if (domain.includes('rampchurchsp.onetapgo.site') || domain.includes('rcsp.com.br') || uri.includes('/rampchurchsp')) {
        tenantSlug = 'rampchurchsp';
      } else if (domain.includes('syyounger.onetapgo.site') || uri.includes('/syyounger')) {
        tenantSlug = 'syyounger';
      } else if (domain.includes('owci.onetapgo.site') || uri.includes('/onewaychurches')) {
        tenantSlug = 'onewaychurches';
      } else if (domain.includes('onetapgo.site')) {
        tenantSlug = 'default';
      }

      const tenantDoc = await db.collection('tenants').doc(tenantSlug).get();

      if (!tenantDoc.exists) {
        logger.warn(`Tenant config not found for slug: ${tenantSlug}. Falling back to default.`);
        const defaultTenantDoc = await db.collection('tenants').doc('default').get();
        if (defaultTenantDoc.exists && defaultTenantDoc.data().stripePublicKey) {
            res.json({ publicKey: defaultTenantDoc.data().stripePublicKey });
            return;
        }
        throw new Error('Default tenant or public key not found');
      }

      const tenantData = tenantDoc.data();
      if (!tenantData.stripePublicKey) {
        logger.warn(`stripePublicKey not found for tenant: ${tenantSlug}. Falling back to default.`);
         const defaultTenantDoc = await db.collection('tenants').doc('default').get();
        if (defaultTenantDoc.exists && defaultTenantDoc.data().stripePublicKey) {
            res.json({ publicKey: defaultTenantDoc.data().stripePublicKey });
            return;
        }
        throw new Error('Public key not found for tenant and default also missing');
      }

      res.json({ publicKey: tenantData.stripePublicKey });

    } catch (error) {
      logger.error('Error fetching Stripe Public Key:', error);
      res.status(500).json({ error: 'Internal server error fetching public key' });
    }
  }
);

// One-time Seed Function
exports.iotSeed = onRequest({ cors: true, maxInstances: 1 }, async (req, res) => {
  try {
    const clients = [
      { id: 'default', name: 'OneTapGo (Default)', base_url: 'https://onetapgo.site' },
      { id: 'the-ramp', name: 'The Ramp Church', base_url: 'https://theramp.com.br' }
    ];
    for (const c of clients) {
      await admin.firestore().collection('clients').doc(c.id).set({
        name: c.name, base_url: c.base_url, created_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    res.send("Seed OK! Clientes criados.");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// IoT Unified Router (Sync, Event, Redirect)
// Consolidating to single function to bypass CPU Quota limits
exports.iotRouter = onRequest({ cors: true, maxInstances: 5, memory: "256MiB" }, async (req, res) => {
    const path = req.path;
    const db = admin.firestore();

    try {
    const reportingSettings = await getReportingSettings(db);
    const getHeader = (name) => {
        const value = req.get(name);
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    };

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const toSerializableValue = (value) => {
        if (value == null) return undefined;
        if (Array.isArray(value)) {
            const normalized = value
                .map((entry) => entry == null ? undefined : String(entry).trim())
                .filter(Boolean);
            return normalized.length > 0 ? normalized.join(', ') : undefined;
        }
        if (['string', 'number', 'boolean'].includes(typeof value)) {
            const normalized = String(value).trim();
            return normalized.length > 0 ? normalized : undefined;
        }
        if (value instanceof Date) {
            return value.toISOString();
        }
        return undefined;
    };

    const flattenPrimitiveEntries = (source, prefix) => {
        if (!source || typeof source !== 'object') return {};

        return Object.entries(source).reduce((accumulator, [key, rawValue]) => {
            const value = toSerializableValue(rawValue);
            if (value === undefined) return accumulator;

            const normalizedKey = `${prefix}_${key}`
                .replace(/[^a-zA-Z0-9_]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '')
                .toLowerCase();

            if (normalizedKey) {
                accumulator[normalizedKey] = value;
            }
            return accumulator;
        }, {});
    };

    const buildDistinctId = ({ tagId, routeType, tenant }) => {
        const explicitId = getHeader('X-PostHog-Distinct-Id')
            || getHeader('X-GA-Client-ID')
            || toSerializableValue(req.query?.ph_distinct_id)
            || toSerializableValue(req.query?.distinct_id)
            || toSerializableValue(req.query?.cid);

        if (explicitId) {
            return explicitId;
        }

        const fingerprintSource = [
            tagId || 'auto',
            routeType || 'unknown',
            tenant || 'fallback',
            req.ip || '',
            getHeader('User-Agent') || '',
            getHeader('Accept-Language') || '',
            getHeader('X-Forwarded-For') || ''
        ].join('|');

        return `scan_${createHash('sha256').update(fingerprintSource).digest('hex').slice(0, 32)}`;
    };

    const buildScanContext = ({
        tagId,
        tenant,
        targetUrl,
        redirectSource,
        routeType,
        fallbackUsed = false,
        tagFound = false,
        tagData = {},
        statusCode = 200,
        reportingIgnored = false
    }) => {
        const host = getHeader('host') || req.hostname || 'onetapgo.site';
        const protocol = getHeader('x-forwarded-proto') || req.protocol || 'https';
        const origin = `${protocol}://${host}`;
        let resolvedDestination;
        try {
            resolvedDestination = new URL(targetUrl || '/', origin);
        } catch (error) {
            resolvedDestination = new URL('/', origin);
        }
        const queryEntries = flattenPrimitiveEntries(req.query, 'query');
        const tagEntries = flattenPrimitiveEntries(tagData, 'tag');
        const rawQuery = req.originalUrl?.includes('?') ? req.originalUrl.split('?').slice(1).join('?') : '';

        const properties = {
            event_origin: 'firebase_function',
            route_type: routeType,
            tag_id: tagId || 'auto_redirect',
            tenant: tenant || 'fallback',
            client_slug: tenant || 'fallback',
            redirect_source: redirectSource,
            redirect_url: resolvedDestination.toString(),
            redirect_host: resolvedDestination.host,
            redirect_pathname: resolvedDestination.pathname,
            redirect_search: resolvedDestination.search,
            status_code: statusCode,
            fallback_used: fallbackUsed,
            tag_found: tagFound,
            scan_method: req.method,
            scan_path: req.path,
            scan_original_url: req.originalUrl || req.url,
            scan_query_string: rawQuery,
            scan_protocol: protocol,
            scan_host: host,
            scan_hostname: req.hostname,
            scan_ip: req.ip,
            user_agent: getHeader('User-Agent'),
            referer: getHeader('Referer'),
            origin: getHeader('Origin'),
            accept_language: getHeader('Accept-Language'),
            x_forwarded_for: getHeader('X-Forwarded-For'),
            x_forwarded_host: getHeader('X-Forwarded-Host'),
            x_forwarded_proto: getHeader('X-Forwarded-Proto'),
            x_cloud_trace_context: getHeader('X-Cloud-Trace-Context'),
            sec_ch_ua: getHeader('Sec-CH-UA'),
            sec_ch_ua_mobile: getHeader('Sec-CH-UA-Mobile'),
            sec_ch_ua_platform: getHeader('Sec-CH-UA-Platform'),
            request_id: getHeader('Function-Execution-Id') || randomUUID(),
            scan_medium: routeType === 'go_redirect' ? 'qr_or_link' : 'nfc_or_qrcode',
            reporting_ignored: reportingIgnored
        };

        return {
            distinctId: buildDistinctId({ tagId, routeType, tenant }),
            properties: {
                ...properties,
                ...queryEntries,
                ...tagEntries
            }
        };
    };

    const addUtmParameters = (url, tagId, campaign) => {
        if (!url) return url;
        const timestamp = new Date().toISOString();
        const utmParams = new URLSearchParams({
            utm_source: "onetapgo",
            utm_medium: "nfc",
            utm_campaign: campaign || "fallback",
            utm_content: tagId || "unknown",
            utm_timestamp: timestamp
        });

        const joinChar = url.includes("?") ? "&" : "?";
        return `${url.trim()}${joinChar}${utmParams.toString()}`;
    };

    const sendGa4Event = async (tagId, campaign, req) => {
        const measurementId = "G-CD3HYBNK3E";
        const apiSecret = "8uma_U7XQICmqOb_z33H9w";
        const axios = require('axios');
        const { v4: uuidv4 } = require('uuid');

        try {
            const clientId = req.get('X-GA-Client-ID') || uuidv4();
            const payload = {
                client_id: clientId,
                debug_mode: true,
                events: [{
                    name: 'tag_scan',
                    params: {
                        tag_id: tagId,
                        campaign: campaign,
                        source: 'onetapgo',
                        medium: 'nfc',
                        ip_address: req.ip,
                        user_agent: req.get('User-Agent'),
                        engagement_time_msec: '1',
                        session_id: clientId
                    }
                }]
            };

            await axios.post(
                `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}&debug_mode=true`,
                payload
            );
            logger.info("GA4 event sent successfully (debug mode)", { tagId, campaign });
        } catch (error) {
            logger.error("Error sending GA4 event", error.message);
        }
    };

    const sendPosthogEvent = async (context) => {
        if (!POSTHOG_API_KEY) {
            logger.warn('PostHog disabled: missing POSTHOG_API_KEY');
            return;
        }

        if (context.properties?.reporting_ignored === true) {
            logger.info('PostHog redirect_scan skipped for ignored tag', {
                tagId: context.properties?.tag_id,
                routeType: context.properties?.route_type
            });
            return;
        }

        const posthog = new PostHog(POSTHOG_API_KEY, {
            host: POSTHOG_HOST,
            flushAt: 1,
            flushInterval: 0,
            requestTimeout: 3000
        });

        try {
            posthog.capture({
                distinctId: context.distinctId,
                event: 'redirect_scan',
                properties: context.properties
            });
            await posthog._shutdown(3000);
            logger.info('PostHog redirect_scan sent successfully', {
                distinctId: context.distinctId,
                routeType: context.properties.route_type,
                tagId: context.properties.tag_id
            });
        } catch (error) {
            logger.error('Error sending PostHog event', error.message || error);
        }
    };

    const renderRedirectPage = ({
        destinationUrl,
        message = 'Aguarde, estamos redirecionando voce...',
        title = 'Redirecionando...'
    }) => {
        const escapedDestination = escapeHtml(destinationUrl);
        const escapedMessage = escapeHtml(message);
        const escapedTitle = escapeHtml(title);

        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapedTitle}</title>
  <meta http-equiv="refresh" content="0;url=${escapedDestination}">
  <style>
    :root { color-scheme: light; --bg:#f7f7f5; --ink:#161616; --muted:#6a6a6a; --card:#ffffff; --line:#e8e8e3; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:var(--bg); color:var(--ink); }
    main { width:min(420px,100%); background:var(--card); border:1px solid var(--line); border-radius:20px; padding:28px 24px; text-align:center; box-shadow:0 8px 30px rgba(0,0,0,.04); }
    h1 { margin:0 0 10px; font-size:clamp(1.25rem,3vw,1.6rem); font-weight:600; letter-spacing:-.02em; }
    p { margin:0; line-height:1.55; }
    a { color:inherit; word-break:break-word; }
    .spinner { width:28px; height:28px; margin:0 auto 16px; border-radius:999px; border:2px solid var(--line); border-top-color:var(--ink); animation:spin .7s linear infinite; }
    .hint { margin-top:14px; color:var(--muted); font-size:.92rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main>
    <div class="spinner" aria-hidden="true"></div>
    <h1>${escapedTitle}</h1>
    <p>${escapedMessage}</p>
    <p class="hint">Se o redirecionamento nao acontecer automaticamente, acesse <a href="${escapedDestination}" rel="noopener noreferrer">${escapedDestination}</a>.</p>
  </main>
  <script>
    window.location.replace(${JSON.stringify(destinationUrl)});
    setTimeout(function () {
      window.location.replace(${JSON.stringify(destinationUrl)});
    }, 40);
  </script>
</body>
</html>`;
    };

    const respondWithTrackedRedirect = async ({
        destinationUrl,
        tagId,
        tenant,
        redirectSource,
        routeType,
        fallbackUsed = false,
        tagFound = false,
        tagData = {}
    }) => {
        const redirectedUrl = addUtmParameters(destinationUrl, tagId, tenant);
        const reportingIgnored = isIgnoredTagForReporting(tagId, reportingSettings);
        const scanContext = buildScanContext({
            tagId,
            tenant,
            targetUrl: redirectedUrl,
            redirectSource,
            routeType,
            fallbackUsed,
            tagFound,
            tagData,
            statusCode: 200,
            reportingIgnored
        });

        Promise.allSettled([
            sendGa4Event(tagId || 'auto_redirect', tenant || 'fallback', req),
            sendPosthogEvent(scanContext)
        ]).catch((error) => {
            logger.warn('Background redirect analytics failed', {
                tagId,
                error: error.message || error
            });
        });

        res.status(200).set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        return res.send(renderRedirectPage({
            destinationUrl: redirectedUrl
        }));
    };

        // 1. Handling Sync (?deviceId=...)
        if (path.includes('/sync')) {
            const { deviceId } = req.query;
            if (!deviceId) return res.status(400).send("Missing deviceId");

            const deviceRef = db.collection('devices').doc(deviceId);
            const doc = await deviceRef.get();
            await deviceRef.set({ last_seen: admin.firestore.FieldValue.serverTimestamp(), status: 'online' }, { merge: true });

            if (!doc.exists) {
                const defaultConfig = { mode: "RECORDER", target_client_slug: "default" };
                await deviceRef.set({ label: "Novo Dispositivo", config: defaultConfig }, { merge: true });
                return res.json(defaultConfig);
            }

            return res.json(doc.data().config || {});
        }

        // 2. Handling Event (POST payload)
        if (path.includes('/event')) {
            const { device_id, uid, action, success, mode_executed } = req.body;
            if (!device_id || !uid) return res.status(400).send("Missing payload");

            const batch = db.batch();
            const deviceRef = db.collection('devices').doc(device_id);

            batch.set(deviceRef, {
                live_feedback: {
                    last_uid: uid,
                    last_result: success ? 'SUCCESS' : 'ERROR',
                    message: success ? `Tag ${uid} vinculada (${mode_executed})` : "Falha no processo",
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                }
            }, { merge: true });

            if (success && mode_executed === 'RECORDER') {
                const deviceDoc = await deviceRef.get();
                const client_slug = deviceDoc.data()?.config?.target_client_slug || "default";
                const tagIdentity = buildCanonicalTagIdentity(client_slug) || buildCanonicalTagIdentity("default");
                const tagRef = db.collection('tags').doc(uid);
                batch.set(tagRef, {
                    uid,
                    ...tagIdentity,
                    ...buildLegacyTagIdentityCleanup(),
                    provisioned_by: device_id,
                    provisioned_at: admin.firestore.FieldValue.serverTimestamp(),
                    status: 'active'
                }, { merge: true });
            }
            await batch.commit();
            return res.json({ success: true });
        }

        // 3. Handling Redirects for /a and /go
        if (path.startsWith('/a')) {
            const parts = path.split('/').filter(Boolean);
            const id = parts[1];

            if (id) {
                // Handle /a/:id
                const tagDoc = await db.collection('tags').doc(id).get();
                if (tagDoc.exists) {
                    const tagData = tagDoc.data();
                    await tagDoc.ref.update({
                        scan_count: admin.firestore.FieldValue.increment(1),
                        last_scan_at: admin.firestore.FieldValue.serverTimestamp(),
                        updated_at: admin.firestore.FieldValue.serverTimestamp()
                    });

                    const tenant = resolveTagTenant(tagData);
                    const targetUrl = [
                        tagData.redirect_url,
                        tagData.redirect_override,
                        tagData.target_url,
                        tagData.url,
                        tagData.redirectUrl
                    ].find((value) => typeof value === 'string' && value.trim().length > 0);

                    if (targetUrl) {
                        console.info(`Redirecting tag ${id} to URL: ${targetUrl} with tenant: ${tenant}`);
                        return respondWithTrackedRedirect({
                            destinationUrl: targetUrl,
                            tagId: id,
                            tenant,
                            redirectSource: 'tag_redirect_url',
                            routeType: 'tag_redirect',
                            tagFound: true,
                            tagData
                        });
                    }

                    if (tenant && tenant !== "fallback") {
                        const clientDoc = await db.collection('clients').doc(tenant).get();
                        const clientBaseUrl = clientDoc.data()?.base_url;
                        if (typeof clientBaseUrl === 'string' && clientBaseUrl.trim().length > 0) {
                            console.info(`Redirecting tag ${id} to client's base URL: ${clientBaseUrl} with tenant: ${tenant}`);
                            return respondWithTrackedRedirect({
                                destinationUrl: clientBaseUrl,
                                tagId: id,
                                tenant,
                                redirectSource: 'client_base_url',
                                routeType: 'tag_redirect',
                                tagFound: true,
                                tagData
                            });
                        }
                    }
                }
                // If tag not found or has no URL, use fallback
                const fallbackDoc = await db.doc('site_config/fallback').get();
                const fallbackUrl = fallbackDoc.exists ? fallbackDoc.data().url : '/';
                console.info(`Tag ${id} not found or no URL. Redirecting to fallback: ${fallbackUrl}`);
                return respondWithTrackedRedirect({
                    destinationUrl: fallbackUrl,
                    tagId: id || 'unknown',
                    tenant: 'fallback',
                    redirectSource: 'fallback',
                    routeType: 'tag_redirect',
                    fallbackUsed: true,
                    tagFound: false
                });

            } else {
                // Handle /a (same as old redirectAuto)
                const doc = await db.doc('site_config/auto_redirect').get();
                if (doc.exists && doc.data().url) {
                    const { url } = doc.data();
                    return respondWithTrackedRedirect({
                        destinationUrl: url,
                        tagId: 'auto_redirect',
                        tenant: 'fallback',
                        redirectSource: 'auto_redirect',
                        routeType: 'auto_redirect',
                        tagFound: true,
                        tagData: doc.data()
                    });
                }
                return respondWithTrackedRedirect({
                    destinationUrl: '/',
                    tagId: 'auto_redirect',
                    tenant: 'fallback',
                    redirectSource: 'auto_redirect_fallback',
                    routeType: 'auto_redirect',
                    fallbackUsed: true,
                    tagFound: false
                }); // Default fallback
            }
        }

        if (path.startsWith('/go/')) {
            const parts = path.split('/').filter(p => p && p !== 'go');
            if (parts.length < 2) return res.redirect(302, '/');
            const [slug, uid] = parts;

            const tagDoc = await db.collection('tags').doc(uid).get();
            let target_url = '/';

            if (tagDoc.exists) {
                const tagData = tagDoc.data();
                await tagDoc.ref.update({
                    scan_count: admin.firestore.FieldValue.increment(1),
                    last_scan_at: admin.firestore.FieldValue.serverTimestamp(),
                    updated_at: admin.firestore.FieldValue.serverTimestamp()
                });
                const clientDoc = await db.collection('clients').doc(slug).get();
                target_url = tagData.redirect_override || clientDoc.data()?.base_url || '/';
                return respondWithTrackedRedirect({
                    destinationUrl: target_url,
                    tagId: uid,
                    tenant: slug,
                    redirectSource: tagData.redirect_override ? 'tag_redirect_override' : 'client_base_url',
                    routeType: 'go_redirect',
                    tagFound: true,
                    tagData
                });
            } else {
                const clientDoc = await db.collection('clients').doc(slug).get();
                target_url = clientDoc.data()?.base_url || '/';
                return respondWithTrackedRedirect({
                    destinationUrl: target_url,
                    tagId: uid,
                    tenant: slug,
                    redirectSource: clientDoc.exists ? 'client_base_url' : 'go_fallback',
                    routeType: 'go_redirect',
                    fallbackUsed: !clientDoc.exists,
                    tagFound: false
                });
            }
        }

        res.status(404).send("IoT Path Not Found");
    } catch (error) {
        logger.error("iotRouter error:", error);
        res.status(500).send(error.message);
    }
});

exports.seedTenantsFunction = onRequest({ cors: true, maxInstances: 1 }, async (req, res) => {
  // Handle CORS preflight
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); // Allow GET for simple triggering
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    // You might want to add authentication/authorization here in a production environment
    // For now, it's a simple trigger.
    await seedTenants();
    res.status(200).send('Tenant seeding initiated successfully!');
  } catch (error) {
    logger.error('Error in seedTenantsFunction:', error);
    res.status(500).send(`Error seeding tenants: ${error.message}`);
  }
});

// Get Tenant details by slug
exports.getTenantBySlug = onRequest(
  {
    cors: true,
    maxInstances: 2,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    try {
      const slug = req.query.slug || req.body.slug;

      if (!slug) {
        logger.warn('getTenantBySlug: Missing slug parameter');
        return res.status(400).json({ error: 'Slug is required' });
      }

      logger.info(`Fetching tenant details for slug: ${slug}`);
      const db = admin.firestore();
      const tenantDoc = await db.collection('tenants').doc(slug).get();

      if (!tenantDoc.exists) {
        logger.warn(`Tenant not found: ${slug}`);
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const tenantData = tenantDoc.data();
      
      return res.json({
        success: true,
        tenant: {
          slug: slug,
          ...tenantData
        }
      });

    } catch (error) {
      logger.error('Error in getTenantBySlug:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

function sanitizeSlug(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

function normalizePaymentMethods(paymentMethods = {}) {
  const primary = Array.isArray(paymentMethods.primary) ? paymentMethods.primary : [];
  const secondary = Array.isArray(paymentMethods.secondary) ? paymentMethods.secondary : [];

  return { primary, secondary };
}

function sanitizeSectorId(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '');
}

function normalizeSectors(sectors) {
  if (!Array.isArray(sectors) || sectors.length === 0) {
    return [
      {
        internal: 'default',
        name: 'Padrao'
      }
    ];
  }

  return sectors
    .map((sector) => {
      const internal = sanitizeSectorId(sector?.internal || sector?.id || '');
      const name = typeof sector?.name === 'string' ? sector.name.trim() : '';

      if (!internal || !name) {
        return null;
      }

      return { internal, name };
    })
    .filter(Boolean);
}

function validateSectors(sectors) {
  if (sectors == null) {
    return null;
  }

  if (!Array.isArray(sectors)) {
    return 'sectors must be an array';
  }

  const invalidSector = sectors.some((sector) => {
    const internal = sanitizeSectorId(sector?.internal || sector?.id || '');
    return !sector || !internal || typeof sector.name !== 'string' || !sector.name.trim();
  });

  if (invalidSector) {
    return 'each sectors item must include non-empty fields: internal and name';
  }

  return null;
}

async function ensureTenantSectors({ tenantRef, sectors }) {
  const sectorsCollection = tenantRef.collection('sectors');
  const normalizedSectors = normalizeSectors(sectors);
  const existingSectors = await sectorsCollection.get();
  const existingSectorIds = new Set(existingSectors.docs.map((doc) => doc.id));

  if ((sectors == null || sectors.length === 0) && !existingSectors.empty) {
    return existingSectors.docs.map((doc) => ({ internal: doc.id, ...doc.data() }));
  }

  await Promise.all(
    normalizedSectors.map((sector) => {
      const payload = existingSectorIds.has(sector.internal) ?
        { name: sector.name } :
        {
          name: sector.name,
          created_at: '',
        };

      return sectorsCollection.doc(sector.internal).set(payload, { merge: true });
    })
  );

  const updatedSectors = await sectorsCollection.get();
  return updatedSectors.docs.map((doc) => ({ internal: doc.id, ...doc.data() }));
}

function validateGivingOptions(givingOptions) {
  if (!Array.isArray(givingOptions) || givingOptions.length === 0) {
    return 'givingOptions must be a non-empty array';
  }

  const hasInvalidOption = givingOptions.some((option) => {
    return !option ||
      typeof option.id !== 'string' ||
      typeof option.label !== 'string' ||
      typeof option.value !== 'string' ||
      !option.id.trim() ||
      !option.label.trim() ||
      !option.value.trim();
  });

  return hasInvalidOption ?
    'each givingOptions item must include non-empty string fields: id, label, value' :
    null;
}

function normalizeTenantTagUrl(value = '') {
  return String(value).trim();
}

function sanitizeAuditField(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isValidHttpUrl(value = '') {
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

async function fetchTagsByTenant(db, tenant) {
  const snapshots = await Promise.all([
    db.collection('tags').where('tenant', '==', tenant).get(),
    db.collection('tags').where('tenantId', '==', tenant).get(),
  ]);
  const docsById = new Map();

  snapshots.forEach((snapshot) => {
    snapshot.docs.forEach((doc) => docsById.set(doc.id, doc));
  });

  return Array.from(docsById.values());
}

async function fetchTagsByTenantAndSector(db, tenant, sector) {
  const docs = await fetchTagsByTenant(db, tenant);
  return docs.filter((doc) => tagMatchesSector(doc, sector));
}

async function fetchTagsByIds(db, ids) {
  const uniqueIds = Array.from(new Set(
    (Array.isArray(ids) ? ids : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  ));

  const docs = await Promise.all(
    uniqueIds.map((id) => db.collection('tags').doc(id).get())
  );

  const foundDocs = docs.filter((doc) => doc.exists);
  const foundIds = new Set(foundDocs.map((doc) => doc.id));
  const missingIds = uniqueIds.filter((id) => !foundIds.has(id));

  return {
    foundDocs,
    missingIds,
    requestedIds: uniqueIds,
  };
}

async function updateTenantTagsInChunks({ db, tagDocs, payloadFactory }) {
  const chunkSize = 450;
  let updatedCount = 0;

  for (let index = 0; index < tagDocs.length; index += chunkSize) {
    const chunk = tagDocs.slice(index, index + chunkSize);
    const batch = db.batch();

    chunk.forEach((tagDoc) => {
      batch.set(tagDoc.ref, payloadFactory(tagDoc), { merge: true });
    });

    await batch.commit();
    updatedCount += chunk.length;
  }

  return updatedCount;
}

function getTagUrlUpdateField(rawField) {
  const targetField = sanitizeAuditField(rawField || 'redirect_url') || 'redirect_url';
  const allowedFields = new Set(['redirect_url', 'redirect_override', 'target_url', 'url', 'redirecturl']);

  if (!allowedFields.has(targetField)) {
    return null;
  }

  return targetField === 'redirecturl' ? 'redirectUrl' : targetField;
}

function buildRequestMetadata(req) {
  return {
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') || null,
    origin: req.get('origin') || null,
    referer: req.get('referer') || null,
    method: req.method,
    path: req.path,
  };
}

function normalizeSectorSchedule(schedule = {}, index = 0) {
  const url = getScheduleUrl(schedule);
  const rawDate = typeof schedule.date === 'string' && schedule.date.trim() ?
    schedule.date.trim() :
    (typeof schedule.specificDate === 'string' && schedule.specificDate.trim() ? schedule.specificDate.trim() : null);
  const rawDays = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek :
    (Array.isArray(schedule.weekdays) ? schedule.weekdays : []);
  const daysOfWeek = rawDays
    .map((day) => normalizeScheduleWeekday(day))
    .filter((day) => Number.isInteger(day));
  const startTime = typeof schedule.startTime === 'string' && schedule.startTime.trim() ?
    schedule.startTime.trim() :
    (typeof schedule.time === 'string' && schedule.time.trim() ? schedule.time.trim() : '00:00');
  const endTime = typeof schedule.endTime === 'string' && schedule.endTime.trim() ?
    schedule.endTime.trim() :
    null;
  const id = typeof schedule.id === 'string' && schedule.id.trim() ?
    sanitizeAuditField(schedule.id) :
    `schedule_${index + 1}`;

  if (!url || !isValidHttpUrl(url)) {
    return { error: `schedules[${index}].url must be a valid http or https URL` };
  }

  if (!rawDate && daysOfWeek.length === 0) {
    return { error: `schedules[${index}] must include date or daysOfWeek` };
  }

  if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return { error: `schedules[${index}].date must use YYYY-MM-DD` };
  }

  if (!/^\d{1,2}:\d{2}$/.test(startTime) || parseScheduleTime(startTime, -1) < 0) {
    return { error: `schedules[${index}].startTime must use HH:mm` };
  }

  if (endTime && (!/^\d{1,2}:\d{2}$/.test(endTime) || parseScheduleTime(endTime, -1) < 0)) {
    return { error: `schedules[${index}].endTime must use HH:mm` };
  }

  const normalized = {
    id,
    url,
    active: schedule.active !== false && schedule.enabled !== false,
    startTime,
    priority: Number.isFinite(Number(schedule.priority)) ? Number(schedule.priority) : 0,
  };

  if (endTime) {
    normalized.endTime = endTime;
  }

  if (rawDate) {
    normalized.date = rawDate;
    normalized.type = 'date';
  } else {
    normalized.daysOfWeek = Array.from(new Set(daysOfWeek)).sort((left, right) => left - right);
    normalized.type = 'weekly';
  }

  return { schedule: normalized };
}

function normalizeSectorSchedules(rawSchedules) {
  if (rawSchedules == null) {
    return { schedules: null };
  }

  if (!Array.isArray(rawSchedules)) {
    return { error: 'schedules must be an array' };
  }

  const schedules = [];
  for (let index = 0; index < rawSchedules.length; index += 1) {
    const result = normalizeSectorSchedule(rawSchedules[index], index);
    if (result.error) {
      return { error: result.error };
    }
    schedules.push(result.schedule);
  }

  return { schedules };
}

function serializeSectorRedirect(doc, tagCount = null) {
  const data = doc.data() || {};
  const directUrl = getDirectSectorRedirectUrl(data);
  const activeSchedule = pickActiveSectorSchedule(data.schedules);

  return {
    id: doc.id,
    internal: doc.id,
    name: data.name || null,
    redirect_url: data.redirect_url || null,
    redirectUrl: data.redirectUrl || null,
    target_url: data.target_url || null,
    url: data.url || null,
    active: data.active !== false && data.enabled !== false,
    schedules: Array.isArray(data.schedules) ? data.schedules : [],
    activeDestinationUrl: activeSchedule?.url || directUrl || null,
    activeRedirectSource: activeSchedule ? `sector_${activeSchedule.type}_schedule` : (directUrl ? 'sector_redirect_url' : null),
    activeScheduleId: activeSchedule?.scheduleId || null,
    tagCount,
    updatedAt: parseFirestoreTimestamp(data.updatedAt) || parseFirestoreTimestamp(data.updated_at),
    createdAt: parseFirestoreTimestamp(data.createdAt) || parseFirestoreTimestamp(data.created_at),
  };
}

exports.updateTenantTagUrl = onRequest(
  {
    cors: true,
    maxInstances: 2,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.set('Allow', 'POST, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const db = admin.firestore();
    const rawTenant = req.body?.tenant || req.query?.tenant;
    const tenant = sanitizeTenantLookup(rawTenant);
    const newUrl = normalizeTenantTagUrl(
      req.body?.newUrl || req.body?.url || req.body?.redirectUrl || req.query?.newUrl || req.query?.url
    );
    const normalizedTargetField = getTagUrlUpdateField(req.body?.field || req.query?.field);

    if (!tenant) {
      return res.status(400).json({ error: 'tenant is required' });
    }

    if (!newUrl) {
      return res.status(400).json({ error: 'newUrl is required' });
    }

    if (!isValidHttpUrl(newUrl)) {
      return res.status(400).json({ error: 'newUrl must be a valid http or https URL' });
    }

    if (!normalizedTargetField) {
      return res.status(400).json({ error: 'field must be one of: redirect_url, redirect_override, target_url, url, redirectUrl' });
    }

    const auditRef = db.collection('tag_url_audits').doc();
    const requestMetadata = {
      ipAddress: req.ip || null,
      userAgent: req.get('user-agent') || null,
      origin: req.get('origin') || null,
      referer: req.get('referer') || null,
      method: req.method,
      path: req.path,
    };

    try {
      const tagDocs = await fetchTagsByTenant(db, tenant);

      if (tagDocs.length === 0) {
        await auditRef.set({
          action: 'update_tenant_tag_url',
          status: 'no_tags_found',
          tenant,
          newUrl,
          targetField: normalizedTargetField,
          matchedTags: 0,
          updatedTags: 0,
          sampleTagIds: [],
          samplePreviousValues: [],
          requestMetadata,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(404).json({
          success: false,
          error: 'No tags found for tenant',
          tenant,
          auditId: auditRef.id,
        });
      }

      const samplePreviousValues = tagDocs.slice(0, 20).map((tagDoc) => ({
        id: tagDoc.id,
        previousValue: tagDoc.data()?.[normalizedTargetField] || null,
      }));

      const updatedCount = await updateTenantTagsInChunks({
        db,
        tagDocs,
        payloadFactory: () => ({
          [normalizedTargetField]: newUrl,
          ...buildLegacyTagIdentityCleanup(),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
      });

      await auditRef.set({
        action: 'update_tenant_tag_url',
        status: 'success',
        tenant,
        newUrl,
        targetField: normalizedTargetField,
        matchedTags: tagDocs.length,
        updatedTags: updatedCount,
        sampleTagIds: tagDocs.slice(0, 100).map((tagDoc) => tagDoc.id),
        samplePreviousValues,
        requestMetadata,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info('Tenant tag URLs updated successfully', {
        tenant,
        targetField: normalizedTargetField,
        updatedTags: updatedCount,
        auditId: auditRef.id,
      });

      return res.status(200).json({
        success: true,
        tenant,
        newUrl,
        field: normalizedTargetField,
        matchedTags: tagDocs.length,
        updatedTags: updatedCount,
        auditId: auditRef.id,
      });
    } catch (error) {
      logger.error('Error updating tenant tag URLs:', error);

      await auditRef.set({
        action: 'update_tenant_tag_url',
        status: 'error',
        tenant,
        newUrl,
        targetField: normalizedTargetField,
        error: error.message || 'Unknown error',
        requestMetadata,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        auditId: auditRef.id,
      });
    }
  }
);

exports.updateTagUrlByIds = onRequest(
  {
    cors: true,
    maxInstances: 2,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.set('Allow', 'POST, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const db = admin.firestore();
    const ids = req.body?.ids;
    const newUrl = normalizeTenantTagUrl(
      req.body?.newUrl || req.body?.url || req.body?.redirectUrl || req.query?.newUrl || req.query?.url
    );
    const normalizedTargetField = getTagUrlUpdateField(req.body?.field || req.query?.field);

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }

    if (!newUrl) {
      return res.status(400).json({ error: 'newUrl is required' });
    }

    if (!isValidHttpUrl(newUrl)) {
      return res.status(400).json({ error: 'newUrl must be a valid http or https URL' });
    }

    if (!normalizedTargetField) {
      return res.status(400).json({ error: 'field must be one of: redirect_url, redirect_override, target_url, url, redirectUrl' });
    }

    const auditRef = db.collection('tag_url_audits').doc();
    const requestMetadata = {
      ipAddress: req.ip || null,
      userAgent: req.get('user-agent') || null,
      origin: req.get('origin') || null,
      referer: req.get('referer') || null,
      method: req.method,
      path: req.path,
    };

    try {
      const { foundDocs, missingIds, requestedIds } = await fetchTagsByIds(db, ids);

      if (foundDocs.length === 0) {
        await auditRef.set({
          action: 'update_tag_url_by_ids',
          status: 'no_tags_found',
          requestedIds,
          missingIds,
          newUrl,
          targetField: normalizedTargetField,
          matchedTags: 0,
          updatedTags: 0,
          sampleTagIds: [],
          samplePreviousValues: [],
          requestMetadata,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(404).json({
          success: false,
          error: 'No tags found for provided ids',
          missingIds,
          auditId: auditRef.id,
        });
      }

      const samplePreviousValues = foundDocs.slice(0, 20).map((tagDoc) => ({
        id: tagDoc.id,
        previousValue: tagDoc.data()?.[normalizedTargetField] || null,
      }));

      const updatedCount = await updateTenantTagsInChunks({
        db,
        tagDocs: foundDocs,
        payloadFactory: () => ({
          [normalizedTargetField]: newUrl,
          ...buildLegacyTagIdentityCleanup(),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
      });

      await auditRef.set({
        action: 'update_tag_url_by_ids',
        status: 'success',
        requestedIds,
        missingIds,
        newUrl,
        targetField: normalizedTargetField,
        matchedTags: foundDocs.length,
        updatedTags: updatedCount,
        sampleTagIds: foundDocs.slice(0, 100).map((tagDoc) => tagDoc.id),
        samplePreviousValues,
        requestMetadata,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(200).json({
        success: true,
        ids: requestedIds,
        missingIds,
        newUrl,
        field: normalizedTargetField,
        matchedTags: foundDocs.length,
        updatedTags: updatedCount,
        auditId: auditRef.id,
      });
    } catch (error) {
      logger.error('Error updating tag URLs by ids:', error);

      await auditRef.set({
        action: 'update_tag_url_by_ids',
        status: 'error',
        requestedIds: Array.isArray(ids) ? ids : [],
        newUrl,
        targetField: normalizedTargetField,
        error: error.message || 'Unknown error',
        requestMetadata,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        auditId: auditRef.id,
      });
    }
  }
);

exports.assignTagSector = onRequest(
  {
    cors: true,
    maxInstances: 2,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.set('Allow', 'POST, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const db = admin.firestore();
    const tenant = sanitizeTenantLookup(req.body?.tenant || req.body?.tenantId || req.body?.slug || req.body?.client_slug || req.body?.clientSlug);
    const ids = req.body?.ids;
    const sector = sanitizeSectorId(req.body?.sector || req.body?.setor);
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : null;

    if (!tenant) {
      return res.status(400).json({ success: false, error: 'tenant is required' });
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }

    if (!sector) {
      return res.status(400).json({ error: 'sector is required' });
    }

    const auditRef = db.collection('tag_url_audits').doc();
    const requestMetadata = buildRequestMetadata(req);

    try {
      const { foundDocs, missingIds, requestedIds } = await fetchTagsByIds(db, ids);

      // Filter tags that belong to the requested tenant
      const tenantMatchedDocs = foundDocs.filter((doc) => {
        const data = doc.data() || {};
        return data.tenant === tenant || data.tenantId === tenant;
      });

      const tenantUnmatchedIds = foundDocs
        .filter((doc) => !tenantMatchedDocs.includes(doc))
        .map((doc) => doc.id);

      const allMissingIds = [...new Set([...missingIds, ...tenantUnmatchedIds])];

      if (tenantMatchedDocs.length === 0) {
        await auditRef.set({
          action: 'assign_tag_sector',
          status: 'no_tags_found',
          tenant,
          sector,
          requestedIds,
          missingIds: allMissingIds,
          matchedTags: 0,
          updatedTags: 0,
          requestMetadata,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(404).json({
          success: false,
          error: 'No tags found for the provided ids and tenant',
          missingIds: allMissingIds,
          auditId: auditRef.id,
        });
      }

      // Update matched tags with sector
      const chunkSize = 450;
      let updatedCount = 0;

      for (let index = 0; index < tenantMatchedDocs.length; index += chunkSize) {
        const chunk = tenantMatchedDocs.slice(index, index + chunkSize);
        const batch = db.batch();

        chunk.forEach((tagDoc) => {
          batch.set(tagDoc.ref, {
            sector,
            ...buildLegacyTagIdentityCleanup(),
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        });

        await batch.commit();
        updatedCount += chunk.length;
      }

      // Ensure sector document exists when name is provided
      if (name) {
        const sectorRef = db.collection('tenants').doc(tenant).collection('sectors').doc(sector);
        const sectorBefore = await sectorRef.get();

        const sectorPayload = {
          name,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (!sectorBefore.exists) {
          sectorPayload.createdAt = admin.firestore.FieldValue.serverTimestamp();
        }

        await sectorRef.set(sectorPayload, { merge: true });
      }

      await auditRef.set({
        action: 'assign_tag_sector',
        status: 'success',
        tenant,
        sector,
        requestedIds,
        missingIds: allMissingIds,
        matchedTags: tenantMatchedDocs.length,
        updatedTags: updatedCount,
        sampleTagIds: tenantMatchedDocs.slice(0, 100).map((doc) => doc.id),
        nameUpdated: Boolean(name),
        requestMetadata,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(200).json({
        success: true,
        tenant,
        sector,
        ids: requestedIds,
        missingIds: allMissingIds,
        matchedTags: tenantMatchedDocs.length,
        updatedTags: updatedCount,
        auditId: auditRef.id,
      });
    } catch (error) {
      logger.error('Error assigning tag sector:', error);

      await auditRef.set({
        action: 'assign_tag_sector',
        status: 'error',
        tenant,
        sector,
        requestedIds: Array.isArray(ids) ? ids : [],
        error: error.message || 'Unknown error',
        requestMetadata,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        auditId: auditRef.id,
      });
    }
  }
);

async function listTagSectors(req, res) {
  const db = admin.firestore();
  const tenant = sanitizeTenantLookup(req.query.tenant || req.query.tenantId);
  const sector = sanitizeSectorId(req.query.sector || req.query.setor || '');

  if (!tenant) {
    return res.status(400).json({ success: false, error: 'tenant is required' });
  }

  try {
    const sectorsRef = db.collection('tenants').doc(tenant).collection('sectors');
    const tagDocs = await fetchTagsByTenant(db, tenant);
    const tagCountsBySector = new Map();

    tagDocs.forEach((doc) => {
      const tagSector = getTagSectorId(doc.data() || {});
      if (tagSector) {
        tagCountsBySector.set(tagSector, (tagCountsBySector.get(tagSector) || 0) + 1);
      }
    });

    if (sector) {
      const sectorDoc = await sectorsRef.doc(sector).get();
      if (!sectorDoc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Sector not found',
          tenant,
          sector,
        });
      }

      return res.status(200).json({
        success: true,
        tenant,
        sector: serializeSectorRedirect(sectorDoc, tagCountsBySector.get(sector) || 0),
      });
    }

    const snapshot = await sectorsRef.get();
    const sectors = snapshot.docs
      .map((doc) => serializeSectorRedirect(doc, tagCountsBySector.get(doc.id) || 0))
      .sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id)));

    return res.status(200).json({
      success: true,
      tenant,
      count: sectors.length,
      sectors,
    });
  } catch (error) {
    logger.error('Error listing tag sectors', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
    });
  }
}

async function updateTagSectorRedirect(req, res) {
  const db = admin.firestore();
  const tenant = sanitizeTenantLookup(req.body?.tenant || req.body?.tenantId || req.query?.tenant || req.query?.tenantId);
  const sector = sanitizeSectorId(req.body?.sector || req.body?.setor || req.query?.sector || req.query?.setor);
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : null;
  const newUrl = normalizeTenantTagUrl(
    req.body?.newUrl || req.body?.url || req.body?.redirectUrl || req.query?.newUrl || req.query?.url
  );
  const rawSchedules = req.body?.schedules;
  const schedulesResult = normalizeSectorSchedules(rawSchedules);
  const requestMetadata = buildRequestMetadata(req);

  if (!tenant) {
    return res.status(400).json({ success: false, error: 'tenant is required' });
  }

  if (!sector) {
    return res.status(400).json({ success: false, error: 'sector is required' });
  }

  if (newUrl && !isValidHttpUrl(newUrl)) {
    return res.status(400).json({ success: false, error: 'newUrl must be a valid http or https URL' });
  }

  if (schedulesResult.error) {
    return res.status(400).json({ success: false, error: schedulesResult.error });
  }

  if (!newUrl && schedulesResult.schedules == null && !name) {
    return res.status(400).json({
      success: false,
      error: 'send newUrl, schedules, or name to update the sector',
    });
  }

  const sectorRef = db.collection('tenants').doc(tenant).collection('sectors').doc(sector);
  const auditRef = db.collection('tag_url_audits').doc();

  try {
    const beforeDoc = await sectorRef.get();
    const payload = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!beforeDoc.exists) {
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    if (name) {
      payload.name = name;
    }

    if (newUrl) {
      payload.redirect_url = newUrl;
    }

    if (schedulesResult.schedules != null) {
      payload.schedules = schedulesResult.schedules;
    }

    await sectorRef.set(payload, { merge: true });

    const afterDoc = await sectorRef.get();
    const matchingTags = await fetchTagsByTenantAndSector(db, tenant, sector);

    await auditRef.set({
      action: 'update_sector_tag_redirect',
      status: 'success',
      tenant,
      sector,
      newUrl: newUrl || null,
      schedulesUpdated: schedulesResult.schedules != null,
      matchedTags: matchingTags.length,
      previousValue: beforeDoc.exists ? getDirectSectorRedirectUrl(beforeDoc.data() || {}) : null,
      requestMetadata,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(beforeDoc.exists ? 200 : 201).json({
      success: true,
      tenant,
      sector: serializeSectorRedirect(afterDoc, matchingTags.length),
      matchedTags: matchingTags.length,
      auditId: auditRef.id,
    });
  } catch (error) {
    logger.error('Error updating tag sector redirect', error);

    await auditRef.set({
      action: 'update_sector_tag_redirect',
      status: 'error',
      tenant,
      sector,
      newUrl: newUrl || null,
      error: error.message || 'Unknown error',
      requestMetadata,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      auditId: auditRef.id,
    });
  }
}

exports.manageTagSectorRedirect = onRequest(
  {
    cors: true,
    maxInstances: 2,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method === 'GET') {
      return listTagSectors(req, res);
    }

    if (req.method === 'POST') {
      return updateTagSectorRedirect(req, res);
    }

    res.set('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
);

async function getReportingIgnoredTags(req, res) {
  try {
    const db = admin.firestore();
    const reportingSettings = await getReportingSettings(db, { forceRefresh: true });

    return res.status(200).json({
      success: true,
      reporting: {
        ignoredTagIds: reportingSettings.ignoredTagIds,
        ignoredTagsCount: reportingSettings.ignoredTagIds.length,
        firestoreDocumentPath: REPORTING_SETTINGS_DOC_PATH,
      }
    });
  } catch (error) {
    logger.error('Error fetching reporting ignored tags', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error'
    });
  }
}

async function updateReportingIgnoredTags(req, res) {
  const mode = typeof req.body?.mode === 'string' && req.body.mode.trim() ? req.body.mode.trim().toLowerCase() : 'replace';
  const rawIgnoredTagIds = req.body?.ignoredTagIds || req.body?.ids;
  const ignoredTagIds = parseIgnoredTagIds(rawIgnoredTagIds);
  const allowedModes = new Set(['replace', 'add', 'remove']);

  if (!allowedModes.has(mode)) {
    return res.status(400).json({
      success: false,
      error: 'mode must be one of: replace, add, remove'
    });
  }

  if (!Array.isArray(rawIgnoredTagIds)) {
    return res.status(400).json({
      success: false,
      error: 'ignoredTagIds must be an array'
    });
  }

  try {
    const db = admin.firestore();
    const docRef = db.doc(REPORTING_SETTINGS_DOC_PATH);
    const currentDoc = await docRef.get();
    const currentIgnoredTagIds = parseIgnoredTagIds(currentDoc.data()?.ignoredTagIds || []);
    let nextIgnoredTagIds;

    if (mode === 'replace') {
      nextIgnoredTagIds = ignoredTagIds;
    } else if (mode === 'add') {
      nextIgnoredTagIds = Array.from(new Set([...currentIgnoredTagIds, ...ignoredTagIds]));
    } else {
      const ignoredSet = new Set(ignoredTagIds);
      nextIgnoredTagIds = currentIgnoredTagIds.filter((id) => !ignoredSet.has(id));
    }

    await docRef.set({
      ignoredTagIds: nextIgnoredTagIds,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    clearReportingSettingsCache();
    const reportingSettings = await getReportingSettings(db, { forceRefresh: true });

    return res.status(200).json({
      success: true,
      mode,
      reporting: {
        ignoredTagIds: reportingSettings.ignoredTagIds,
        ignoredTagsCount: reportingSettings.ignoredTagIds.length,
        firestoreDocumentPath: REPORTING_SETTINGS_DOC_PATH,
      }
    });
  } catch (error) {
    logger.error('Error updating reporting ignored tags', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error'
    });
  }
}

exports.upsertTenant = onRequest(
  {
    cors: true,
    maxInstances: 2,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.set('Allow', 'POST, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
      const {
        slug,
        name,
        domain,
        sectors,
        currency,
        stripeAccountId,
        stripePublicKey,
        pixKey,
        fallbackUrl,
        logoUrl,
        givingOptions,
        paymentMethods,
        theme = {},
      } = req.body || {};

      const normalizedSlug = sanitizeSlug(slug);

      if (!normalizedSlug) {
        return res.status(400).json({ error: 'slug is required and must contain only letters, numbers, or hyphens' });
      }

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }

      if (!currency || typeof currency !== 'string' || !currency.trim()) {
        return res.status(400).json({ error: 'currency is required' });
      }

      const sectorsError = validateSectors(sectors);
      if (sectorsError) {
        return res.status(400).json({ error: sectorsError });
      }

      if (!fallbackUrl || typeof fallbackUrl !== 'string' || !fallbackUrl.trim()) {
        return res.status(400).json({ error: 'fallbackUrl is required' });
      }

      const givingOptionsError = validateGivingOptions(givingOptions);
      if (givingOptionsError) {
        return res.status(400).json({ error: givingOptionsError });
      }

      if (!theme.primaryColor || typeof theme.primaryColor !== 'string' || !theme.primaryColor.trim()) {
        return res.status(400).json({ error: 'theme.primaryColor is required' });
      }

      const db = admin.firestore();
      const tenantRef = db.collection('tenants').doc(normalizedSlug);
      const existingTenant = await tenantRef.get();
      const alreadyExists = existingTenant.exists;

      if (existingTenant.exists) {
        logger.info(`Tenant already exists. Updating tenant: ${normalizedSlug}`);
      }

      const normalizedTenant = {
        id: normalizedSlug,
        slug: normalizedSlug,
        name: name.trim(),
        domain: typeof domain === 'string' && domain.trim() ? domain.trim().toLowerCase() : null,
        currency: currency.trim().toLowerCase(),
        stripeAccountId: typeof stripeAccountId === 'string' && stripeAccountId.trim() ? stripeAccountId.trim() : null,
        stripePublicKey: typeof stripePublicKey === 'string' && stripePublicKey.trim() ? stripePublicKey.trim() : null,
        pixKey: typeof pixKey === 'string' && pixKey.trim() ? pixKey.trim() : null,
        fallbackUrl: fallbackUrl.trim(),
        logoUrl: typeof logoUrl === 'string' && logoUrl.trim() ? logoUrl.trim() : null,
        givingOptions: givingOptions.map((option) => ({
          id: option.id.trim(),
          label: option.label.trim(),
          value: option.value.trim(),
          ...(typeof option.pixRegistrationRequired === 'boolean' ? { pixRegistrationRequired: option.pixRegistrationRequired } : {}),
        })),
        paymentMethods: normalizePaymentMethods(paymentMethods),
        theme: {
          primaryColor: theme.primaryColor.trim(),
          ...(typeof theme.secondaryColor === 'string' && theme.secondaryColor.trim() ? { secondaryColor: theme.secondaryColor.trim() } : {}),
          ...(typeof theme.logo === 'string' && theme.logo.trim() ? { logo: theme.logo.trim() } : {}),
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await tenantRef.set(normalizedTenant, { merge: true });
      const normalizedSectorRecords = await ensureTenantSectors({ tenantRef, sectors });

      logger.info(`Tenant upsert completed successfully: ${normalizedSlug}`);

      return res.status(alreadyExists ? 200 : 201).json({
        success: true,
        operation: alreadyExists ? 'updated' : 'created',
        tenant: {
          ...normalizedTenant,
          createdAt: null,
          updatedAt: null,
        },
        sectors: normalizedSectorRecords,
      });
    } catch (error) {
      logger.error('Error in upsertTenant:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

exports.createTenant = exports.upsertTenant;
exports.getTagKpis = onRequest(
  {
    cors: true,
    maxInstances: 5,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'GET') {
      res.set('Allow', 'GET, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    return getTagKpis(req, res);
  }
);

exports.manageReportingIgnoredTags = onRequest(
  {
    cors: true,
    maxInstances: 2,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method === 'GET') {
      return getReportingIgnoredTags(req, res);
    }

    if (req.method === 'POST') {
      return updateReportingIgnoredTags(req, res);
    }

    res.set('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
);

exports.tagRedirectBr = onRequest(
  {
    cors: true,
    maxInstances: 20,
    memory: "256MiB",
    region: BRAZIL_REGION,
    secrets: [upstashRedisRestUrl, upstashRedisRestToken],
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (!['GET', 'HEAD'].includes(req.method)) {
      res.set('Allow', 'GET, HEAD, OPTIONS');
      return res.status(405).send('Method Not Allowed');
    }

    const debugEnabled = shouldEnableRedirectDebug(req);
    const timings = createTimingCollector();
    const db = admin.firestore();
    const caches = {};

    try {
      const pathParts = getRedirectRequestPath(req).split('/').filter(Boolean);
      const tagId = pathParts[1] || null;

      if (!tagId) {
        const destinationUrl = await getAutoRedirectUrl(db, debugEnabled ? timings : null);
        if (debugEnabled) {
          timings.applyHeaders(res);
        }
        return res.redirect(302, destinationUrl);
      }

      let payload = null;
      const redisGetStartedAt = debugEnabled ? timings.start() : null;

      try {
        payload = await getTagRedirectCache(tagId);
      } catch (error) {
        logger.warn('Redis cache read failed for tag redirect', {
          tagId,
          error: error.message || error,
        });
      }

      if (debugEnabled && redisGetStartedAt) {
        timings.end('redis_get', redisGetStartedAt);
      }

      const cacheHasSectorMetadata = payload && Object.prototype.hasOwnProperty.call(payload, 'sector');

      if (!payload || !cacheHasSectorMetadata) {
        const reportingSettingsStartedAt = debugEnabled ? timings.start() : null;
        const reportingSettings = await getReportingSettings(db);
        if (debugEnabled && reportingSettingsStartedAt) {
          timings.end('reporting_settings', reportingSettingsStartedAt);
        }

        payload = await resolveTagRedirectFromFirestore(db, tagId, {
          reportingSettings,
          caches,
          timings: debugEnabled ? timings : null,
        });
      }

      if (!payload) {
        const fallbackStartedAt = debugEnabled ? timings.start() : null;
        const fallbackUrl = await getFallbackRedirectUrl(db, caches);
        if (debugEnabled && fallbackStartedAt) {
          timings.end('fallback_get', fallbackStartedAt);
          timings.applyHeaders(res);
        }
        return res.redirect(302, fallbackUrl);
      }

      payload = await resolveFinalTagRedirectPayload(db, payload, {
        caches,
      });

      const finalDestinationUrl = appendTagRedirectParameters(payload.destinationUrl, tagId, payload.tenant);
      const occurredAt = new Date();
      const scanQueueStartedAt = debugEnabled ? timings.start() : null;
      try {
        await enqueueTagScanMetric(tagId, occurredAt);
      } catch (error) {
        logger.warn('Failed to enqueue tag scan metric', {
          tagId,
          error: error.message || error,
        });
      }
      if (debugEnabled && scanQueueStartedAt) {
        timings.end('redis_scan_enqueue', scanQueueStartedAt);
        timings.applyHeaders(res);
      }

      Promise.allSettled([
        sendRedirectPosthogEvent(req, {
          tagId,
          tenant: payload.tenant,
          sector: payload.sector,
          destinationUrl: finalDestinationUrl,
          redirectSource: payload.redirectSource,
          routeType: 'tag_redirect_br',
          status: payload.status,
          tagFound: payload.tagFound,
          reportingIgnored: payload.reportingIgnored,
        }),
      ]).catch((error) => {
        logger.warn('Background redirect promises failed', {
          tagId,
          error: error.message || error,
        });
      });

      return res.redirect(302, finalDestinationUrl);
    } catch (error) {
      logger.error('tagRedirectBr failed', error);
      if (debugEnabled) {
        timings.applyHeaders(res);
      }
      return res.status(500).send('Internal Server Error');
    }
  }
);

exports.benchNode = onRequest(
  {
    cors: true,
    maxInstances: 20,
    memory: "256MiB",
    region: BRAZIL_REGION,
    secrets: [upstashRedisRestUrl, upstashRedisRestToken],
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (!['GET', 'HEAD'].includes(req.method)) {
      res.set('Allow', 'GET, HEAD, OPTIONS');
      return res.status(405).send('Method Not Allowed');
    }

    const timings = createTimingCollector();
    const tagId = normalizeTagId(getLastPathSegment(getRedirectRequestPath(req)));

    if (!tagId) {
      return res.status(400).json({ error: 'tagId is required' });
    }

    let payload = null;
    const redisGetStartedAt = timings.start();

    try {
      payload = await getTagRedirectCache(tagId);
    } catch (error) {
      logger.warn('benchNode Redis cache read failed', {
        tagId,
        error: error.message || error,
      });
    }

    timings.end('redis_get', redisGetStartedAt);

    if (!payload || !payload.destinationUrl) {
      timings.applyHeaders(res);
      return res.status(404).json({ error: 'tag cache not found', tagId });
    }

    const destinationUrl = appendTagRedirectParameters(payload.destinationUrl, tagId, payload.tenant);
    timings.applyHeaders(res);
    return res.redirect(302, destinationUrl);
  }
);

exports.flushTagScanMetrics = onSchedule(
  {
    schedule: '*/1 * * * *',
    timeZone: 'America/Sao_Paulo',
    region: BRAZIL_REGION,
    memory: '512MiB',
    maxInstances: 1,
    secrets: [upstashRedisRestUrl, upstashRedisRestToken],
  },
  async () => {
    const db = admin.firestore();
    const dirtyTagIds = await getDirtyTagScanIds();

    if (dirtyTagIds.length === 0) {
      logger.info('flushTagScanMetrics found no pending tag scans');
      return;
    }

    logger.info('flushTagScanMetrics started', { dirtyTagCount: dirtyTagIds.length });

    let flushedTagCount = 0;
    let skippedTagCount = 0;

    for (let index = 0; index < dirtyTagIds.length; index += TAG_SCAN_FLUSH_BATCH_SIZE) {
      const chunkIds = dirtyTagIds.slice(index, index + TAG_SCAN_FLUSH_BATCH_SIZE);
      const metricSnapshots = await Promise.all(chunkIds.map(async (tagId) => {
        try {
          return await getPendingTagScanMetric(tagId);
        } catch (error) {
          logger.warn('Failed to read pending tag scan metric', {
            tagId,
            error: error.message || error,
          });
          return null;
        }
      }));

      const batch = db.batch();
      const acknowledgements = [];

      metricSnapshots.forEach((metric) => {
        if (!metric || metric.pendingDelta <= 0) {
          skippedTagCount += 1;
          return;
        }

        const updatePayload = {
          scan_count: admin.firestore.FieldValue.increment(metric.pendingDelta),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (metric.lastScanAtMs) {
          updatePayload.last_scan_at = admin.firestore.Timestamp.fromMillis(metric.lastScanAtMs);
        }

        batch.update(db.collection('tags').doc(metric.tagId), updatePayload);
        acknowledgements.push(metric);
      });

      if (acknowledgements.length === 0) {
        continue;
      }

      try {
        await batch.commit();
      } catch (error) {
        logger.error('flushTagScanMetrics batch commit failed', {
          chunkSize: acknowledgements.length,
          error: error.message || error,
        });
        continue;
      }

      await Promise.allSettled(acknowledgements.map(async (metric) => {
        try {
          await acknowledgeFlushedTagScanMetric(metric.tagId, {
            appliedDelta: metric.pendingDelta,
            appliedLastScanAtMs: metric.lastScanAtMs,
          });
          flushedTagCount += 1;
        } catch (error) {
          logger.warn('Failed to acknowledge flushed tag scan metric', {
            tagId: metric.tagId,
            error: error.message || error,
          });
        }
      }));
    }

    logger.info('flushTagScanMetrics finished', {
      dirtyTagCount: dirtyTagIds.length,
      flushedTagCount,
      skippedTagCount,
    });
  }
);

exports.syncTagRedirectCacheOnWrite = onDocumentWritten(
  {
    document: 'tags/{tagId}',
    region: FIRESTORE_REGION,
    secrets: [upstashRedisRestUrl, upstashRedisRestToken],
    maxInstances: 10,
  },
  async (event) => {
    const db = admin.firestore();
    const reportingSettings = await getReportingSettings(db, { forceRefresh: true });
    const afterSnapshot = event.data.after;

    if (!afterSnapshot.exists) {
      await deleteTagRedirectCache(event.params.tagId);
      logger.info('Deleted tag redirect cache after Firestore delete', { tagId: event.params.tagId });
      return;
    }

    await syncTagSnapshotToRedis(db, afterSnapshot, {
      reportingSettings,
      caches: {},
    });

    logger.info('Synchronized tag redirect cache from Firestore trigger', {
      tagId: afterSnapshot.id,
    });
  }
);

exports.syncAllTagRedirectCaches = onSchedule(
  {
    schedule: 'every 12 hours',
    timeZone: 'America/Sao_Paulo',
    region: BRAZIL_REGION,
    secrets: [upstashRedisRestUrl, upstashRedisRestToken],
    maxInstances: 1,
    memory: '512MiB',
  },
  async () => {
    const db = admin.firestore();
    const reportingSettings = await getReportingSettings(db, { forceRefresh: true });
    const snapshot = await db.collection('tags').get();
    const caches = {};
    let updatedTags = 0;
    let failedTags = 0;

    for (const tagDoc of snapshot.docs) {
      try {
        await syncTagSnapshotToRedis(db, tagDoc, {
          reportingSettings,
          caches,
        });
        updatedTags += 1;
      } catch (error) {
        failedTags += 1;
        logger.warn('Failed to synchronize tag during scheduled Redis refresh', {
          tagId: tagDoc.id,
          error: error.message || error,
        });
      }
    }

    logger.info('Completed scheduled Redis tag synchronization', {
      totalTags: snapshot.size,
      updatedTags,
      failedTags,
    });
  }
);

exports.listTags = onRequest(
  {
    cors: true,
    maxInstances: 5,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'GET') {
      res.set('Allow', 'GET, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    return listTags(req, res);
  }
);

exports.docsGuard = onRequest(
  {
    region: BRAZIL_REGION,
    maxInstances: 5,
    memory: '256MiB',
    secrets: [docsBasicAuthPassword],
  },
  async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD');
      return res.status(405).send('Method Not Allowed');
    }

    const credentials = parseBasicAuthorizationHeader(req.get('authorization') || '');
    const expectedPassword = docsBasicAuthPassword.value() || '';
    const isAuthorized = Boolean(
      credentials &&
      secureCompareStrings(credentials.username, DOCS_BASIC_AUTH_USERNAME) &&
      secureCompareStrings(credentials.password, expectedPassword)
    );

    if (!isAuthorized) {
      res.set('WWW-Authenticate', 'Basic realm="OneTapGo Docs", charset="UTF-8"');
      res.set('Cache-Control', 'no-store');
      return res.status(401).send('Authentication required');
    }

    const filePath = resolveDocsFilePath(req.path || req.originalUrl || '/');
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res.status(404).send('Not found');
    }

    res.set('Cache-Control', 'private, max-age=300');
    res.type(getDocsContentType(filePath));

    if (req.method === 'HEAD') {
      return res.status(200).end();
    }

    return res.sendFile(filePath);
  }
);

exports.generateTags = generateTags;
exports.generateTagsBatch = generateTagsBatch;

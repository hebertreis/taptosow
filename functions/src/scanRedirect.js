'use strict';

// Identidade do navegador no scan e redirect transparente.
//
// O Firebase Hosting só repassa à função o cookie `__session`; por isso o id do
// visitante (`otg_<uuid>`) vive nele. O mesmo cookie, com Domain=onetapgo.site, fica
// legível pelo JavaScript dos produtos em *.onetapgo.site, que o ligam à pessoa do
// PostHog com `posthog.alias(vid)`.

const crypto = require('node:crypto');

const VISITOR_COOKIE = '__session';
const VISITOR_ID_PATTERN = /^otg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

function parseVisitorId(cookieHeader) {
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null;
    for (const part of cookieHeader.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        if (part.slice(0, index).trim() !== VISITOR_COOKIE) continue;
        const value = part.slice(index + 1).trim();
        return VISITOR_ID_PATTERN.test(value) ? value : null;
    }
    return null;
}

function newVisitorId() {
    return `otg_${crypto.randomUUID()}`;
}

// Legível por JS (sem HttpOnly) de propósito: a ponte nos produtos precisa lê-lo.
function buildVisitorCookie(visitorId, { domain = 'onetapgo.site', maxAge = ONE_YEAR_SECONDS } = {}) {
    return `${VISITOR_COOKIE}=${visitorId}; Domain=${domain}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`;
}

function parseList(value) {
    return String(value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

// SCAN_VISITOR_ID=true liga o id/cookie do visitante.
function isVisitorIdEnabled(env = process.env) {
    return String(env.SCAN_VISITOR_ID || '').toLowerCase() === 'true';
}

// SCAN_TRANSPARENT_REDIRECT: "true" (todas as tags), "false"/vazio (desligado) ou lista
// de tags separadas por vírgula (canário). Exige o id do visitante ligado.
function isTransparentRedirectEnabled(tagId, env = process.env) {
    if (!isVisitorIdEnabled(env)) return false;
    const raw = String(env.SCAN_TRANSPARENT_REDIRECT || '').trim();
    if (!raw || raw.toLowerCase() === 'false') return false;
    if (raw.toLowerCase() === 'true') return true;
    return Boolean(tagId) && parseList(raw).includes(String(tagId));
}

// Nunca deixa o toque esperar mais que `ms` por um envio de analytics.
async function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    VISITOR_COOKIE,
    parseVisitorId,
    newVisitorId,
    buildVisitorCookie,
    isVisitorIdEnabled,
    isTransparentRedirectEnabled,
    withTimeout,
};

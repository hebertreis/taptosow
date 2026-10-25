'use strict';

// Teste de ponta a ponta do roteador de scan, com Firestore, PostHog e GA4 trocados
// por dublês: nada sai da máquina e nenhum dado de produção é tocado.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const captured = [];
const tags = {
    '07bc1cb4': { tenant: 'rampchurchsp', sector: 'visitantes', redirect_url: 'https://give.onetapgo.site/rampchurchsp' },
    nourl0001: { tenant: 'rampchurchsp', sector: 'visitantes' },
};

const stubs = {
    'firebase-functions/v2/https': { onRequest: (...args) => args[args.length - 1] },
    'firebase-functions/logger': { info() {}, warn() {}, error: (...a) => console.error('LOGGER', ...a), debug() {} },
    'firebase-functions/params': { defineSecret: () => ({ value: () => '' }) },
    'posthog-node': {
        PostHog: class {
            capture(payload) { captured.push(payload); }
            async _shutdown() {}
        },
    },
    cors: () => () => {},
    './src/cora': class {},
    './src/seedTenants': { seedTenants: async () => {} },
    axios: { post: async () => ({}), get: async () => ({}) },
    'firebase-admin': (() => {
        const firestore = () => ({
            collection: (name) => ({
                doc: (id) => ({
                    get: async () => ({ exists: name === 'tags' && Boolean(tags[id]), data: () => tags[id] || {}, ref: { update: async () => {} } }),
                    // tenants/{tenant}/sectors/{sector}: sem setor configurado nos testes
                    collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => ({}) }) }) }),
                }),
            }),
            doc: () => ({ get: async () => ({ exists: true, data: () => ({ url: 'https://onetapgo.site/' }) }) }),
        });
        firestore.FieldValue = { increment: () => 1, serverTimestamp: () => 'now' };
        return { initializeApp() {}, firestore };
    })(),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
};

const { iotRouter } = require(path.join(__dirname, '..', 'index.js'));

function call(reqPath, { cookie, env = {} } = {}) {
    Object.assign(process.env, { SCAN_VISITOR_ID: '', SCAN_TRANSPARENT_REDIRECT: '' }, env);
    captured.length = 0;
    const headers = { host: 'onetapgo.site', 'user-agent': 'node-test', ...(cookie ? { cookie } : {}) };
    const req = {
        path: reqPath, method: 'GET', headers, query: {}, originalUrl: reqPath, url: reqPath, ip: '203.0.113.9',
        hostname: 'onetapgo.site', protocol: 'https',
        get: (name) => headers[name.toLowerCase()],
    };
    const out = { status: 200, headers: {}, cookies: [], body: null, redirectedTo: null };
    const res = {
        status(code) { out.status = code; return this; },
        set(k, v) { out.headers[String(k).toLowerCase()] = v; return this; },
        append(k, v) { if (String(k).toLowerCase() === 'set-cookie') out.cookies.push(v); return this; },
        redirect(code, url) { out.status = code; out.redirectedTo = url; return this; },
        send(body) { out.body = body; return this; },
        json(body) { out.body = body; return this; },
    };
    return iotRouter(req, res).then(() => out);
}

test('padrão (flags desligadas): comportamento atual, sem cookie e com página intermediária', async () => {
    const out = await call('/a/07bc1cb4');
    assert.equal(out.status, 200);
    assert.equal(out.cookies.length, 0);
    assert.match(out.body, /redirect_scan_page_loaded/);
    assert.match(out.body, /api_host: "https:\/\/p\.onetapgo\.site"/);
    assert.match(captured[0].distinctId, /^scan_[0-9a-f]{32}$/);
});

test('SCAN_VISITOR_ID: cria o cookie e usa o id como distinctId', async () => {
    const out = await call('/a/07bc1cb4', { env: { SCAN_VISITOR_ID: 'true' } });
    assert.equal(out.status, 200);
    assert.equal(out.cookies.length, 1);
    const vid = /__session=(otg_[0-9a-f-]{36})/.exec(out.cookies[0])[1];
    assert.equal(captured[0].distinctId, vid);
    assert.equal(captured[0].properties.visitor_cookie_present, false);
});

test('SCAN_VISITOR_ID: reaproveita o id do cookie existente', async () => {
    const vid = 'otg_11111111-2222-4333-8444-555555555555';
    const out = await call('/a/07bc1cb4', { cookie: `__session=${vid}`, env: { SCAN_VISITOR_ID: 'true' } });
    assert.equal(captured[0].distinctId, vid);
    assert.equal(captured[0].properties.visitor_cookie_present, true);
    assert.ok(out.cookies[0].startsWith(`__session=${vid};`));
});

test('redirect transparente: 302 com UTMs, cookie e sem cache', async () => {
    const out = await call('/a/07bc1cb4', { env: { SCAN_VISITOR_ID: 'true', SCAN_TRANSPARENT_REDIRECT: 'true' } });
    assert.equal(out.status, 302);
    const url = new URL(out.redirectedTo);
    assert.equal(url.host, 'give.onetapgo.site');
    assert.equal(url.searchParams.get('utm_medium'), 'nfc');
    assert.equal(url.searchParams.get('utm_content'), '07bc1cb4');
    assert.ok(url.searchParams.get('utm_timestamp'));
    assert.equal(out.body, null);
    assert.match(out.headers['cache-control'], /private/);
    assert.equal(out.cookies.length, 1);
    assert.equal(captured.length, 1);
    assert.match(captured[0].properties.redirect_search, /utm_timestamp=/);
});

test('canário: só as tags da lista ganham o 302', async () => {
    const env = { SCAN_VISITOR_ID: 'true', SCAN_TRANSPARENT_REDIRECT: 'outra0001' };
    assert.equal((await call('/a/07bc1cb4', { env })).status, 200);
    assert.equal((await call('/a/07bc1cb4', { env: { ...env, SCAN_TRANSPARENT_REDIRECT: '07bc1cb4' } })).status, 302);
});

test('tag existente sem URL: o fallback mantém tenant e setor no evento', async () => {
    await call('/a/nourl0001');
    assert.equal(captured[0].properties.client_slug, 'rampchurchsp');
    assert.equal(captured[0].properties.tag_sector, 'visitantes');
    assert.equal(captured[0].properties.tag_found, true);
    assert.equal(captured[0].properties.fallback_used, true);
});

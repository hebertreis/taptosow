'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseVisitorId,
    newVisitorId,
    buildVisitorCookie,
    isVisitorIdEnabled,
    isTransparentRedirectEnabled,
    withTimeout,
} = require('../src/scanRedirect');

test('newVisitorId gera ids únicos e válidos', () => {
    const a = newVisitorId();
    assert.match(a, /^otg_[0-9a-f-]{36}$/);
    assert.notEqual(a, newVisitorId());
    assert.equal(parseVisitorId(`__session=${a}`), a);
});

test('parseVisitorId lê só o __session e só valores válidos', () => {
    const id = newVisitorId();
    assert.equal(parseVisitorId(`ph_x=1; __session=${id}; outro=2`), id);
    assert.equal(parseVisitorId('__session=qualquer-coisa'), null);
    assert.equal(parseVisitorId(`__session_x=${id}`), null);
    assert.equal(parseVisitorId(`__session=${id}'; drop`), null);
    assert.equal(parseVisitorId(undefined), null);
    assert.equal(parseVisitorId(''), null);
});

test('cookie é de primeira parte, 1 ano, seguro e legível por JS', () => {
    const cookie = buildVisitorCookie('otg_00000000-0000-4000-8000-000000000000');
    assert.match(cookie, /^__session=otg_/);
    assert.match(cookie, /Domain=onetapgo\.site/);
    assert.match(cookie, /Max-Age=31536000/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /HttpOnly/);
});

test('flags: tudo desligado por padrão', () => {
    assert.equal(isVisitorIdEnabled({}), false);
    assert.equal(isTransparentRedirectEnabled('abc', {}), false);
    assert.equal(isTransparentRedirectEnabled('abc', { SCAN_TRANSPARENT_REDIRECT: 'true' }), false);
});

test('flags: redirect transparente por lista de tags (canário) ou para todas', () => {
    const base = { SCAN_VISITOR_ID: 'true' };
    assert.equal(isTransparentRedirectEnabled('abc', { ...base, SCAN_TRANSPARENT_REDIRECT: 'true' }), true);
    assert.equal(isTransparentRedirectEnabled('abc', { ...base, SCAN_TRANSPARENT_REDIRECT: 'abc, def' }), true);
    assert.equal(isTransparentRedirectEnabled('zzz', { ...base, SCAN_TRANSPARENT_REDIRECT: 'abc,def' }), false);
    assert.equal(isTransparentRedirectEnabled('abc', { ...base, SCAN_TRANSPARENT_REDIRECT: 'false' }), false);
});

test('withTimeout devolve o resultado rápido e corta o lento', async () => {
    assert.equal(await withTimeout(Promise.resolve('ok'), 50), 'ok');
    assert.equal(await withTimeout(new Promise(() => {}), 20), 'timeout');
});

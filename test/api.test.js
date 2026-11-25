import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, serverIsCurrent, suggestName } from '../extension/lib/api.js';

const reply = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a server that does not report the features the extension needs counts as outdated', () => {
  assert.equal(serverIsCurrent({ ok: true, version: '0.1.0', keyConfigured: true }), false, 'an old server reports no features');
  assert.equal(serverIsCurrent({ features: ['plan'] }), false);
  assert.equal(serverIsCurrent({ features: ['plan', 'name'] }), false, 'a server from before restart/stop existed counts as outdated');
  assert.equal(serverIsCurrent({ features: ['plan', 'name', 'control'] }), true);
  assert.equal(serverIsCurrent(null), false);
});

test('naming against an old server explains what to do instead of "Unknown endpoint"', async () => {
  globalThis.fetch = reply(404, { ok: false, error: { code: 'not_found', message: 'Unknown endpoint.' } });
  await assert.rejects(suggestName([{ title: 'x', url: 'https://a.com' }]), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, 'outdated');
    assert.match(err.message, /Restart it/);
    assert.ok(!/Unknown endpoint/.test(err.message));
    return true;
  });
});

test('naming returns the name, and other errors pass through unchanged', async () => {
  globalThis.fetch = reply(200, { ok: true, name: 'Lisbon Trip' });
  assert.equal(await suggestName([{ title: 'x', url: 'https://a.com' }]), 'Lisbon Trip');

  globalThis.fetch = reply(402, { ok: false, error: { code: 'billing', message: 'Credits used up.' } });
  await assert.rejects(suggestName([{ title: 'x', url: 'https://a.com' }]), { code: 'billing', message: 'Credits used up.' });

  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(suggestName([{ title: 'x', url: 'https://a.com' }]), { code: 'offline' });
});

test('control requests go to /v1/control with only the action, and errors carry the server\'s explanation', async () => {
  const { controlServer } = await import('../extension/lib/api.js');
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body), method: init.method };
    return new Response(JSON.stringify({ ok: true, action: 'restart', pid: 1 }), { status: 200 });
  };
  await controlServer('restart');
  assert.deepEqual(sent, { url: 'http://127.0.0.1:47821/v1/control', body: { action: 'restart' }, method: 'POST' });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, error: { code: 'not_managed', message: 'Started by hand.' } }), { status: 409 });
  await assert.rejects(controlServer('stop'), { code: 'not_managed', message: 'Started by hand.' });
});

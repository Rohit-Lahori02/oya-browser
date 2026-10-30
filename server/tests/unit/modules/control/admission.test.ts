/**
 * Unit tests for the admission middleware: a start is reserved before any
 * provider is called; a draining server, a refused reservation, a replay and a
 * queued start are answered here, and an admitted start goes on with its
 * reservation bound to the request and its outcome persisted. A start that
 * nothing can serve is refused before any session is reserved.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ownDataDir } from '../../support/data-dir.ts';

ownDataDir('oya-control-admission-');
const { admission } = await import('../../../../src/modules/control/admission.ts');
const { control } = await import('../../../../src/modules/control/service.ts');
const { registry } = await import('../../../../src/modules/browsers/registry.ts');
const { recent } = await import('../../../../src/platform/audit.ts');
const { connectBrowser, disconnectBrowser } = await import('../../support/fakes.ts');

afterEach(() => {
  registry.draining = false;
});

let n = 0;
/** A connect request for key-a. */
const request = (body: any = {}, idempotency?: string) => ({
  path: '/connect',
  headers: { authorization: 'Bearer key-a' },
  body: { provider: 'cdp', ...body },
  get: (name) => (name === 'Idempotency-Key' ? idempotency : undefined),
});

/** A start request for `key` that names no provider. */
const startRequest = (key: string, body: any = {}) => ({
  path: '/start',
  headers: { authorization: `Bearer ${key}` },
  body,
  get: () => undefined,
});

/** Runs the middleware; resolves with what it answered, or 'next'. */
function admit(req, defaultProvider?) {
  return new Promise<any>((resolve) => {
    const res: any = { statusCode: 200 };
    res.status = (code) => ((res.statusCode = code), res);
    res.json = (body) => (resolve({ status: res.statusCode, body }), res);
    void admission(defaultProvider)(req, res, () => resolve({ next: true, res }));
  });
}

describe('admission', () => {
  it('refuses new starts while the server drains', async () => {
    registry.draining = true;
    assert.deepEqual(await admit(request()), { status: 503, body: { error: 'Server is draining', code: 'draining' } });
  });

  it('binds the reservation to the request and persists the handler’s answer', async () => {
    const req: any = request();
    const { next, res } = await admit(req);
    assert.equal(next, true);
    assert.equal(req.controlSession.state, 'provisioning');
    res.json({ id: req.controlSession.id });
    const stored = () => control().store.get('session', req.controlSession.id);
    for (let i = 0; i < 100 && (await stored()).state !== 'ready'; i++) await new Promise((r) => setImmediate(r));
    assert.equal((await stored()).state, 'ready');
  });

  it('answers a refused reservation with its status and code', async () => {
    const res = await admit(request({ queueMs: -1 }));
    assert.deepEqual([res.status, res.body.code], [400, 'invalid_queue']);
  });

  it('answers a replay with 202 while the first start is still running', async () => {
    const key = `idem-${n++}`;
    await admit(request({}, key));
    const res = await admit(request({}, key));
    assert.deepEqual([res.status, res.body.status], [202, 'starting']);
  });

  it('uses the route’s default provider when the body names none', async () => {
    const req: any = { ...request(), body: {} };
    await admit(req, 'oya-desktop');
    assert.equal(req.controlSession.provider, 'oya-desktop');
  });
});

describe('admission of a start nothing can serve', () => {
  it('refuses it with 409 before reserving, so no session is left behind', async () => {
    const key = 'key-nothing-to-start';
    const res = await admit(startRequest(key));
    assert.equal(res.status, 409);
    assert.match(res.body.error, /no browser is connected/);
    assert.deepEqual(await control().sessions(key), []);
  });

  it('audits the refusal as the handler would have', async () => {
    await admit(startRequest('key-nothing-audited'));
    const entry = recent({ action: 'browser.start', outcome: 'error' })[0];
    assert.equal(entry.meta.provider, 'cdp');
    assert.match(entry.meta.error, /npx @oya-ai\/cli init/);
  });

  it('reserves as before once a browser of the key’s is connected', async () => {
    connectBrowser('desk-1', 'key-with-desktop');
    try {
      const req: any = startRequest('key-with-desktop');
      const { next } = await admit(req);
      assert.equal(next, true);
      assert.equal(req.controlSession.state, 'provisioning');
    } finally {
      disconnectBrowser('desk-1');
    }
  });

  it('reserves a start that names what to dial', async () => {
    const req: any = startRequest('key-with-url', { provider: 'cdp', wsUrl: 'wss://8.8.8.8/devtools/browser/x' });
    const { next } = await admit(req);
    assert.equal(next, true);
    assert.equal(req.controlSession.provider, 'cdp');
  });
});

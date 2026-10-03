const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdminStore, applyAdmin, transactionVariations, STATUSES } = require('../order-admin');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-admin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'admin.json');
}

test('preserves every item variation, including both lighting selections', () => {
  for (const value of ['3-key switch', 'Remote controlled light']) {
    assert.deepEqual(transactionVariations({ variations: [
      { formatted_name: 'Light option', formatted_value: value },
      { formatted_name: 'Color', formatted_value: 'Blue' }
    ] }), [{ name: 'Light option', value }, { name: 'Color', value: 'Blue' }]);
  }
  assert.deepEqual(transactionVariations({}), []);
  assert.deepEqual(transactionVariations({ variations: [null, {}, { name: 'Option', value: 'Custom' }] }), [{ name: 'Option', value: 'Custom' }]);
});

test('status, note, clear and delete survive reload and can be restored independently', (t) => {
  const file = tempStore(t);
  let store = createAdminStore(file);
  store.update('123', { action: 'status', status: 'DELIVERED' });
  store.update('123', { action: 'note', note: '  Pack remote  ' });
  store.update('123', { action: 'clear' });
  store = createAdminStore(file);
  assert.equal(store.get('123').status, 'DELIVERED');
  assert.equal(store.get('123').note, 'Pack remote');
  assert.equal(store.get('123').visibility, 'cleared');
  store.update('123', { action: 'delete' });
  assert.equal(createAdminStore(file).get('123').visibility, 'deleted');
  store.update('123', { action: 'restore' });
  store.update('123', { action: 'reset-status' });
  assert.equal(store.get('123').visibility, 'visible');
  assert.equal(store.get('123').status, undefined);
  assert.equal(store.get('123').note, 'Pack remote');
  store.update('123', { action: 'note', note: '' });
  assert.equal(store.get('123').note, '');
});

test('overrides control open counts without changing the source status', () => {
  const source = { status: 'SHIPPED', isOpen: false, isCanceled: false, deliveredAt: null };
  for (const status of STATUSES) {
    const order = applyAdmin(source, { status, statusUpdatedAt: '2026-10-02T00:00:00Z' });
    assert.equal(order.status, status);
    assert.equal(order.isOpen, ['OPEN', 'IN_PROGRESS', 'READY_TO_SHIP'].includes(status));
    assert.equal(order.sourceOrder.status, 'SHIPPED');
  }
  assert.equal(source.status, 'SHIPPED');
  assert.equal(applyAdmin(source, {}).status, 'SHIPPED');
});

test('invalid edits and failed persistence leave saved state unchanged', (t) => {
  const file = tempStore(t);
  const store = createAdminStore(file);
  store.update('123', { action: 'note', note: 'Keep me' });
  for (const body of [{ action: 'status', status: 'INVALID' }, { action: 'note', note: 'x'.repeat(2001) }, { action: 'unknown' }]) {
    assert.throws(() => store.update('123', body));
  }
  assert.throws(() => store.update('__proto__', { action: 'clear' }));
  fs.mkdirSync(`${file}.tmp`);
  assert.throws(() => store.update('123', { action: 'note', note: 'Lost edit' }));
  assert.equal(store.get('123').note, 'Keep me');
  assert.equal(createAdminStore(file).get('123').note, 'Keep me');
});

test('API requires dashboard authentication, rejects invalid actions and saves real edits', async (t) => {
  const file = tempStore(t);
  process.env.ORDER_ADMIN_PATH = file;
  process.env.ORDER_CACHE_PATH = path.join(path.dirname(file), 'cache.json');
  process.env.DASHBOARD_PASSWORD = 'test-only-password';
  fs.writeFileSync(process.env.ORDER_CACHE_PATH, JSON.stringify({ '123': { receiptId: 123 } }));
  const { app, formatReceipt } = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${url}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=test-only-password', redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1' };
  const patch = (id, body, requestHeaders = headers) => fetch(`${url}/orders/${id}/admin`, { method: 'PATCH', headers: requestHeaders, body: JSON.stringify(body) });
  assert.equal((await patch('123', { action: 'clear' }, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await patch('123', { action: 'clear' }, { ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await patch('123', { action: 'clear' }, { Cookie: cookie, 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await patch('999', { action: 'clear' })).status, 404);
  assert.equal((await patch('123', { action: 'status', status: 'BAD' })).status, 400);
  const response = await patch('123', { action: 'note', note: 'Test note' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).admin.note, 'Test note');
  assert.equal(createAdminStore(file).get('123').note, 'Test note');
  const receipt = await formatReceipt({ receipt_id: 456, transactions: [
    { title: 'Lightbox A', variations: [{ formatted_name: 'Lighting', formatted_value: '3-key switch' }] },
    { title: 'Lightbox B', variations: [{ formatted_name: 'Lighting', formatted_value: 'Remote controlled light' }] }
  ] });
  assert.equal(receipt.transactions[0].variations[0].value, '3-key switch');
  assert.equal(receipt.transactions[1].variations[0].value, 'Remote controlled light');
});

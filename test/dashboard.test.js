const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function dashboard() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, addEventListener() {}, matches() { return false; } });
      return elements.get(id);
    },
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({ document, console, URLSearchParams, setInterval() {}, fetch() { return new Promise(() => {}); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  return { run: (code) => vm.runInContext(code, context), elements };
}

test('cards show the correct option per item and escape customer-controlled text', () => {
  const { run } = dashboard();
  const html = run(`buildCard({ id: 1, status: 'OPEN', transactions: [
    { title: 'Baseball', quantity: 1, variations: [{ name: 'Light option', value: 'Remote controlled light' }] },
    { title: 'ON AIR', quantity: 2, variations: [{ name: 'Light option', value: '3-key switch' }] }
  ], admin: { note: '<script>alert(1)</script>' } })`);
  assert.match(html, /Baseball[\s\S]*Remote controlled light[\s\S]*ON AIR[\s\S]*3-key switch/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-order-id="1"/);
  assert.match(run(`buildCard({ transactions: [{title:'Old item'}] })`), /No options provided by Etsy/);
});

test('resetting a status returns to the source values; hidden orders leave active filters and counts', () => {
  const { run } = dashboard();
  run(`sourceOrders = [{ id: 1, status: 'OPEN', isOpen: true, admin: {status: 'DELIVERED', statusUpdatedAt: '2026-10-02'} },
    { id: 2, status: 'OPEN', isOpen: true, admin: {visibility:'cleared'} }];
    allOrders = sourceOrders.map(applyOrderAdmin);`);
  assert.equal(run('allOrders[0].status'), 'DELIVERED');
  assert.equal(run('allOrders[0].isOpen'), false);
  assert.equal(run('visibleOrders().length'), 1);
  assert.equal(run(`activeFilter = 'OPEN'; filteredOrders().length`), 0);
  assert.equal(run(`activeFilter = 'HIDDEN'; filteredOrders()[0].id`), 2);
  run(`sourceOrders[0].admin = {}; allOrders = sourceOrders.map(applyOrderAdmin);`);
  assert.equal(run(`activeFilter = 'OPEN'; filteredOrders()[0].id`), 1);
  assert.equal(run('allOrders[0].status'), 'OPEN');
});

test('clearing the last order on a page clamps pagination before rendering', () => {
  const { run, elements } = dashboard();
  run(`allOrders = Array.from({length:8}, (_, id) => ({id:id+1, status:'OPEN', isOpen:true})); page=1; render();`);
  assert.equal(run('page'), 0);
  assert.equal(elements.get('pageIndicator').textContent, '1 / 1');
  assert.equal((elements.get('grid').innerHTML.match(/<article/g) || []).length, 8);
});

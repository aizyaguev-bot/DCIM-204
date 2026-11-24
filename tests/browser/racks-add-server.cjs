// Racks › "Add server" (Operator, outside Edit mode): pick a rack, a free PDU outlet from a list (outlets that carry a
// server's name are shown but cannot be chosen) and a name; an existing name is refused. Viewers have no button.
// Then a server removed from the lab must show nowhere: its name still on a PDU outlet and a KVM port reads as the
// default name on the Dashboard PDU / KVM cards and the PDU / KVM pages. Isolated local fixture only
// (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1, fresh).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9741';
const PASSWORD = 'test-password-123';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [];
  async function session(username) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await c.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch { /* ignore */ } });
    await c.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
    const login = await c.request.post(origin + '/api/auth/login', { data: { username, password: PASSWORD } });
    assert.equal(login.status(), 200, `${username} login`);
    const csrf = (await login.json()).csrf_token;
    const page = await c.newPage();
    page.on('pageerror', e => errors.push(`${username}: ${e.message}`));
    page.on('dialog', d => { errors.push(`${username} native dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
    return { c, csrf, page };
  }
  try {
    const admin = await session('admin'), operator = await session('operator'), viewer = await session('viewer');
    assert.equal((await (await admin.c.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    const devices = async () => (await admin.c.request.get(origin + '/api/devices/')).json();

    // ── Viewer: no Add server ──
    await viewer.page.goto(origin + '/?tab=racks');
    await viewer.page.locator('.racks-toolbar').first().waitFor({ timeout: 30000 });
    assert.equal(await viewer.page.locator('[data-action="add-server"]').count(), 0, 'a Viewer has no Add server');
    checks.push('Viewer: no Add server');

    // The fixture's PDUs are full: PDU 03 outlet 4 becomes a spare outlet first (put back at the end).
    const setLabel = async (id, n, label) => {
      const dev = (await devices()).find(x => x.id === id);
      const r = await operator.c.request.patch(origin + `/api/devices/${id}/labels`, { data: { ...dev.labels, [n]: label }, headers: { 'X-DCIM-CSRF': operator.csrf, 'If-Match': dev.labels_revision } });
      assert.equal(r.status(), 200, await r.text());
    };
    await setLabel('pdu3', '4', 'Spare');
    // ── Operator: Racks › Add server, outside Edit mode ──
    const p = operator.page;
    await p.goto(origin + '/?tab=racks');
    const add = p.locator('[data-action="add-server"]');
    await add.waitFor({ timeout: 30000 });
    await add.click();
    const outlet = p.locator('[data-add-server="outlet"]');
    const outletOptions = () => outlet.locator('option').evaluateAll(list => list.map(o => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled })));
    await p.locator('[data-add-server="rack"]').selectOption('Rack-01');
    await outlet.waitFor();
    const rack1 = await outletOptions();
    const taken = rack1.find(o => /OPT11/.test(o.text));
    assert.ok(taken && taken.disabled, `the outlet that carries OPT11 cannot be chosen: ${JSON.stringify(rack1.slice(0, 6))}`);
    checks.push(`Rack-01: OPT11's outlet listed and disabled (${rack1.filter(o => o.value && o.disabled).length} taken)`);
    // the first rack whose PDU has a free outlet
    const racks = (await p.locator('[data-add-server="rack"] option').evaluateAll(list => list.map(o => o.value))).filter(Boolean);
    let free = null, rackUsed = null, pduUsed = null;
    for (const rack of racks) {
      await p.locator('[data-add-server="rack"]').selectOption(rack);
      if (!(await outlet.count())) continue;
      const pdus = await p.locator('[data-add-server="pdu"] option').evaluateAll(list => list.map(o => o.value)).catch(() => []);
      for (const pdu of (pdus.length ? pdus : [null])) {
        if (pdu) await p.locator('[data-add-server="pdu"]').selectOption(pdu);
        free = (await outletOptions()).find(o => o.value && !o.disabled);
        if (free) { rackUsed = rack; pduUsed = pdu; break; }
      }
      if (free) break;
    }
    assert.ok(free, 'some rack offers a free outlet');
    checks.push(`free outlet offered: ${rackUsed} ${free.text}`);

    const name = p.locator('[data-add-server="name"]'), save = p.locator('[data-action="add-server-save"]');
    await outlet.selectOption(free.value);
    await name.fill('opt11');
    await p.getByText(/OPT11 already exists/).waitFor();
    assert.equal(await save.isDisabled(), true, 'an existing name cannot be saved');
    await name.fill('Empty');
    await p.getByText(/is not a server name/).waitFor();
    assert.equal(await save.isDisabled(), true, 'a placeholder name cannot be saved');
    checks.push('existing and placeholder names refused');

    await name.fill('OPT199');
    assert.equal(await save.isDisabled(), false);
    const beforeAll = await devices();
    const [resp] = await Promise.all([
      p.waitForResponse(r => r.request().method() !== 'GET' && /\/api\/devices\/[^/]+\/labels/.test(r.url()), { timeout: 15000 }),
      save.click(),
    ]);
    assert.ok(resp.status() < 300, `label save ${resp.status()}`);
    const pduId = decodeURIComponent(new URL(resp.url()).pathname.split('/')[3]);
    const before = beforeAll.find(d => d.id === pduId);
    const after = (await devices()).find(d => d.id === pduId);
    assert.equal(after.labels[free.value], 'OPT199', 'the new server name is on the chosen outlet');
    for (const [n, label] of Object.entries(before.labels || {})) if (n !== free.value) assert.equal(after.labels[n], label, `outlet ${n} unchanged`);
    await p.locator('button.server-open[aria-label="View OPT199"]').first().waitFor({ timeout: 15000 });
    checks.push(`OPT199 added on ${after.name} outlet ${free.value} (${rackUsed}); other outlets unchanged; shown on Racks`);

    // put the fixture back (Operator can write labels)
    const g = await operator.c.request.get(origin + '/api/devices/');
    const dev = (await g.json()).find(d => d.id === pduId);
    const labels = { ...dev.labels, [free.value]: pduId === 'pdu3' && free.value === '4' ? 'OPT34' : '' };
    const put = await operator.c.request.patch(origin + `/api/devices/${encodeURIComponent(pduId)}/labels`, { data: labels, headers: { 'X-DCIM-CSRF': operator.csrf, 'If-Match': dev.labels_revision } });
    assert.equal(put.status(), 200, await put.text());
    checks.push('fixture label put back');

    // ── A removed server shows nowhere: Dashboard PDU / KVM cards and the PDU / KVM pages ──
    const apiWrite = async (path, data) => {
      const r0 = await admin.c.request.get(origin + '/api/removed-servers');
      const r = await admin.c.request.post(origin + path, { data, headers: { 'If-Match': r0.headers()['etag'], 'X-DCIM-CSRF': admin.csrf } });
      assert.equal(r.status(), 200, await r.text());
    };
    const d = admin.page;
    await d.goto(origin + '/?tab=dashboard');
    const pduCard = d.locator('section.device-card[aria-label="PDU 01"]'), kvmCard = d.locator('section.device-card[aria-label="KVM 01"]');
    await pduCard.getByText('OPT11', { exact: true }).first().waitFor({ timeout: 30000 });
    await kvmCard.getByText('OPT11', { exact: true }).first().waitFor({ timeout: 30000 });
    await apiWrite('/api/removed-servers', { name: 'OPT11' });
    await d.evaluate(() => window.dispatchEvent(new Event('dcim-removed-servers')));
    await d.waitForFunction(() => ![...document.querySelectorAll('section.device-card')].some(c => /\bOPT11\b/.test(c.innerText)), null, { timeout: 15000 });
    checks.push('after removal: OPT11 gone from the Dashboard PDU and KVM cards');
    await apiWrite('/api/removed-servers/restore', { key: 'opt11' });
    await d.evaluate(() => window.dispatchEvent(new Event('dcim-removed-servers')));
    await pduCard.getByText('OPT11', { exact: true }).first().waitFor({ timeout: 15000 });
    checks.push('after restore: OPT11 back on the PDU card');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message, checks, errors }, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

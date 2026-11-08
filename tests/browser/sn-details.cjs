// Scan & Track > Serial numbers: export (CSV and copy list), import of looked-up details from a pasted table or a file
// with a dry-run preview first, apply ("Mark as switches" only for units of type Other), a stale preview, a unit selected
// for a move that another session moved while details were imported, and the Viewer's read-only list (also at 375 px).
// Runs only against the isolated fixture (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [];
  const runId = Date.now().toString(36).toUpperCase();
  const SN_A = `SNT-${runId}-A`, SN_B = `SNT-${runId}-B`, SN_C = `SNT-${runId}-C`, SN_D = `SNT-${runId}-D`, SN_P = `SNT-${runId}-PDU`, SN_MISSING = `SNT-${runId}-NONE`;

  async function login(username) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(username + ': ' + error.message));
    const writes = [];
    page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
    await page.goto(origin + '/?tab=scan');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('test-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Scan & Track' }).waitFor();
    const csrf = (await (await context.request.get(origin + '/api/auth/status')).json()).csrf_token;
    return { username, context, page, csrf, writes };
  }

  async function api(s, method, path, body, extra = {}) {
    const response = await s.context.request.fetch(origin + path, { method, data: body, headers: { 'X-DCIM-CSRF': s.csrf, ...extra } });
    return { status: response.status(), body: await response.json().catch(() => null), etag: response.headers().etag };
  }
  const etag = async s => (await s.context.request.get(origin + '/api/inventory')).headers().etag;
  async function unit(s, serial) {
    const items = (await (await s.context.request.get(origin + '/api/inventory')).json()).items;
    return items.find(item => item.serial_number === serial);
  }
  async function register(s, serial, name, type, u) {
    const response = await api(s, 'POST', '/api/inventory', { code: serial, serial, name, type, rack: 'Rack-02', u, position: '' }, { 'If-Match': await etag(s) });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }
  const panelTitle = page => page.getByRole('heading', { name: /^Serial numbers · \d+$/ });
  async function openPanel(s) {
    await s.page.goto(origin + '/?tab=scan');
    await panelTitle(s.page).waitFor();
    await s.page.getByRole('table', { name: 'Units with serial numbers' }).getByRole('cell', { name: SN_A, exact: true }).waitFor();
  }
  const NAME_KEPT = 'Name kept: the unit already has its own name. Turn on "Also replace names and models set by hand" to replace it.';
  const previewRow = (page, serial) => page.getByRole('table', { name: /Import (preview|result)/ }).getByRole('row').filter({ hasText: serial });

  async function exportAndCopy(s) {
    const { page } = s;
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export serial numbers' }).click()]);
    assert.equal(download.suggestedFilename(), 'serial-numbers.csv');
    const csv = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    assert.equal(csv[0], 'serial,barcode,name,type,part_number,model,rack,u,position,place,lookup_as');
    const rows = csv.slice(1).map(line => line.split(','));
    assert.ok(rows.every(row => row[10] === 'switch'), 'every serial number is looked up as a switch');
    const firstOther = rows.findIndex(row => row[3] !== 'switch');
    assert.ok(firstOther === -1 || rows.slice(firstOther).every(row => row[3] !== 'switch'), 'switches come first');
    assert.ok(rows.some(row => row[0] === SN_A && row[3] === 'other'), 'the new unit is exported');
    checks.push(`${s.username}: CSV export lists every serial number, switches first, each to be looked up as a switch`);

    const list = await page.getByRole('textbox', { name: 'Serial number list' }).inputValue();
    const lines = list.split('\n');
    assert.ok(lines.includes(SN_A) && lines.includes('TEST-001'), 'one serial number per line');
    await page.getByRole('button', { name: 'Copy serial numbers' }).click();
    await page.getByText(/^(Copied \d+ serial numbers?\.|Press Ctrl\+C to copy the selected list\.)$/).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    if (copied !== null) assert.equal(copied.replace(/\r\n/g, '\n'), list, 'Windows reads the copied lines back with CRLF');
    checks.push(`${s.username}: the serial numbers are listed one per line and copied to the clipboard`);
  }

  async function pasteImport(s) {
    const { page } = s;
    const before = await unit(s, SN_A);
    await page.getByRole('textbox', { name: 'Paste details' }).fill(
      `SN analysis results\nSN\tP/N\tDescription\n${SN_A}\tMSN2700-CS2F\tSpectrum SN2700 switch\n${SN_B}\tMQM9700-NS2F\tQuantum-2 QM9700\n` +
      `${SN_P}\tPX3-5190V\tRaritan PX3\n${SN_MISSING}\tX-1\tNothing\n\tMCX1\tNo serial\n`);
    assert.equal(await page.getByRole('checkbox', { name: /Mark unidentified units as switches/ }).isChecked(), true, 'marking switches is on by default');
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await page.getByRole('status').filter({ hasText: 'Preview: 3 will change · 0 unchanged · 1 not found.' }).waitFor();
    await page.getByText('Columns found: Serial number, Part number, Name · 4 rows to check · 1 row left out.').waitFor();
    await page.getByRole('list', { name: 'Rows left out' }).getByText('Line 7: No serial number').waitFor();
    const a = previewRow(page, SN_A);
    for (const text of ['Will change', 'Name: Unit → Spectrum SN2700 switch', 'Type: other → switch', 'Part number: empty → MSN2700-CS2F']) await a.getByText(text, { exact: false }).first().waitFor();
    const b = previewRow(page, SN_B);
    assert.match(await b.innerText(), /Part number:\s*empty\s*→\s*MQM9700-NS2F/);
    assert.doesNotMatch(await b.innerText(), /Name:/, 'a name set by hand is kept');
    await b.getByText(NAME_KEPT, { exact: true }).waitFor();
    const pdu = await previewRow(page, SN_P).innerText();
    assert.match(pdu, /Part number:\s*empty\s*→\s*PX3-5190V/);
    assert.doesNotMatch(pdu, /Type:/, 'a PDU is not marked as a switch');
    assert.match(await previewRow(page, SN_MISSING).innerText(), /Not found/);
    assert.deepEqual(await unit(s, SN_A), before, 'a preview writes nothing');
    checks.push(`${s.username}: a pasted table with a title line is previewed (dry run) per unit, only a unit of type Other becomes a switch, nothing is written`);

    // Replacing hand-set names re-runs the preview at once; turning it off again goes back.
    await page.getByRole('checkbox', { name: 'Also replace names and models set by hand' }).check();
    await b.getByText('Name: Lab core switch → Quantum-2 QM9700', { exact: false }).waitFor();
    await page.getByRole('checkbox', { name: 'Also replace names and models set by hand' }).uncheck();
    await page.waitForFunction(sn => ![...document.querySelectorAll('table[aria-label="Import preview"] tr')].some(r => r.textContent.includes(sn) && r.textContent.includes('Name:')), SN_B);
    checks.push(`${s.username}: the options re-run the preview`);

    s.writes.length = 0;
    await page.getByRole('button', { name: 'Apply 3 changes' }).click();
    await page.getByRole('status').filter({ hasText: 'Applied: 3 updated · 0 unchanged · 1 not found.' }).waitFor();
    assert.deepEqual(s.writes, ['/api/inventory/serial-details'], 'one request applies every row');
    const after = await unit(s, SN_A);
    assert.equal(after.name, 'Spectrum SN2700 switch'); assert.equal(after.type, 'switch'); assert.equal(after.part_number, 'MSN2700-CS2F');
    assert.equal(after.u, before.u); assert.equal(after.rack, before.rack);
    const event = after.tracking_history.at(-1);
    assert.equal(event.action, 'details updated'); assert.match(event.note, /^Details from webpe SN analysis: /);
    const kept = await unit(s, SN_B);
    assert.equal(kept.name, 'Lab core switch'); assert.equal(kept.part_number, 'MQM9700-NS2F');
    const pduUnit = await unit(s, SN_P);
    assert.equal(pduUnit.type, 'pdu'); assert.equal(pduUnit.part_number, 'PX3-5190V');
    // The unit list on the page shows the new name without a reload.
    await page.getByRole('table', { name: 'Units with serial numbers' }).getByRole('row').filter({ hasText: SN_A }).getByText('Spectrum SN2700 switch').waitFor();
    checks.push(`${s.username}: Apply sets P/N, the product name of a generic unit and the switch type, and records the history`);

    await page.getByRole('button', { name: 'Preview changes' }).click();
    await page.getByRole('status').filter({ hasText: 'Preview: 0 will change · 3 unchanged · 1 not found. Nothing to apply.' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Apply 0 changes' }).isDisabled(), true);
    checks.push(`${s.username}: importing the same details again changes nothing`);
  }

  async function fileImportAndStalePreview(s) {
    const { page } = s;
    await page.getByLabel('Details file').setInputFiles({ name: 'webpe.csv', mimeType: 'text/csv',
      buffer: Buffer.from(`﻿Serial Number,Part Number,Product Name\r\n${SN_C},MQM8700-HS2F,"Quantum QM8700, 1U"\r\n`) });
    await page.getByText('webpe.csv').waitFor();
    assert.match(await page.getByRole('textbox', { name: 'Paste details' }).inputValue(), /Serial Number,Part Number/);
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await previewRow(page, SN_C).getByText('Name: Unit → Quantum QM8700, 1U', { exact: false }).waitFor();
    // Someone else changes the inventory after the preview: Apply is refused and nothing is written.
    const moved = await api(s, 'POST', `/api/inventory/${encodeURIComponent((await unit(s, SN_B)).id)}/location`, { rack: 'Rack-02', u: 33, position: 'x' }, { 'If-Match': await etag(s) });
    assert.equal(moved.status, 200);
    await page.getByRole('button', { name: 'Apply 1 change' }).click();
    await page.getByRole('alert').filter({ hasText: 'Equipment changed in another session since the preview. Preview again, then apply.' }).waitFor();
    assert.equal((await unit(s, SN_C)).name, 'Unit');
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await page.getByRole('button', { name: 'Apply 1 change' }).click();
    await page.getByRole('status').filter({ hasText: 'Applied: 1 updated' }).waitFor();
    assert.equal((await unit(s, SN_C)).name, 'Quantum QM8700, 1U');
    checks.push(`${s.username}: a CSV file imports too, and a preview made stale by another change is refused until previewed again`);

    await page.getByRole('textbox', { name: 'Paste details' }).fill('Name,P/N\nA,B\n');
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await page.getByRole('alert').filter({ hasText: 'No serial number column found.' }).waitFor();
    checks.push(`${s.username}: a table without a serial number column is explained`);
  }

  async function moveDuringImport(s) {
    const { page } = s;
    const other = await login('admin');
    await page.getByRole('textbox', { name: 'Scan barcode' }).fill(SN_D);
    await page.getByRole('button', { name: 'Find barcode' }).click();
    await page.getByRole('button', { name: 'Save and confirm location' }).waitFor();
    assert.equal(await page.getByLabel('Destination shelf').first().inputValue(), '27');
    const moved = await api(other, 'POST', `/api/inventory/${encodeURIComponent((await unit(other, SN_D)).id)}/location`, { rack: 'Rack-02', u: 26, position: '' }, { 'If-Match': await etag(other) });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    await other.context.close();
    await page.getByRole('textbox', { name: 'Paste details' }).fill(`SN\tModel\n${SN_A}\tSN2700\n`);
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await page.getByRole('button', { name: 'Apply 1 change' }).click();
    await page.getByRole('status').filter({ hasText: 'Applied: 1 updated' }).waitFor();
    await page.getByText('Inventory refreshed after the import. Review the current location before saving.').waitFor();
    assert.equal(await page.getByLabel('Destination shelf').first().inputValue(), '26', 'the destination is where the unit is now');
    await page.getByRole('button', { name: 'Save and confirm location' }).click();
    await page.getByText(/^Saved: /).waitFor();
    assert.equal((await unit(s, SN_D)).u, 26, 'the other session\'s move is kept');
    checks.push(`${s.username}: after an import, a unit selected for a move shows where another session moved it, and saving does not move it back`);
  }

  async function viewer() {
    const s = await login('viewer');
    const { page } = s;
    await openPanel(s);
    await page.getByRole('note').filter({ hasText: 'Importing details requires the Operator or Admin role.' }).waitFor();
    for (const name of ['Paste details', 'Details file']) assert.equal(await page.getByLabel(name, { exact: true }).count(), 0, name);
    assert.equal(await page.getByRole('button', { name: 'Preview changes' }).count(), 0);
    const row = page.getByRole('table', { name: 'Units with serial numbers' }).getByRole('row').filter({ hasText: SN_A });
    assert.match(await row.innerText(), /Spectrum SN2700 switch\s+switch\s+MSN2700-CS2F/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export serial numbers' }).click()]);
    assert.equal(download.suggestedFilename(), 'serial-numbers.csv');
    const refused = await api(s, 'POST', '/api/inventory/serial-details', { items: [{ serial: SN_A, name: 'x' }], dry_run: true });
    assert.equal(refused.status, 403);
    assert.deepEqual(s.writes, ['/api/auth/login'], 'the Viewer page never writes');
    // On a phone the page does not scroll sideways and serial numbers are not broken mid-code.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= 375);
    const cell = page.getByRole('table', { name: 'Units with serial numbers' }).getByRole('cell', { name: SN_A, exact: true });
    assert.equal(await cell.evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
    checks.push('viewer: sees and exports the serial number list, cannot import; at 375 px no sideways page scroll, codes unbroken');
    await s.context.close();
  }

  try {
    const s = await login('operator');
    await s.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await register(s, SN_A, 'Unit', 'other', 30);
    await register(s, SN_B, 'Lab core switch', 'switch', 31);
    await register(s, SN_C, 'Unit', 'other', 32);
    await register(s, SN_D, 'Unit', 'other', 27);
    await register(s, SN_P, 'PDU 2B', 'pdu', 29);
    await openPanel(s);
    await exportAndCopy(s);
    await pasteImport(s);
    await moveDuringImport(s);
    await fileImportAndStalePreview(s);
    await s.context.close();
    await viewer();
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    console.log(JSON.stringify({ passed: checks, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

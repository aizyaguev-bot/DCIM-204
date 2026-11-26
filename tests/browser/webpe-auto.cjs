// Automatic webpe lookup (tools/webpe-sync/sync.cjs --watch) end to end, with a local mock of webpe only:
// Edge with remote debugging on two tabs (the fixture DCIM signed in as operator, the mock webpe), the watcher as a child
// process. A unit added with a serial number and no P/N gets its P/N, model, name and type switch within seconds; a typed
// name is kept; an unknown SN is not asked again every cycle; the scan dialog says the P/N will be filled; a webpe
// sign-out shows "webpe sign-in needed" (API and Serial numbers panel) and is retried after sign-in; the status says
// Active, then Not running once the watcher stops. A check slowed by a backlog keeps reporting (stays Active), and a
// row DCIM refuses (an over-long P/N) does not stop the other units of the same check from being filled. The watcher's
// output never shows the CSRF token.
// Runs only against the isolated fixture (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1); never real webpe.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const cdpPort = Number(process.env.WEBPE_TEST_CDP_PORT || Number(new URL(origin).port) + 1);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const LAUNCHER = 'tools/webpe-sync/start-webpe-sync.cmd';
const FILL_NOTE = 'P/N and name will be filled from webpe within a minute.';

async function until(what, check, timeout = 15000, step = 250) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { last = await check(); if (last) return last; await sleep(step); }
  throw new Error(`Timed out waiting for: ${what}`);
}

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const runId = Date.now().toString(36).toUpperCase();
  const SN_A = `WPA-${runId}-A`, SN_B = `WPA-${runId}-B`, SN_X = `WPA-${runId}-UNKNOWN`, SN_L = `WPA-${runId}-LATE`, SN_S = `WPA${runId}S`;
  const SN_BAD = `WPA-${runId}-BAD`, SN_OK = `WPA-${runId}-OK`, SLOW = [1, 2, 3].map(n => `WPA-${runId}-SLOW${n}`);
  const RECORDS = {
    [SN_A]: [{ SN: SN_A, PN: '920-9N42F-00RI-7C0', PN_DESCRIPTION: 'NVIDIA CHAMELEON SPC5 LIQUID COOLED ETH SWITCH 64X800G', PRODUCT_LINE: 'SPECTRUM-5' }],
    [SN_B]: [{ SN: SN_B, PN: 'MQM9790-NS2F', PN_DESCRIPTION: 'NVIDIA QUANTUM-2 QM9790 IB SWITCH 64X400G', PRODUCT_LINE: 'QUANTUM-2' }],
    [SN_L]: [{ SN: SN_L, PN: '920-9B210-00FN-0D0', PN_DESCRIPTION: 'CHAMELEON-6S, SPECTRUM-6 ETH SWITCH', PRODUCT_LINE: 'SPECTRUM-6' }],
    [SN_S]: [{ SN: SN_S, PN: 'MSN2700-CS2F', PN_DESCRIPTION: 'NVIDIA SPECTRUM SN2700 ETH SWITCH 32X100G', PRODUCT_LINE: 'SPECTRUM' }],
    // A P/N longer than DCIM stores (120): DCIM refuses this row.
    [SN_BAD]: [{ SN: SN_BAD, PN: 'P'.repeat(130), PN_DESCRIPTION: 'NVIDIA ODD ETH SWITCH', PRODUCT_LINE: 'ODD' }],
    [SN_OK]: [{ SN: SN_OK, PN: 'MQM8790-HS2F', PN_DESCRIPTION: 'NVIDIA QUANTUM QM8790 IB SWITCH 40X200G', PRODUCT_LINE: 'QUANTUM' }],
  };
  for (const sn of SLOW) RECORDS[sn] = [{ SN: sn, PN: 'MSN4600-CS2F', PN_DESCRIPTION: 'NVIDIA SPECTRUM-3 SN4600 ETH SWITCH', PRODUCT_LINE: 'SPECTRUM-3' }];

  // ---- the mock webpe: an HTML page and the SN analysis API; 401 while "signed out" ----
  // slow: SN -> milliseconds webpe takes to answer; times: SN -> [asked at, answered at].
  const mock = { signedOut: false, asked: {}, slow: {}, times: {} };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname === '/rest/rawdata/history/getSnData/v2') {
      const sn = url.searchParams.get('SN') || '';
      mock.asked[sn] = (mock.asked[sn] || 0) + 1;
      if (mock.signedOut) { res.writeHead(401, { 'Content-Type': 'text/html' }); return res.end('<html>Sign in</html>'); }
      const started = Date.now();
      return setTimeout(() => {
        mock.times[sn] = [started, Date.now()];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(RECORDS[sn] || []));
      }, mock.slow[sn] || 0);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>SN analysis (mock)</title><h1>SN analysis (mock webpe)</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const webpeOrigin = `http://127.0.0.1:${server.address().port}`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webpe-auto-'));
  const profile = path.join(tmp, 'edge-profile'), appData = path.join(tmp, 'localappdata');
  fs.mkdirSync(appData);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'msedge', viewport: { width: 1440, height: 1000 },
    args: [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1'],
  });
  const errors = [], checks = [], created = [];
  let child = null, out = '', csrf = '';
  const allowed = url => url.startsWith(origin + '/') || url.startsWith(webpeOrigin + '/');
  await context.route('**/*', route => (allowed(route.request().url()) ? route.continue() : route.abort()));
  await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });

  const api = async (method, p, body, extra = {}) => {
    const response = await context.request.fetch(origin + p, { method, data: body, headers: { 'X-DCIM-CSRF': csrf, ...extra } });
    return { status: response.status(), body: await response.json().catch(() => null), etag: response.headers().etag };
  };
  const unit = async serial => (await api('GET', '/api/inventory')).body.items.find(item => item.serial_number === serial || item.barcode === serial);
  const status = async () => (await api('GET', '/api/inventory/webpe-status')).body;
  async function register(serial, name, type, u) {
    const response = await api('POST', '/api/inventory', { code: serial, serial, name, type, rack: 'Rack-02', u, position: '' }, { 'If-Match': (await api('GET', '/api/inventory')).etag });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    created.push(response.body.id);
    return Date.now();
  }
  const panelLine = page => page.locator('section [data-webpe-status]');
  async function panelText(page) {
    await page.goto(origin + '/?tab=scan');
    await page.getByRole('heading', { name: /^Serial numbers · \d+$/ }).waitFor();
    await panelLine(page).waitFor();
    return panelLine(page).innerText();
  }

  try {
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    const dcim = context.pages()[0] || await context.newPage();
    dcim.on('pageerror', error => errors.push('dcim: ' + error.message));
    await dcim.goto(origin + '/?tab=scan');
    await dcim.getByLabel('Username', { exact: true }).fill('operator');
    await dcim.getByLabel('Password', { exact: true }).fill('test-password-123');
    await dcim.getByRole('button', { name: 'Sign in', exact: true }).click();
    await dcim.getByRole('heading', { name: 'Scan & Track' }).waitFor();
    csrf = (await (await context.request.get(origin + '/api/auth/status')).json()).csrf_token;
    assert.ok(csrf, 'signed in with accounts');
    const webpe = await context.newPage();
    await webpe.goto(webpeOrigin + '/sn-analysis');
    // A second page for the site checks, so the watcher's DCIM tab is never navigated away while it works.
    const view = await context.newPage();
    view.on('pageerror', error => errors.push('view: ' + error.message));

    // Before the watcher runs: the panel says it is not running and how to start it.
    assert.match(await panelText(view), new RegExp(`^webpe auto lookup: Not running( \\(last seen [^)]+\\))? — start ${LAUNCHER} on the lab laptop$`));

    child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'tools', 'webpe-sync', 'sync.cjs'), '--watch'], {
      env: { ...process.env, WEBPE_CDP: `http://127.0.0.1:${cdpPort}`, WEBPE_ORIGIN: webpeOrigin, DCIM_URL: origin, WEBPE_INTERVAL: '2', LOCALAPPDATA: appData },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    await until('the first heartbeat', async () => (await status()).active, 20000);
    checks.push('the watcher connects over CDP to the DCIM and webpe tabs and reports a heartbeat (Active)');

    // A new unit with a serial number and no P/N is filled from webpe within seconds.
    const addedAt = await register(SN_A, 'Unit', 'other', 33);
    await register(SN_B, 'Lab core switch', 'other', 34);
    await register(SN_X, 'Unit', 'other', 35);
    const a = await until('the new unit filled from webpe', async () => { const u = await unit(SN_A); return u?.part_number ? u : null; }, 15000);
    const took = (Date.now() - addedAt) / 1000;
    assert.ok(took <= 10, `filled in ${took} s`);
    assert.deepEqual([a.part_number, a.model, a.name, a.type], ['920-9N42F-00RI-7C0', 'SPECTRUM-5', 'CHAMELEON SPC5', 'switch']);
    assert.ok(a.tracking_history.some(h => h.action === 'details updated' && /webpe SN analysis \(auto\)/.test(h.note || '')), 'history names the automatic lookup');
    checks.push(`a unit added with a serial number and no P/N got P/N, model, product name and type switch in ${took.toFixed(1)} s`);
    const b = await until('the named unit filled', async () => { const u = await unit(SN_B); return u?.part_number ? u : null; }, 10000);
    assert.deepEqual([b.part_number, b.model, b.name, b.type], ['MQM9790-NS2F', 'QUANTUM-2', 'Lab core switch', 'switch']);
    checks.push('a unit with a typed name keeps it; its P/N, model and type are filled');

    // An unknown SN is asked once, not every 2 s cycle.
    await until('the unknown SN asked', async () => mock.asked[SN_X] >= 1, 10000);
    await sleep(7000);
    assert.equal(mock.asked[SN_X], 1, 'unknown SN looked up once');
    assert.equal(mock.asked[SN_A], 1, 'a filled SN is not looked up again');
    assert.equal((await unit(SN_X)).part_number || '', '');
    checks.push('an SN webpe does not know is looked up once and not again every cycle (retried after 6 h)');

    let st = await status();
    assert.equal(st.active, true);
    assert.equal(st.last_error, null);
    assert.ok(st.looked_up_today >= 2, JSON.stringify(st));
    assert.equal(st.interval, 2);
    assert.match(await panelText(view), /^webpe auto lookup: Active · last check \d\d:\d\d · \d+ looked up today$/);
    checks.push(`GET webpe-status is active with ${st.looked_up_today} looked up today; the Serial numbers panel says Active`);

    // The scan dialog: a scanned serial number with no P/N is promised to be filled, and it is.
    await view.goto(origin + '/?tab=racks');
    const opt = view.locator('[data-rack-id="Rack-02"] .server-cell[data-server="OPT22"]');
    await opt.waitFor();
    await view.locator('[data-rack-id="Rack-02"] button.server-open[aria-label="View OPT22"]').click();
    await view.getByRole('dialog', { name: 'OPT22' }).getByRole('button', { name: 'Scan barcode' }).click();
    const dialog = view.getByRole('dialog', { name: 'Scan unit barcode' });
    await dialog.waitFor();
    await dialog.locator('[data-webpe-status="active"]').filter({ hasText: /^webpe auto lookup: Active · / }).waitFor();
    await view.waitForFunction(() => document.activeElement?.name === 'unit-barcode');
    await view.keyboard.type(SN_S); await view.keyboard.press('Enter');
    await dialog.locator('.scan-unit-log > li[data-action="created"]').filter({ hasText: FILL_NOTE }).waitFor();
    const scanned = await until('the scanned unit filled', async () => { const u = await unit(SN_S); return u?.part_number ? u : null; }, 15000);
    created.push(scanned.id);
    assert.deepEqual([scanned.part_number, scanned.name, scanned.type], ['MSN2700-CS2F', 'SPECTRUM SN2700', 'switch']);
    await view.keyboard.press('Escape');
    checks.push('scan dialog: shows the lookup status and "P/N and name will be filled from webpe within a minute" for a new serial; it was filled');

    // Signed out of webpe: reported, nothing is marked as looked up, and it is filled after signing in again.
    mock.signedOut = true;
    await register(SN_L, 'Unit', 'other', 36);
    st = await until('webpe sign-in needed', async () => { const s = await status(); return /^webpe sign-in needed/.test(s.last_error || '') ? s : null; }, 15000);
    assert.equal(st.active, true);
    assert.equal(await panelText(view), 'webpe sign-in needed on the lab laptop');
    assert.equal((await unit(SN_L)).part_number || '', '');
    checks.push('webpe signed out (401): GET webpe-status and the Serial numbers panel say "webpe sign-in needed"; the watcher keeps running');
    mock.signedOut = false;
    const late = await until('the unit filled after sign-in', async () => { const u = await unit(SN_L); return u?.part_number ? u : null; }, 15000);
    assert.deepEqual([late.part_number, late.name], ['920-9B210-00FN-0D0', 'CHAMELEON-6S']);
    await until('the error cleared', async () => (await status()).last_error === null, 10000);
    checks.push('after signing in again the waiting unit is filled and the error clears');

    // One check with a backlog: three slow webpe answers (1.5 s each, longer than the 2 s interval together), a row DCIM
    // refuses and a good one. Added while webpe is signed out, so the next check takes all five at once.
    for (const sn of SLOW) mock.slow[sn] = 1500;
    mock.signedOut = true;
    let u = 37;
    for (const sn of [SN_BAD, SN_OK, ...SLOW]) await register(sn, 'Unit', 'other', u++);
    await until('webpe sign-in needed again', async () => /^webpe sign-in needed/.test((await status()).last_error || ''), 15000);
    const asked = { ...mock.asked };
    mock.signedOut = false;
    const seen = [];
    let refused = null;
    await until('the backlog filled', async () => {
      const s = await status();
      seen.push(Date.parse(s.last_check));
      if (/^DCIM refused the webpe details of /.test(s.last_error || '')) refused = s;
      const units = await Promise.all([SN_OK, ...SLOW].map(unit));
      return units.every(x => x?.part_number);
    }, 30000, 200);
    const firstSlow = Math.min(...SLOW.map(sn => mock.times[sn][0])), lastSlow = Math.max(...SLOW.map(sn => mock.times[sn][1]));
    assert.ok(lastSlow - firstSlow >= 4000, `the slow lookups took ${lastSlow - firstSlow} ms`);
    assert.ok(seen.some(t => t > firstSlow && t < lastSlow), 'a status report arrived while the slow lookups were running');
    checks.push(`a check slowed by webpe (${((lastSlow - firstSlow) / 1000).toFixed(1)} s of lookups, interval 2 s) reported its status while it ran, so the site stays Active`);
    const ok = await unit(SN_OK);
    assert.deepEqual([ok.part_number, ok.model, ok.name, ok.type], ['MQM8790-HS2F', 'QUANTUM', 'QUANTUM QM8790', 'switch']);
    assert.equal((await unit(SN_BAD)).part_number || '', '');
    if (!refused) refused = await until('the refusal reported', async () => { const s = await status(); return /^DCIM refused/.test(s.last_error || '') ? s : null; }, 5000, 100).catch(() => null);
    assert.ok(refused, 'the refused row is reported in the status');
    await sleep(6000);
    assert.equal(mock.asked[SN_BAD] - (asked[SN_BAD] || 0), 1, 'the refused SN is not looked up again every cycle');
    assert.equal(mock.asked[SN_OK] - (asked[SN_OK] || 0), 1, 'a filled SN is not looked up again');
    assert.equal((await status()).last_error, null);
    checks.push('a row DCIM refuses (P/N over 120 characters) is reported once and waits 6 h; the other units of the same check are filled');

    // Stopped: Not running, with the last time it was seen and how to start it.
    child.kill();
    await new Promise(resolve => (child.exitCode !== null || child.signalCode ? resolve() : child.once('exit', resolve)));
    child = null;
    st = await until('Not running', async () => { const s = await status(); return s.active ? null : s; }, 15000);
    assert.match(await panelText(view), new RegExp(`^webpe auto lookup: Not running \\(last seen \\d\\d:\\d\\d\\) — start ${LAUNCHER} on the lab laptop$`));
    checks.push('after the watcher stops the status turns Not running (last seen HH:MM) with the launcher to start');

    assert.ok(!out.includes(csrf), 'the watcher never prints the CSRF token');
    assert.doesNotMatch(out, /csrf|cookie|password/i);
    checks.push('the watcher output has no CSRF token, cookie or password');
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    console.log(JSON.stringify({ passed: checks, errors, watcher_output: out.trim().split(/\r?\n/).slice(-12) }, null, 2));
  } finally {
    if (child) child.kill();
    // Clean up: remove the units this run added (one whole-list save with If-Match, like the scan dialog's Undo).
    try {
      if (created.length && csrf) {
        const got = await context.request.get(origin + '/api/rack-items');
        const data = await got.json();
        const next = Object.fromEntries(Object.entries(data).map(([rack, list]) => [rack, list.filter(item => !created.includes(item.id))]));
        const put = await context.request.put(origin + '/api/rack-items', { data: next, headers: { 'If-Match': got.headers().etag, 'X-DCIM-CSRF': csrf } });
        if (put.status() !== 200) { console.error('cleanup: rack-items PUT', put.status(), (await put.text()).slice(0, 200)); process.exitCode = 1; }
        const left = (await (await context.request.get(origin + '/api/inventory')).json()).items.filter(item => created.includes(item.id));
        if (left.length) { console.error(`cleanup: ${left.length} test units are still in the fixture`); process.exitCode = 1; }
        else console.log(`cleanup: removed the ${created.length} units this run added`);
      }
    } catch (error) { console.error('cleanup:', error.message); }
    await context.close().catch(() => {});
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

// SSH UI in the browser: Admin → SSH (sign-in keys switch, "Allow every server with an address", skipped list,
// keyboard use, key column in the session log) and the terminal page (connects by itself, fixed failure sentence,
// key-install command, Reconnect, unavailable server, Viewer). Runs only against tests/browser/preview-server.py
// (DCIM_TEST_ACCOUNTS=1, optionally DCIM_PREVIEW_DIST=<build>). /api/ssh and the terminal WebSocket are simulated in
// the browser, so no SSH server, VM or lab machine is contacted and the fixture's SSH settings are never written.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = (process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8961').replace(/\/$/, '');
const PASSWORD = 'test-password-123';
const FP = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SKIP_REASON = 'The VM cannot find an IP address for opt13. Give this server its IP address in Ping Monitor (or fix its name in DNS), then approve it again.';

(async () => {
  const url = new URL(origin);
  assert.equal(url.hostname, '127.0.0.1', 'Use the isolated local fixture only');
  assert.notEqual(url.port, '8000', 'Never the real site port');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], blocked = [], checks = [];
  const ok = text => { checks.push(text); console.log('ok -', text); };
  const until = async (fn, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
      await new Promise(r => setTimeout(r, 100));
    }
  };

  // Simulated /api/ssh backend (contract of v2.42): one saved config, revision bumped on every PUT.
  const sim = {
    revision: 1, puts: [], sockets: [],
    config: { default_user: 'root', per_server_user: {}, targets: {}, denied: [], auto_allow: false, key_source: 'vm' },
  };
  const SERVERS = [
    { key: 'opt11', name: 'OPT11', host: 'opt11.lab' },
    { key: 'opt12', name: 'OPT12', host: 'opt12.lab' },
    { key: 'opt13', name: 'OPT13', host: 'opt13' },
  ];
  function approval(s) {
    const c = sim.config;
    if (c.denied.includes(s.key)) return ['denied', 'SSH is not allowed for this server: an Admin turned it off'];
    if (c.auto_allow) return s.key === 'opt13' ? ['skipped', SKIP_REASON] : ['auto', ''];
    return c.targets[s.key] ? ['explicit', ''] : ['none', 'An Admin must approve this SSH target first'];
  }
  function status(role) {
    const operator = role !== 'Viewer';
    const servers = SERVERS.map(s => {
      const [state, reason] = approval(s);
      const allowed = state === 'auto' || state === 'explicit';
      const row = { key: s.key, name: s.name, host_key: { fingerprint: s.key === 'opt11' ? FP : '', confirmed: true, offered_fingerprint: '' },
        approved: allowed, allowed, approval: state, address_changed: false };
      if (operator) Object.assign(row, { host: s.host, approved_host: allowed ? s.host : '', user: 'root', not_allowed_reason: reason });
      return row;
    });
    const out = { enabled: true, available: true, transport_allowed: true, insecure_transport_allowed: true, blocked_reason: '',
      installed: true, key_exists: true, public_key_fingerprint: FP, auto_allow: sim.config.auto_allow, servers };
    if (operator) Object.assign(out, { default_user: 'root', key_source: sim.config.key_source });
    if (role === 'Admin') out.config_revision = `"rev-${sim.revision}"`;
    return out;
  }

  async function login(username, role) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', async route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) { blocked.push(request.url()); return route.abort(); }
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/ssh/')) return route.continue();
      const reply = (body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
      if (role === 'Viewer' && path !== '/api/ssh/status') return reply({ detail: 'Your role does not allow this action' }, 403);
      if (path === '/api/ssh/status') return reply(status(role));
      if (path === '/api/ssh/config' && request.method() === 'GET') {
        return reply({ ...sim.config, auto_skipped: {}, vm_keys: [
          { name: 'id_ed25519', type: 'ssh-ed25519', usable: true, reason: '' },
          { name: 'id_rsa', type: 'ssh-rsa', usable: false, reason: 'The key is protected by a passphrase' }] });
      }
      if (path === '/api/ssh/config' && request.method() === 'PUT') {
        const body = JSON.parse(request.postData() || '{}');
        const ifMatch = request.headers()['if-match'];
        sim.puts.push({ body, ifMatch });
        if (ifMatch !== `"rev-${sim.revision}"`) return reply({ detail: 'SSH configuration has changed' }, 412);
        if (body.allowed) { body.targets = body.allowed; delete body.allowed; }
        Object.assign(sim.config, body);
        sim.revision++;
        const skipped = body.auto_allow ? [{ key: 'opt13', name: 'OPT13', host: 'opt13', reason: SKIP_REASON }] : [];
        return reply({ ...sim.config, ...(skipped.length ? { skipped } : {}) });
      }
      if (path === '/api/ssh/key') {
        const only = new URL(request.url()).searchParams.get('server');
        const rows = SERVERS.filter(s => !only || s.key === only).map(s => ({ server: s.name, key: s.key,
          command: `printf '%s\\n' 'from="192.0.2.50",no-agent-forwarding ssh-ed25519 AAAATEST dcim-204-20261025-abcdef' >> ~/.ssh/authorized_keys # ${s.key}` }));
        return reply({ public_key: 'ssh-ed25519 AAAATEST dcim-204-20261025-abcdef', fingerprint: FP, install: rows, revoke: [] });
      }
      if (path === '/api/ssh/sessions') {
        return reply([{ id: 1, event: 'terminal', user: 'admin', server_key: 'opt11', host: 'opt11.lab', started_at: '2026-10-25T07:00:00Z',
          ended_at: '2026-10-25T07:05:00Z', end_reason: 'remote_closed', bytes_in: 10, bytes_out: 2048, key_source: 'vm', key_type: 'ssh-ed25519', key_name: 'id_ed25519' },
          { id: 2, event: 'terminal', user: 'admin', server_key: 'opt12', host: 'opt12.lab', started_at: '2026-10-25T07:06:00Z',
          ended_at: '2026-10-25T07:06:01Z', end_reason: 'auth_failed', bytes_in: 0, bytes_out: 0, key_source: 'vm' }]);
      }
      return reply({ detail: 'Not Found' }, 404);
    });
    // Terminal WebSocket: the first message must be the CSRF auth; then the scripted server answers.
    await context.routeWebSocket(/\/api\/ssh\/[^/]+\/terminal$/, ws => {
      const socket = { url: ws.url(), messages: [], role };
      sim.sockets.push(socket);
      const n = sim.sockets.filter(s => s.role === role).length;
      ws.onMessage(raw => {
        const msg = JSON.parse(String(raw));
        socket.messages.push(msg);
        if (msg.type !== 'auth') return;
        ws.send(JSON.stringify({ type: 'status', state: 'connecting', reason: '' }));
        if (socket.url.endsWith('/opt12/terminal') && n === 1) {
          ws.send(JSON.stringify({ type: 'status', state: 'closed', reason: 'auth_failed' }));
          ws.close({ code: 1011, reason: 'auth_failed' });
        } else {
          ws.send(JSON.stringify({ type: 'status', state: 'connected', reason: '' }));
          ws.send(JSON.stringify({ type: 'output', data: 'root@opt12:~# ' }));
        }
      });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${username}: ${error.message}`));
    await page.goto(origin + '/');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForFunction(() => typeof window.__dcimAccountTransport?.csrf === 'string' && window.__dcimAccountTransport.csrf.length > 0);
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    return { context, page };
  }

  try {
    // ── Admin → SSH ───────────────────────────────────────────────────────────────────────────────
    const { context: adminContext, page } = await login('admin', 'Admin');
    await page.goto(origin + '/?tab=admin&section=ssh');
    await page.getByRole('heading', { name: 'Sign-in keys' }).waitFor();
    await page.getByText("Keys used: this VM account's SSH keys, then the Lab Manager key", { exact: true }).waitFor();
    const keySwitch = page.getByRole('switch', { name: /Use this VM account's SSH keys/ });
    assert.equal(await keySwitch.getAttribute('aria-checked'), 'true');
    await page.getByText('id_ed25519', { exact: true }).first().waitFor();
    await page.getByText('Not used: The key is protected by a passphrase').waitFor();
    ok('Admin sees the key source "vm" and the VM account key files');

    await keySwitch.click();
    await page.getByText('Keys used: only the Lab Manager key', { exact: true }).waitFor();
    assert.deepEqual(sim.puts.at(-1), { body: { key_source: 'site' }, ifMatch: '"rev-1"' });
    assert.equal(await keySwitch.getAttribute('aria-checked'), 'false');
    await page.getByText('Lab Manager now signs in with the Lab Manager key only.').waitFor();
    // Keyboard: Space on the focused switch turns it back on.
    await keySwitch.focus();
    await page.keyboard.press('Space');
    await page.getByText("Keys used: this VM account's SSH keys, then the Lab Manager key", { exact: true }).waitFor();
    assert.deepEqual(sim.puts.at(-1), { body: { key_source: 'vm' }, ifMatch: '"rev-2"' });
    ok('the key source switch saves only key_source with If-Match, by mouse and by keyboard');

    const autoSwitch = page.getByRole('switch', { name: /Allow every server with an address/ });
    assert.equal(await autoSwitch.getAttribute('aria-checked'), 'false');
    // Unsaved table edits lock the switch until they are saved or discarded.
    await page.getByLabel('SSH user for OPT12').fill('lab');
    await page.getByText('Save or discard the changes below before switching this.').waitFor();
    await until(() => autoSwitch.isDisabled(), 'the switch to lock');
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await until(async () => !(await autoSwitch.isDisabled()), 'the switch to unlock');
    await autoSwitch.click();
    await page.getByText('Every server with an address is now allowed. 1 server has no usable address (listed below).').waitFor();
    assert.deepEqual(sim.puts.at(-1), { body: { auto_allow: true }, ifMatch: '"rev-3"' });
    assert.equal(await autoSwitch.getAttribute('aria-checked'), 'true');
    await page.getByText('Not allowed: no usable address (1)').waitFor();
    await page.getByText(SKIP_REASON).waitFor();
    assert.equal(await page.getByLabel('Allow SSH to OPT11').isChecked(), true);
    assert.equal(await page.getByLabel('Allow SSH to OPT13').isDisabled(), true, 'a server without a usable address cannot be ticked');
    assert.equal(await page.getByText('Allowed (every server)').count(), 2);
    ok('"Allow every server with an address" saves auto_allow alone and lists the server without a usable address');

    await page.getByRole('button', { name: 'Check addresses again' }).click();
    await page.getByText("Every server's address was checked again.", { exact: false }).waitFor();
    assert.deepEqual(sim.puts.at(-1).body, { auto_allow: true });
    // Turning one server off with auto-allow on saves it as denied; the form never sends auto_allow or key_source.
    await page.getByLabel('Allow SSH to OPT12').uncheck();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('SSH settings saved.').waitFor();
    const formPut = sim.puts.at(-1);
    assert.deepEqual(formPut.body.denied, ['opt12']);
    assert.ok(!('auto_allow' in formPut.body) && !('key_source' in formPut.body), JSON.stringify(formPut.body));
    await page.getByText('Turned off', { exact: true }).waitFor();
    ok('turning one server off with auto-allow on is saved as denied, without auto_allow/key_source');

    await page.getByRole('cell', { name: 'id_ed25519 · ssh-ed25519' }).waitFor();
    await page.getByRole('cell', { name: 'Keys not accepted' }).waitFor();
    ok('the session log shows which key signed in and the "Keys not accepted" end reason');
    // Put OPT12 back for the terminal checks.
    sim.config.denied = [];
    sim.revision++;
    await adminContext.close();

    // ── Terminal page (Operator) ──────────────────────────────────────────────────────────────────
    const { context: opContext, page: term } = await login('operator', 'Operator');
    const before = sim.sockets.length;
    await term.goto(origin + '/?tab=ssh&server=opt12');
    // It connects by itself (no Connect click); the server refuses the keys.
    const alert = term.getByRole('alert').filter({ hasText: 'did not accept' });
    await alert.waitFor();
    assert.match(await alert.innerText(), /^OPT12 did not accept the VM's keys or the Lab Manager key for root\./);
    assert.equal(sim.sockets.length, before + 1, 'exactly one connection was opened by itself');
    const first = sim.sockets[before];
    assert.equal(first.messages[0].type, 'auth');
    assert.ok(first.messages[0].csrf_token && !first.url.includes(first.messages[0].csrf_token), 'CSRF only in the first message, never in the URL');
    assert.equal(await term.locator('input[type="password"]').count(), 0, 'no password prompt');
    await term.getByRole('heading', { name: 'Install the Lab Manager key on OPT12' }).waitFor();
    assert.match(await term.getByLabel('Key-install command for OPT12', { exact: true }).innerText(), /# opt12$/);
    const reconnect = term.getByRole('button', { name: 'Reconnect' });
    await reconnect.waitFor();
    assert.equal(await reconnect.evaluate(el => el === document.activeElement), true, 'keyboard focus lands on Reconnect');
    ok('the terminal connects by itself, shows the auth_failed sentence, the key-install command and focuses Reconnect');

    await term.keyboard.press('Enter');
    await term.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
    await term.getByRole('button', { name: 'Disconnect' }).waitFor();
    assert.equal(sim.sockets.length, before + 2);
    assert.equal(await term.getByRole('heading', { name: 'Install the Lab Manager key on OPT12' }).count(), 0);
    await term.locator('.xterm-rows').filter({ hasText: 'root@opt12' }).waitFor();
    ok('Reconnect opens a new session and the terminal shows the server output');

    // A server without a usable address: the reason is shown and nothing connects.
    const count = sim.sockets.length;
    await term.goto(origin + '/?tab=ssh&server=opt13');
    await term.getByText('Lab Manager cannot use the saved address of OPT13', { exact: false }).first().waitFor();
    await term.waitForTimeout(800);
    assert.equal(sim.sockets.length, count, 'no connection for an unavailable server');
    assert.equal(await term.getByRole('button', { name: 'Connect' }).isDisabled(), true);
    ok('an unavailable server shows its reason and never connects');
    await opContext.close();

    // ── Viewer sees nothing ────────────────────────────────────────────────────────────────────────
    const { context: viewerContext, page: viewer } = await login('viewer', 'Viewer');
    const viewerSockets = sim.sockets.length;
    await viewer.goto(origin + '/?tab=ssh&server=opt11');
    await viewer.getByText('SSH terminals require the Operator or Admin role.').waitFor();
    await viewer.waitForTimeout(500);
    assert.equal(sim.sockets.length, viewerSockets, 'a Viewer never opens a terminal');
    await viewer.goto(origin + '/?tab=admin&section=ssh');
    assert.equal(await viewer.getByRole('switch').count(), 0);
    assert.equal(await viewer.getByRole('heading', { name: 'Sign-in keys' }).count(), 0);
    ok('a Viewer gets no terminal, no SSH settings and no switches');
    await viewerContext.close();

    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(blocked, [], 'no request left the fixture');
    console.log(`SSH UI checks passed: ${checks.length}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

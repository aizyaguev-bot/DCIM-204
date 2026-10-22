// Remote install (simulated PXE) in the browser: hidden selections, drafts left by a reload or the API,
// the failed-job warning and the global run limit. Runs only against tests/browser/preview-server.py
// (DCIM_TEST_ACCOUNTS=1); every job uses the simulated console, nothing touches a KVM, PDU or computer.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = (process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8944').replace(/\/$/, '');
const PASSWORD = 'test-password-123';
const START = 'Reboot and open boot menu';
const RELEASED = 'An Admin acknowledged this job — the computer is released for new installs.';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], blocked = [], unexpectedWrites = [];
  const until = async (fn, what, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
      await new Promise(r => setTimeout(r, 250));
    }
  };

  async function login(username) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    // What's new opens over the page in a fresh profile; it is not under test here.
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) { blocked.push(request.url()); return route.abort(); }
      const path = new URL(request.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !/^\/api\/(auth\/login$|pxe\/)/.test(path)) {
        unexpectedWrites.push(`${request.method()} ${path}`); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${username}: ${error.message}`));
    await page.goto(origin + '/?tab=pxe');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Remote install', exact: true }).waitFor();
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    return { context, page };
  }

  // Same-origin API calls from the page, so the app's fetch wrapper adds the CSRF header.
  const api = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
    const response = await fetch(path.startsWith('/api/') ? path : '/api/pxe' + path, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await response.json(); } catch {}
    return { status: response.status, data };
  }, [method, path, body]);
  const job = async (page, id) => (await api(page, 'GET', `/jobs/${id}`)).data;
  const jobs = async page => (await api(page, 'GET', '/jobs')).data;

  try {
    const op = await login('operator');
    const p = op.page;
    // The fixture labels KVM ports 2-4 only in its live status; reading it maps OPT12-OPT14 to the KVM.
    assert.equal((await api(p, 'GET', '/api/kvms/kvm1/status')).status, 200);
    const computers = (await api(p, 'GET', '/computers')).data;
    const keyOf = name => computers.find(c => c.name === name)?.key;
    for (const name of ['OPT11', 'OPT12', 'OPT13', 'OPT14']) {
      const c = computers.find(c => c.name === name);
      assert.ok(c, `${name} is a remote install computer`);
      assert.deepEqual([c.eligible, c.active_job_id, c.blockers], [true, null, []], `${name} starts free`);
    }
    const baseline = new Set((await jobs(p)).map(j => j.id));
    const newJobs = async () => (await jobs(p)).filter(j => !baseline.has(j.id));

    const picker = p.getByRole('region', { name: 'New install' });
    const radio = name => picker.getByRole('radio', { name: `Select ${name}`, exact: true });
    const row = name => picker.getByRole('row').filter({ has: p.getByRole('radio', { name: `Select ${name}`, exact: true }) });
    const startButton = picker.getByRole('button', { name: START, exact: true });
    const search = p.getByLabel('Search computers');
    const pduWarning = picker.getByText(/^PDU power cycle cuts power to PDU 01 outlet 1/);
    const hiddenNote = picker.getByText('The selected computer (OPT11) is hidden by the search.', { exact: false });
    await picker.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await radio('OPT14').waitFor();

    // PXE-1: a selection the search hides cannot be started; clearing the search restores it with its warning.
    await radio('OPT11').check();
    await picker.locator('p', { hasText: 'Computer: OPT11 · Rack-01' }).waitFor();
    await picker.getByLabel('Reboot method').selectOption('pdu_cycle');
    await pduWarning.waitFor();
    assert.equal(await startButton.isEnabled(), true);
    await search.fill('OPT12');
    await hiddenNote.waitFor();
    assert.equal(await startButton.isDisabled(), true, 'start is disabled while the selection is hidden');
    assert.equal(await pduWarning.count(), 0);
    assert.equal(await radio('OPT11').count(), 0);
    await search.fill('');
    await pduWarning.waitFor();
    assert.equal(await startButton.isEnabled(), true);
    assert.equal(await hiddenNote.count(), 0);
    await search.fill('OPT13');
    await hiddenNote.waitFor();
    await picker.getByRole('button', { name: 'Clear search', exact: true }).click();
    await pduWarning.waitFor();
    assert.equal(await search.inputValue(), '');
    assert.equal(await startButton.isEnabled(), true);
    assert.deepEqual(await newJobs(), [], 'nothing was created');
    checks.push('PXE-1 hidden selection disables start; clearing the search restores it with the PDU warning');

    // PXE-3: a draft left by a failed confirmation is cancelled when the page is reloaded (pagehide + keepalive).
    await picker.getByLabel('Reboot method').selectOption('kvm_cad');
    await startButton.click();
    let dialog = p.getByRole('dialog', { name: START });
    await dialog.getByLabel(/Reason/).fill('B14 wrong password');
    await dialog.locator('input[type=password]').fill('wrong-password-b14');
    await dialog.getByRole('button', { name: 'Reboot', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Password is incorrect' }).waitFor();
    const left = (await newJobs()).find(j => j.computer_name === 'OPT11' && j.state === 'draft');
    assert.ok(left, 'the failed confirmation left a draft');
    await p.reload();
    await p.getByRole('heading', { name: 'Remote install', exact: true }).waitFor();
    const cancelled = await until(async () => { const j = await job(p, left.id); return j.state === 'cancelled' && j; }, 'the draft to be cancelled', 10000);
    assert.ok(cancelled.events.some(e => e.action === 'cancel' && e.actor === 'operator'), 'cancelled by the leaving page, not by expiry');
    await picker.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await row('OPT11').getByText('Ready', { exact: true }).waitFor();
    checks.push('PXE-3 wrong password then reload: draft cancelled (event cancel), row Ready');

    // PXE-3 / D11: a draft created through the API offers Start in its panel; closing that dialog keeps the draft.
    const created = await api(p, 'POST', '/jobs', { computer_key: keyOf('OPT12'), reboot_method: 'kvm_cad', sim_scenario: 'kvm_disconnect' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const apiId = created.data.id;
    await picker.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await row('OPT12').getByRole('button', { name: `Active job #${apiId.slice(0, 8)}`, exact: true }).click();
    const panel = p.getByRole('region', { name: `OPT12 · Job #${apiId.slice(0, 8)}`, exact: true });
    await panel.getByText('The job has not started. Confirm with the password to reboot the computer.', { exact: true }).waitFor();
    const resume = panel.getByRole('button', { name: START, exact: true });
    await resume.click();
    dialog = p.getByRole('dialog', { name: START });
    await dialog.getByText(`Starts the existing job #${apiId.slice(0, 8)}, created by operator.`, { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await p.waitForTimeout(1000);
    assert.equal((await job(p, apiId)).state, 'draft', 'closing a resumed draft does not cancel it');
    await resume.click();
    await dialog.getByLabel(/Reason/).fill('B14 resumed API draft');
    await dialog.locator('input[type=password]').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Reboot', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const started = await until(async () => { const j = await job(p, apiId); return j.state !== 'draft' && j; }, 'the API draft to start');
    assert.ok(started.events.some(e => e.action === 'start' && e.actor === 'operator' && e.from_state === 'draft' && e.to_state === 'rebooting'), 'started into rebooting');
    assert.equal((await newJobs()).filter(j => j.computer_name === 'OPT12').length, 1, 'no second job was created');
    await panel.getByText('The job has not started.', { exact: false }).waitFor({ state: 'detached' });
    checks.push('PXE-3 API draft shows Start in its panel; closing keeps it; the right password moves it to rebooting');

    // PXE-5: kvm_disconnect fails in GRUB before any install command: the warning says none was sent.
    await panel.getByRole('heading', { name: 'Choose the network boot entry' }).waitFor({ timeout: 60000 });
    const option = panel.locator('label').filter({ hasText: /IPv4 Intel/ }).getByRole('radio');
    await option.check();
    await panel.getByRole('button', { name: 'Select', exact: true }).click();
    const failure = panel.getByRole('alert').filter({ hasText: 'kvm_disconnected' });
    await failure.waitFor({ timeout: 60000 });
    await failure.getByText('No install command was sent, but the GRUB menu may have booted an entry on its own. Do not retry automatically — check the console. A new job for this computer needs Admin acknowledgement.', { exact: true }).waitFor();
    assert.equal(await failure.getByText('The install command may already have been sent.', { exact: false }).count(), 0);
    const failed = await job(p, apiId);
    assert.equal(failed.install_sent_at, null);
    assert.equal(failed.needs_acknowledge, true);
    checks.push('PXE-5 kvm_disconnect: "No install command was sent…" and Admin acknowledgement needed');

    // PXE-2 with B15 (C9): another running install blocks every other computer before a draft exists.
    await radio('OPT11').check();   // selected while still eligible; the run limit then blocks it in place
    const running = await api(p, 'POST', '/jobs', { computer_key: keyOf('OPT13'), reboot_method: 'kvm_cad' });
    assert.equal(running.status, 201, JSON.stringify(running.data));
    const startRun = await api(p, 'POST', `/jobs/${running.data.id}/start`, { password: PASSWORD, reason: 'B14 run limit' });
    assert.equal(startRun.status, 200, JSON.stringify(startRun.data));
    await until(async () => (await job(p, running.data.id)).state === 'waiting_for_choice', 'the running job to wait for a choice');
    const serverLimit = (await api(p, 'GET', '/computers')).data.find(c => c.name === 'OPT14').blockers.includes('run_limit');
    const before = (await jobs(p)).length;
    if (serverLimit) {
      const refused = await api(p, 'POST', '/jobs', { computer_key: keyOf('OPT14'), reboot_method: 'kvm_cad' });
      assert.equal(refused.status, 409);
      assert.equal(refused.data.detail, 'Another remote install is running; wait until it finishes');
      assert.equal((await jobs(p)).length, before, 'no draft was created');
      checks.push('PXE-2 server run_limit: create refused with 409, no draft');
    } else {
      // Backend without C9: the start is refused after the draft exists; the dialog reloads the list and its close cancels the draft.
      await radio('OPT14').check();
      const loads = [];
      const onRequest = request => { if (new URL(request.url()).pathname === '/api/pxe/computers') loads.push(Date.now()); };
      p.on('request', onRequest);
      await startButton.click();
      dialog = p.getByRole('dialog', { name: START });
      await dialog.getByLabel(/Reason/).fill('B14 while another runs');
      await dialog.locator('input[type=password]').fill(PASSWORD);
      await dialog.getByRole('button', { name: 'Reboot', exact: true }).click();
      await dialog.getByRole('alert').filter({ hasText: 'Another remote install is running; wait until it finishes' }).waitFor();
      await until(() => loads.length > 0, 'the computer list to reload after the 409', 5000);
      p.off('request', onRequest);
      const draft = (await newJobs()).find(j => j.computer_name === 'OPT14' && j.state === 'draft');
      assert.ok(draft, 'the old backend created a draft before refusing the start');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await until(async () => (await job(p, draft.id)).state === 'cancelled', 'the refused draft to be cancelled on close', 10000);
      await radio('OPT11').check();
      checks.push('PXE-2 409 on start reloads the computer list; closing cancels the still-unstarted draft');
    }
    // The run_limit row: label, disabled radio and start button. Without C9 the blocker is injected into the real list.
    const inject = async route => {
      const response = await route.fetch();
      const list = await response.json();
      for (const c of list) if (c.active_job_id == null && !c.blockers.includes('run_limit')) { c.blockers.push('run_limit'); c.eligible = false; }
      await route.fulfill({ response, json: list });
    };
    if (!serverLimit) await p.route('**/api/pxe/computers', inject);
    await picker.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await row('OPT14').getByText('Another install is running', { exact: true }).waitFor();
    assert.equal(await radio('OPT14').isDisabled(), true);
    assert.equal(await radio('OPT11').isDisabled(), true);
    assert.equal(await startButton.isDisabled(), true);
    await picker.getByText('This computer cannot be installed remotely right now: Another install is running.', { exact: true }).waitFor();
    if (!serverLimit) await p.unroute('**/api/pxe/computers', inject);
    assert.equal((await jobs(p)).length, before + (serverLimit ? 0 : 1), 'no further draft was created');
    checks.push(`PXE-2 run_limit row: label, radio and start disabled (${serverLimit ? 'from the server' : 'blocker injected; backend without C9'})`);

    // PXE-4: after an Admin acknowledges, both the Admin's and the Operator's panels say the computer is released.
    const admin = await login('admin');
    const a = admin.page;
    const adminPicker = a.getByRole('region', { name: 'New install' });
    await adminPicker.getByRole('row').filter({ has: a.getByRole('radio', { name: 'Select OPT12', exact: true }) })
      .getByRole('button', { name: `Active job #${apiId.slice(0, 8)}`, exact: true }).click();
    const adminPanel = a.getByRole('region', { name: `OPT12 · Job #${apiId.slice(0, 8)}`, exact: true });
    a.once('dialog', d => d.accept());
    await adminPanel.getByRole('button', { name: 'Acknowledge (Admin)', exact: true }).click();
    await adminPanel.getByText(RELEASED, { exact: false }).waitFor();
    assert.equal(await adminPanel.getByText('needs Admin acknowledgement', { exact: false }).count(), 0);
    await panel.getByText(RELEASED, { exact: false }).waitFor({ timeout: 20000 });
    assert.equal((await job(p, apiId)).needs_acknowledge, false);
    checks.push('PXE-4 after an Admin acknowledge the panel says "released" (Admin at once, Operator on the next list refresh)');

    const stop = await api(p, 'POST', `/jobs/${running.data.id}/cancel`);
    assert.equal(stop.status, 200);
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(unexpectedWrites, [], 'no writes outside remote install');
    assert.deepEqual(blocked, [], 'no request left the fixture');
    console.log(JSON.stringify({ passed: checks, errors, serverRunLimit: serverLimit }));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });

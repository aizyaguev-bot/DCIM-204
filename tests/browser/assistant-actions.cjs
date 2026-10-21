// Assistant actions (v2.40.0), end to end in Microsoft Edge against tests/browser/assistant_fixture.py: demo mode,
// accounts mode, temporary data, fake PDUs and a simulated KVM console, no hardware. ACT-QA-PLAN section 3 (BR1-BR9),
// adapted to the binding decisions: a reset never powers on a feed that was off (OPT11 is therefore powered on first,
// BR1), and the typed phrase is checked in the dialog before anything is sent.
//
// Run order (outlet 1 of PDU 01 depends on it): BR6 viewer, BR4 lab off, BR5 restore, BR1 power on, BR2 reset with a
// wrong then a right password, BR3 console popup and blocked-popup fallback, BR7 phone layout, BR9 summary.
// BR8 (flag off) runs instead of all of them when the fixture was started without ASSISTANT_ACTIONS_ENABLED=true.
//
//   ASSISTANT_ACTIONS_ENABLED=true POWER_PROTECTED_OUTLETS=pdu1:4 DCIM_PREVIEW_DIST=<built frontend> \
//       python tests/browser/assistant_fixture.py 8791
//   DCIM_PREVIEW_URL=http://127.0.0.1:8791 DCIM_QA_SCREENS=<folder> node tests/browser/assistant-actions.cjs
//   (optional DCIM_ACTIONS_EXPECT=on|off makes the run fail when the fixture is in the other mode)
//
// Writes this check may send: sign-in, chat, action proposals/execute/cancel and the KVM port in-use marker of the
// console under test. Any other write, and any write under /api/pdus, fails the run (and is aborted).
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8791';
const screens = process.env.DCIM_QA_SCREENS || os.tmpdir();
const expectMode = (process.env.DCIM_ACTIONS_EXPECT || '').toLowerCase();
const PASSWORD = 'test-password-123';
const MARKER = 'LOCAL PREVIEW - TEST DATA';
const ANSWER_TIMEOUT = 90_000;
const JOB_TIMEOUT = 60_000;
const ACTIONS = '/api/assistant/actions';
const Q = {
  labOff: 'כבה חשמל לכל המעבדה',
  restore: 'תחזיר חשמל',
  powerOn: 'תדליק את OPT11',
  reset: 'תעשה ריסט לשרת OPT11 ותפתח KVM',
  console: 'תפתח לי KVM של OPT11',
  off12: 'כבה את OPT12',
};
const ALLOWED_WRITES = [
  /^POST \/api\/auth\/login$/,
  /^POST \/api\/assistant\/chat$/,
  /^POST \/api\/assistant\/actions\/proposals$/,
  /^POST \/api\/assistant\/actions\/proposals\/[0-9a-f]{32}\/(execute|cancel)$/,
  /^POST \/api\/kvms\/kvm1\/ports\/1\/mark-(in-use|free)$/,
];
const HEBREW = /[֐-׿]/;

const passed = [];
const problems = [];
const shots = [];
const check = (name, fn) => fn().then(() => passed.push(name));

{
  const target = new URL(origin);
  assert.equal(target.hostname, '127.0.0.1', 'use the isolated local fixture only');
  assert.notEqual(target.port, '8000', 'port 8000 is reserved for the real site');
}

async function session(browser, {width, height, user, mobile = false, blockPopup = false}) {
  const context = await browser.newContext({viewport: {width, height}, isMobile: mobile, hasTouch: mobile,
    deviceScaleFactor: 1, locale: 'he-IL'});
  await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
  if (blockPopup) await context.addInitScript(() => { window.open = () => null; });
  const log = {errors: [], writes: []};
  await context.route('**/*', route => {
    const request = route.request();
    if (!request.url().startsWith(origin + '/')) return route.abort();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      const line = `${request.method()} ${new URL(request.url()).pathname}`;
      log.writes.push(line);
      if (line.includes(' /api/pdus/') || !ALLOWED_WRITES.some(rule => rule.test(line))) {
        log.errors.push(`unexpected write: ${line}`);
        return route.abort();
      }
    }
    return route.continue();
  });
  const watch = page => {
    page.on('pageerror', e => log.errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') log.errors.push(`console: ${m.text()}`); });
  };
  context.on('page', watch);
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByLabel('Username', {exact: true}).fill(user);
  await page.getByLabel('Password', {exact: true}).fill(PASSWORD);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await page.getByRole('heading', {name: 'Dashboard', exact: true}).waitFor();
  const version = await (await context.request.get(origin + '/api/version')).json();
  assert.equal(version.version, MARKER, 'refusing to run against anything but the isolated fixture');
  return {context, page, log};
}

// -- API reads (GET only, with the browser's own session) ---------------------------------------------------------
async function getJson(context, url) {
  const response = await context.request.get(origin + url);
  assert.equal(response.status(), 200, `GET ${url}: ${response.status()}`);
  return response.json();
}
const getProposal = (context, id) => getJson(context, `${ACTIONS}/proposals/${id}`);
async function outletState(context, pdu, outlet) {
  const status = await getJson(context, `/api/pdus/${pdu}/status`);
  return status.outlets.find(o => o.number === outlet)?.state;
}
async function maintenanceIds(context) {
  return Object.keys((await getJson(context, '/api/pdus/maintenance')).pdus).sort();
}
async function settle(context, id, timeout = JOB_TIMEOUT) {
  const end = Date.now() + timeout;
  for (;;) {
    const proposal = await getProposal(context, id);
    if (!['pending', 'executing'].includes(proposal.status)) return proposal;
    assert.ok(Date.now() < end, `proposal still ${proposal.status}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

// -- Panel helpers ------------------------------------------------------------------------------------------------
const panelOf = page => page.locator('#assistant-panel');
const answers = page => panelOf(page).locator('article[data-role="assistant"]');
const cardsIn = scope => scope.locator('section[data-proposal-id]');
const dialogOf = page => page.getByRole('alertdialog');

async function openPanel(page) {
  await page.getByRole('button', {name: 'עוזר המעבדה', exact: true}).click();
  await panelOf(page).waitFor();
  await panelOf(page).getByRole('note').filter({hasText: 'מצב הדגמה'}).first().waitFor();
}

async function askQuestion(page, text) {
  const before = await answers(page).count();
  const box = panelOf(page).getByLabel('שאלה לעוזר המעבדה');
  await box.fill(text);
  await box.press('Enter');
  await answers(page).nth(before).waitFor({timeout: ANSWER_TIMEOUT});
  return answers(page).nth(before);
}

async function proposalCard(page, question, kind) {
  const answer = await askQuestion(page, question);
  const card = cardsIn(answer).first();
  await card.waitFor({timeout: 15_000});
  assert.equal(await cardsIn(answer).count(), 1, `"${question}" should prepare exactly one card`);
  const id = await card.getAttribute('data-proposal-id');
  assert.match(id || '', /^[0-9a-f]{32}$/);
  const proposal = await getProposal(page.context(), id);
  assert.equal(proposal.kind, kind);
  return {answer, card, id, proposal};
}

async function openDialog(page, card) {
  await card.getByRole('button', {name: /^בצע/}).click();
  const dialog = dialogOf(page);
  await dialog.waitFor();
  return dialog;
}

function executeResponse(page) {
  return page.waitForResponse(r => /\/api\/assistant\/actions\/proposals\/[0-9a-f]{32}\/execute$/.test(new URL(r.url()).pathname));
}

async function noHorizontalOverflow(page, label) {
  const sizes = await page.evaluate(() => {
    const panel = document.getElementById('assistant-panel');
    const dialog = document.querySelector('[role="alertdialog"]');
    return {doc: document.documentElement.scrollWidth, view: window.innerWidth,
      panel: panel ? panel.scrollWidth - panel.clientWidth : 0,
      dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : 0};
  });
  assert.ok(sizes.doc <= sizes.view + 1, `${label}: page scrolls sideways (${sizes.doc} > ${sizes.view})`);
  assert.ok(sizes.panel <= 1, `${label}: panel scrolls sideways (${sizes.panel}px)`);
  assert.ok(sizes.dialog <= 1, `${label}: dialog scrolls sideways (${sizes.dialog}px)`);
}

// BR7: RTL, isolated device names, Hebrew accessible names on every button.
async function rtlAndNames(scope, label, isolated = []) {
  const report = await scope.evaluate((root, names) => {
    const own = el => el.closest('[dir]');
    // The device name / phrase is shown at least once as an isolated run (bdi or an explicit direction).
    const isolatedOk = name => [...root.querySelectorAll('bdi, [dir="auto"], [dir="ltr"]')]
      .some(el => el.textContent.includes(name));
    const buttons = [...root.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
    return {dir: own(root)?.getAttribute('dir'), lang: root.closest('[lang]')?.getAttribute('lang'), buttons,
      isolated: Object.fromEntries(names.map(name => [name, isolatedOk(name)]))};
  }, isolated);
  assert.equal(report.dir, 'rtl', `${label}: not dir=rtl`);
  assert.equal(report.lang, 'he', `${label}: not lang=he`);
  for (const name of report.buttons) assert.match(name, HEBREW, `${label}: button without a Hebrew name: "${name}"`);
  for (const [name, ok] of Object.entries(report.isolated)) assert.ok(ok, `${label}: "${name}" is not isolated (bdi/dir)`);
}

async function focusStaysInDialog(page, presses = 14) {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
    const inside = await page.evaluate(() => !!document.querySelector('[role="alertdialog"]')?.contains(document.activeElement));
    assert.ok(inside, `focus left the dialog after ${i + 1} key presses`);
  }
}

async function passwordNowhere(page) {
  const leaks = await page.evaluate(secret => {
    const stores = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) stores.push(store.getItem(store.key(i)) || '');
    }
    const fields = [...document.querySelectorAll('input')].map(input => input.value);
    return {dom: document.documentElement.outerHTML.includes(secret), storage: stores.some(v => v.includes(secret)),
      fields: fields.some(v => v.includes(secret))};
  }, PASSWORD);
  assert.deepEqual(leaks, {dom: false, storage: false, fields: false}, 'the password stayed in the page');
}

async function shot(page, name) {
  fs.mkdirSync(screens, {recursive: true});
  const file = path.join(screens, `ai-actions-${name}.png`);
  await page.screenshot({path: file});
  shots.push(file);
}

function clean(s, label) {
  assert.deepEqual(s.log.errors, [], `${label}: console errors or unexpected writes: ${s.log.errors.join(' | ')}`);
  passed.push(`${label}: 0 console errors, only allowed writes`);
}

// -- BR6: Viewer ----------------------------------------------------------------------------------------------------
async function br6Viewer(browser) {
  const s = await session(browser, {width: 1440, height: 1000, user: 'viewer'});
  try {
    await openPanel(s.page);
    for (const question of [Q.reset, Q.labOff]) {
      await check(`BR6 viewer: "${question}" explains the role, no card and no confirm button`, async () => {
        const answer = await askQuestion(s.page, question);
        assert.equal(await cardsIn(answer).count(), 0, 'a Viewer got a proposal card');
        assert.match(await answer.innerText(), /Operator|Admin|הרשא/);
        assert.equal(await panelOf(s.page).getByRole('button', {name: /^בצע/}).count(), 0);
      });
    }
    await check('BR6 viewer: the only writes are sign-in and chat', async () => {
      assert.deepEqual([...new Set(s.log.writes)].sort(), ['POST /api/assistant/chat', 'POST /api/auth/login']);
    });
    await shot(s.page, 'br6-viewer');
    clean(s, 'BR6 viewer');
  } finally {
    await s.context.close();
  }
}

// -- BR4: Admin shuts the lab down ----------------------------------------------------------------------------------
async function br4LabOff(browser, state) {
  const s = await session(browser, {width: 1440, height: 1000, user: 'admin'});
  try {
    await openPanel(s.page);
    let card;
    await check('BR4 admin: "כבה חשמל לכל המעבדה" prepares one lab-wide card and switches nothing', async () => {
      const before = await maintenanceIds(s.context);
      const made = await proposalCard(s.page, Q.labOff, 'lab_shutdown');
      card = made.card;
      state.labId = made.id;
      assert.equal(made.proposal.status, 'pending');
      assert.equal(made.proposal.phrase, 'LAB OFF');
      assert.ok(made.proposal.impact.excluded.some(e => e.pdu_id === 'pdu7' && e.outlet === null && e.reason === 'unreachable'));
      assert.ok(made.proposal.impact.excluded.some(e => e.pdu_id === 'pdu1' && e.outlet === 4 && e.reason === 'protected'));
      assert.deepEqual(await maintenanceIds(s.context), before);
      await rtlAndNames(card, 'BR7 lab card');
    });
    await check('BR4 dialog: per-PDU impact, PDU 07 not included, PDU 01 outlet 4 kept on, exact phrase shown', async () => {
      const dialog = await openDialog(s.page, card);
      const text = await dialog.innerText();
      assert.match(text, /PDU 07[^\n]*\n?[^\n]*לא זמין/);
      assert.match(text, /PDU 01[^\n]*שקע 4[^\n]*\n?[^\n]*מוגן/);
      assert.match(text, /LAB OFF/);
      const phrase = dialog.getByLabel('כדי לאשר, הקלד בדיוק:');
      assert.ok(await phrase.evaluate(el => el === document.activeElement), 'focus does not start in the phrase field');
      await rtlAndNames(dialog, 'BR7 lab dialog', ['LAB OFF', 'PDU 07']);
      await focusStaysInDialog(s.page);
      await noHorizontalOverflow(s.page, 'BR4 dialog');
      await shot(s.page, 'br4-dialog');
    });
    await check('BR4 dialog: confirm stays disabled until the phrase matches; a wrong phrase sends nothing', async () => {
      const dialog = dialogOf(s.page);
      const action = dialog.getByRole('button', {name: 'כבה את כל המעבדה'});
      await dialog.getByLabel('כדי לאשר, הקלד בדיוק:').fill('lab off');
      await dialog.locator('input[type="password"]').fill(PASSWORD);
      assert.equal(await action.getAttribute('aria-disabled'), 'true');
      const sent = s.log.writes.length;
      await action.click({force: true});   // aria-disabled stays focusable and clickable; it must send nothing
      await s.page.waitForTimeout(300);
      assert.equal(s.log.writes.length, sent, 'a wrong phrase was sent to the server');
      assert.equal(await dialog.getByText('הצירוף תואם').count(), 0);
    });
    await check('BR4 run: phrase and password start the job, progress rises, the summary and Maintenance agree', async () => {
      const dialog = dialogOf(s.page);
      await dialog.getByLabel('כדי לאשר, הקלד בדיוק:').fill('LAB OFF');
      await dialog.getByText('הצירוף תואם').waitFor();
      const action = dialog.getByRole('button', {name: 'כבה את כל המעבדה'});
      assert.notEqual(await action.getAttribute('aria-disabled'), 'true');
      const executed = executeResponse(s.page);
      await action.click();
      assert.equal((await executed).status(), 202);
      await dialog.waitFor({state: 'detached'});
      const bar = card.getByRole('progressbar');
      await bar.waitFor({timeout: 15_000});
      const seen = [];
      while (await bar.count()) {
        const now = Number(await bar.getAttribute('aria-valuenow').catch(() => NaN));
        if (Number.isFinite(now)) seen.push(now);
        await s.page.waitForTimeout(200);
      }
      assert.ok(seen.length > 0, 'no progress value was shown');
      assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `progress went backwards: ${seen}`);
      const final = await settle(s.context, state.labId);
      assert.equal(final.status, 'succeeded');
      assert.deepEqual(final.progress, {done: 6, total: 6});
      await card.getByText('בוצע', {exact: true}).first().waitFor();
      assert.deepEqual(await maintenanceIds(s.context), ['pdu1', 'pdu2', 'pdu3', 'pdu4', 'pdu5', 'pdu6']);
      assert.equal(await outletState(s.context, 'pdu1', 4), 'on', 'the protected outlet was switched');
      await shot(s.page, 'br4-done');
      await noHorizontalOverflow(s.page, 'BR4 done');
    });
    clean(s, 'BR4 admin');
  } finally {
    await s.context.close();
  }
}

// -- BR5: Admin restores the batch ----------------------------------------------------------------------------------
async function br5Restore(browser, state) {
  const s = await session(browser, {width: 1440, height: 1000, user: 'admin'});
  try {
    await openPanel(s.page);
    let card, id;
    await check('BR5 admin: "תחזיר חשמל" prepares a restore of exactly that batch', async () => {
      const made = await proposalCard(s.page, Q.restore, 'batch_restore');
      ({card, id} = made);
      assert.equal(made.proposal.restore_of, state.labId);
      assert.equal(made.proposal.phrase, 'LAB ON');
      assert.deepEqual([...made.proposal.impact.pdus].sort(), ['pdu1', 'pdu2', 'pdu3', 'pdu4', 'pdu5', 'pdu6']);
      assert.ok(!made.proposal.impact.targets.some(t => t.pdu_id === 'pdu1' && [1, 4].includes(t.outlet)));
    });
    await check('BR5 run: confirm leads through progress to done; PDU 01 outlet 1 stays OFF, the rest is on', async () => {
      const dialog = await openDialog(s.page, card);
      await dialog.getByLabel('כדי לאשר, הקלד בדיוק:').fill('LAB ON');
      await dialog.locator('input[type="password"]').fill(PASSWORD);
      const executed = executeResponse(s.page);
      await dialog.getByRole('button', {name: /החזר חשמל/}).click();
      assert.equal((await executed).status(), 202);
      await dialog.waitFor({state: 'detached'});
      await card.getByRole('progressbar').waitFor({timeout: 15_000});
      assert.equal((await settle(s.context, id)).status, 'succeeded');
      await card.getByText('בוצע', {exact: true}).first().waitFor();
      assert.deepEqual(await maintenanceIds(s.context), []);
      assert.equal(await outletState(s.context, 'pdu1', 1), 'off', 'PDU 01 outlet 1 was OFF before the lab shutdown');
      for (const [pdu, outlet] of [['pdu1', 2], ['pdu1', 3], ['pdu1', 4], ['pdu2', 1], ['pdu6', 4]]) {
        assert.equal(await outletState(s.context, pdu, outlet), 'on', `${pdu}:${outlet} is not on`);
      }
      await shot(s.page, 'br5-restored');
    });
    clean(s, 'BR5 admin');
  } finally {
    await s.context.close();
  }
}

// -- BR1, BR2, BR3: Operator powers OPT11 on, resets it and opens its console -------------------------------------
async function br1to3Operator(browser) {
  const s = await session(browser, {width: 1440, height: 1000, user: 'operator'});
  try {
    await openPanel(s.page);
    let card;
    await check('BR1 card: "תדליק את OPT11" lists PDU 01 outlet 1 OPT11, off now, needs a password', async () => {
      ({card} = await proposalCard(s.page, Q.powerOn, 'server_on'));
      const text = await card.innerText();
      for (const part of [/PDU 01/, /שקע 1/, /OPT11/, /כבוי עכשיו/, /יודלק/, /סיסמה/]) assert.match(text, part);
      await rtlAndNames(card, 'BR7 server card', ['OPT11', 'PDU 01']);
    });
    await check('BR1 dialog: password field (current-password) has focus; Tab stays inside; Escape closes only it', async () => {
      const dialog = await openDialog(s.page, card);
      const password = dialog.locator('input[type="password"]');
      assert.equal(await password.getAttribute('autocomplete'), 'current-password');
      assert.ok(await password.evaluate(el => el === document.activeElement), 'focus does not start in the password');
      await focusStaysInDialog(s.page);
      await s.page.keyboard.press('Escape');
      await dialog.waitFor({state: 'detached'});
      await panelOf(s.page).waitFor();
      await s.page.waitForFunction(() => (document.activeElement?.getAttribute('aria-label') || '').startsWith('בצע'));
    });
    await check('BR1 run: the right password powers outlet 1 on and the password is gone from the page', async () => {
      const dialog = await openDialog(s.page, card);
      await dialog.locator('input[type="password"]').fill(PASSWORD);
      const executed = executeResponse(s.page);
      await dialog.getByRole('button', {name: 'הדלק את OPT11'}).click();
      assert.equal((await executed).status(), 200);
      await dialog.waitFor({state: 'detached'});
      await card.getByText('בוצע', {exact: true}).first().waitFor();
      assert.equal(await outletState(s.context, 'pdu1', 1), 'on');
      await passwordNowhere(s.page);
      await shot(s.page, 'br1-on');
    });

    let reset;
    await check('BR2: a wrong password shows "הסיסמה שגויה", clears the field and changes nothing', async () => {
      reset = await proposalCard(s.page, Q.reset, 'server_cycle');
      assert.equal(reset.proposal.request.then_console, true);
      const dialog = await openDialog(s.page, reset.card);
      const password = dialog.locator('input[type="password"]');
      await password.fill('wrong-password-br2');
      const executed = executeResponse(s.page);
      await dialog.getByRole('button', {name: 'אתחל את OPT11'}).click();
      assert.equal((await executed).status(), 403);
      await dialog.getByRole('alert').filter({hasText: 'הסיסמה שגויה'}).waitFor();
      // The browser logs every 4xx response as a console error; this one 403 is the expected refusal.
      const expected = s.log.errors.findIndex(e => e.includes('status of 403'));
      if (expected >= 0) s.log.errors.splice(expected, 1);
      assert.equal(await password.inputValue(), '');
      assert.equal((await getProposal(s.context, reset.id)).status, 'pending');
      assert.equal(await outletState(s.context, 'pdu1', 1), 'on');
      await shot(s.page, 'br2-wrong-password');
    });
    await check('BR2: the right password then resets OPT11 and the card shows the console button', async () => {
      const dialog = dialogOf(s.page);
      await dialog.locator('input[type="password"]').fill(PASSWORD);
      const executed = executeResponse(s.page);
      await dialog.getByRole('button', {name: 'אתחל את OPT11'}).click();
      assert.equal((await executed).status(), 200);
      await dialog.waitFor({state: 'detached'});
      await reset.card.getByText('בוצע', {exact: true}).first().waitFor();
      assert.equal(await outletState(s.context, 'pdu1', 1), 'on');
      await passwordNowhere(s.page);
    });
    await check('BR3: "פתח KVM" opens /api/kvms/kvm1/autologin?port=1 only on click, marks the port, frees it on close', async () => {
      const button = reset.card.getByRole('button', {name: /פתח KVM/}).first();
      await button.waitFor();
      assert.equal(s.context.pages().length, 1, 'a console opened before the click');
      const popupReady = s.context.waitForEvent('page');
      const used = s.page.waitForResponse(r => new URL(r.url()).pathname === '/api/kvms/kvm1/ports/1/mark-in-use');
      await button.click();
      const popup = await popupReady;
      await popup.waitForLoadState();
      const url = new URL(popup.url());
      assert.equal(url.pathname + url.search, '/api/kvms/kvm1/autologin?port=1');
      await popup.getByRole('heading', {name: 'Console preview'}).waitFor();
      assert.equal((await used).status(), 200);
      const freed = s.page.waitForResponse(r => new URL(r.url()).pathname === '/api/kvms/kvm1/ports/1/mark-free');
      await popup.close();
      assert.equal((await freed).status(), 200);
      await shot(s.page, 'br3-console');
    });
    await noHorizontalOverflow(s.page, 'BR1-BR3 desktop');
    clean(s, 'BR1-BR3 operator');
  } finally {
    await s.context.close();
  }
}

async function br3BlockedPopup(browser) {
  const s = await session(browser, {width: 1440, height: 1000, user: 'operator', blockPopup: true});
  try {
    await openPanel(s.page);
    await check('BR3 blocked popup: the console opens inside the site and closing it frees the port', async () => {
      const {card, proposal} = await proposalCard(s.page, Q.console, 'open_console');
      assert.equal(proposal.status, 'ready');
      const used = s.page.waitForResponse(r => new URL(r.url()).pathname === '/api/kvms/kvm1/ports/1/mark-in-use');
      await card.getByRole('button', {name: /פתח KVM/}).first().click();
      await s.page.getByRole('dialog', {name: 'KVM console', exact: true}).waitFor();
      await s.page.frameLocator('iframe[title="KVM console viewer"]').getByRole('heading', {name: 'Console preview'}).waitFor();
      assert.equal((await used).status(), 200);
      assert.equal(s.context.pages().length, 1, 'no new page when popups are blocked');
      const freed = s.page.waitForResponse(r => new URL(r.url()).pathname === '/api/kvms/kvm1/ports/1/mark-free');
      await s.page.getByRole('button', {name: 'Close KVM console'}).click();
      assert.equal((await freed).status(), 200);
      await shot(s.page, 'br3-inline-console');
    });
    clean(s, 'BR3 blocked popup');
  } finally {
    await s.context.close();
  }
}

// -- BR7: phone ----------------------------------------------------------------------------------------------------
async function br7Phone(browser) {
  const s = await session(browser, {width: 390, height: 844, user: 'operator', mobile: true});
  try {
    await openPanel(s.page);
    await check('BR7 phone: card and full-screen dialog fit at 390 px, RTL, Escape returns to the card, cancel is final', async () => {
      const {card, id} = await proposalCard(s.page, Q.off12, 'server_off');
      await rtlAndNames(card, 'BR7 phone card', ['OPT12']);
      await noHorizontalOverflow(s.page, 'BR7 phone card');
      const dialog = await openDialog(s.page, card);
      const box = await dialog.boundingBox();
      assert.ok(box && box.width >= 385, `the dialog is not a full-width sheet: ${JSON.stringify(box)}`);
      await rtlAndNames(dialog, 'BR7 phone dialog', ['OPT12']);
      await noHorizontalOverflow(s.page, 'BR7 phone dialog');
      await focusStaysInDialog(s.page, 8);
      await shot(s.page, 'br7-phone-dialog');
      await s.page.keyboard.press('Escape');
      await dialog.waitFor({state: 'detached'});
      await panelOf(s.page).waitFor();
      await card.getByRole('button', {name: 'בטל הצעה'}).click();
      assert.equal((await settle(s.context, id, 10_000)).status, 'cancelled');
      await card.getByText('בוטלה', {exact: true}).first().waitFor();
      assert.equal(await outletState(s.context, 'pdu1', 2), 'on', 'cancel switched something');
    });
    clean(s, 'BR7 phone');
  } finally {
    await s.context.close();
  }
}

// -- BR8: flag off -------------------------------------------------------------------------------------------------
async function br8FlagOff(browser) {
  const s = await session(browser, {width: 1440, height: 1000, user: 'admin'});
  try {
    await openPanel(s.page);
    for (const question of [Q.labOff, Q.reset]) {
      await check(`BR8 flag off: "${question}" says actions are off, shows no card and writes nothing to actions`, async () => {
        const answer = await askQuestion(s.page, question);
        assert.equal(await cardsIn(answer).count(), 0);
        assert.match(await answer.innerText(), /כבויות|מושבתות/);
      });
    }
    await check('BR8 flag off: no write reached /api/assistant/actions', async () => {
      assert.ok(!s.log.writes.some(line => line.includes(ACTIONS)), s.log.writes.join(', '));
    });
    await shot(s.page, 'br8-flag-off');
    clean(s, 'BR8 flag off');
  } finally {
    await s.context.close();
  }
}

async function actionsEnabled(browser) {
  const s = await session(browser, {width: 1024, height: 768, user: 'viewer'});
  try {
    return (await getJson(s.context, `${ACTIONS}/config`)).enabled === true;
  } finally {
    await s.context.close();
  }
}

(async () => {
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  const state = {};
  try {
    const enabled = await actionsEnabled(browser);
    if (expectMode === 'on') assert.ok(enabled, 'the fixture runs with assistant actions off (expected on)');
    if (expectMode === 'off') assert.ok(!enabled, 'the fixture runs with assistant actions on (expected off)');
    const runs = enabled
      ? [br6Viewer, br4LabOff, br5Restore, br1to3Operator, br3BlockedPopup, br7Phone]
      : [br8FlagOff];
    for (const run of runs) {
      try { await run(browser, state); } catch (e) { problems.push(`${run.name}: ${e.message.split('\n')[0]}`); }
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({passed, problems, screenshots: shots}, null, 1));
  if (problems.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });

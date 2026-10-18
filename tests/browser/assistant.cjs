// Lab assistant panel, end to end in Microsoft Edge against tests/browser/assistant_fixture.py (demo mode,
// temporary data, no hardware). Desktop 1440 and phone 390: demo banner, two owner questions, facts/sources/checks,
// source chips and record links, draft editor with the confirmation step (Viewer cannot save; Operator saves into
// the fixture database only), new conversation and delete, keyboard (Tab into the panel, Escape closes only the
// panel), no horizontal overflow and no console errors. Only GETs and assistant writes are sent.
//
//   python tests/browser/assistant_fixture.py 8791        (with DCIM_PREVIEW_DIST=<built frontend> for new UI code)
//   DCIM_PREVIEW_URL=http://127.0.0.1:8791 DCIM_QA_SCREENS=<folder> node tests/browser/assistant.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8791';
const screens = process.env.DCIM_QA_SCREENS || os.tmpdir();
const PASSWORD = 'test-password-123';
const MARKER = 'LOCAL PREVIEW - TEST DATA';
const ANSWER_TIMEOUT = 90_000;
const Q_DOWN = 'מה נפל במעבדה?';
const Q_CAPACITY = 'האם אפשר להוסיף שרת לארון Rack-01?';
// Writes this check may send: sign-in and the assistant's own endpoints.
const ALLOWED_WRITES = [/^POST \/api\/auth\/login$/, /^POST \/api\/assistant\/chat$/, /^POST \/api\/assistant\/work-items$/,
  /^DELETE \/api\/assistant\/conversations\/[0-9a-f]{32}$/];

const passed = [];
const problems = [];
const shots = [];
const check = (name, fn) => fn().then(() => passed.push(name));

async function session(browser, {width, height, user, mobile = false}) {
  const context = await browser.newContext({viewport: {width, height}, isMobile: mobile, hasTouch: mobile,
    deviceScaleFactor: 1, locale: 'he-IL'});
  await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  const log = {errors: [], writes: []};
  page.on('pageerror', e => log.errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') log.errors.push(`console: ${m.text()}`); });
  page.on('request', r => {
    if (['GET', 'HEAD'].includes(r.method())) return;
    const line = `${r.method()} ${new URL(r.url()).pathname}`;
    log.writes.push(line);
    if (!ALLOWED_WRITES.some(rule => rule.test(line))) log.errors.push(`unexpected write: ${line}`);
  });
  await page.goto(origin);
  await page.getByLabel('Username', {exact: true}).fill(user);
  await page.getByLabel('Password', {exact: true}).fill(PASSWORD);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await page.getByRole('heading', {name: 'Dashboard', exact: true}).waitFor();
  const version = await (await context.request.get(origin + '/api/version')).json();
  assert.equal(version.version, MARKER, 'refusing to run against anything but the isolated fixture');
  return {context, page, log};
}

const panelOf = page => page.locator('#assistant-panel');
const answers = page => panelOf(page).locator('article[data-role="assistant"]');

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

async function noHorizontalOverflow(page, label) {
  const sizes = await page.evaluate(() => {
    const panel = document.getElementById('assistant-panel');
    return {doc: document.documentElement.scrollWidth, view: window.innerWidth,
      panel: panel ? panel.scrollWidth - panel.clientWidth : 0};
  });
  assert.ok(sizes.doc <= sizes.view + 1, `${label}: page scrolls sideways (${sizes.doc} > ${sizes.view})`);
  assert.ok(sizes.panel <= 1, `${label}: panel scrolls sideways (${sizes.panel}px)`);
}

async function shot(page, name) {
  fs.mkdirSync(screens, {recursive: true});
  const file = path.join(screens, `ai-assistant-${name}.png`);
  await page.screenshot({path: file});
  shots.push(file);
}

async function desktopViewer(browser) {
  const {context, page, log} = await session(browser, {width: 1440, height: 1000, user: 'viewer'});
  try {
    await check('desktop: panel opens with the demo banner and focus in the question box', async () => {
      await openPanel(page);
      await page.waitForFunction(() => document.getElementById('assistant-panel')?.contains(document.activeElement));
      assert.equal(await panelOf(page).getAttribute('dir'), 'rtl');
      assert.equal(await panelOf(page).getAttribute('lang'), 'he');
      await panelOf(page).getByText('הדגמה', {exact: true}).waitFor();
    });

    let first;
    await check('desktop: "מה נפל במעבדה?" renders facts, hypothesis, ordered checks and sources', async () => {
      first = await askQuestion(page, Q_DOWN);
      for (const title of ['עובדות', 'השערות', 'מה לבדוק קודם', 'מקורות', 'מידע חסר']) {
        await first.getByRole('heading', {name: title}).first().waitFor();
      }
      assert.ok((await first.locator('ol > li').count()) >= 1, 'no ordered checks');
      assert.match(await first.innerText(), /מצב הדגמה/);
      assert.match(await first.innerText(), /OPT11/);
      assert.match(await first.innerText(), /שקע 1/);
      assert.ok((await first.locator('li[id^="assistant-src-"]').count()) >= 3, 'sources list too short');
    });

    await check('desktop: a source chip moves focus to its source entry', async () => {
      await first.getByRole('button', {name: /מקור:/}).first().click();
      await page.waitForFunction(() => (document.activeElement?.id || '').startsWith('assistant-src-'));
    });

    await shot(page, 'desktop-answer');
    await noHorizontalOverflow(page, 'desktop answer');

    await check('desktop: a record link opens the PDU page and the panel stays open', async () => {
      await first.getByRole('button', {name: /PDU 01.*פתח את הרשומה/}).first().click();
      await page.getByRole('button', {name: 'Back'}).first().waitFor();
      await panelOf(page).waitFor();
    });

    let capacity;
    await check('desktop: capacity question renders a recommendation with missing information', async () => {
      capacity = await askQuestion(page, Q_CAPACITY);
      await capacity.getByRole('heading', {name: 'המלצות'}).waitFor();
      await capacity.getByText('מידע חסר להחלטה').first().waitFor();
      assert.match(await capacity.innerText(), /Rack-01/);
      assert.match(await capacity.innerText(), /מותנה|conditional|אין כאן אישור סופי/);
    });

    await check('desktop: Viewer sees the draft editor but cannot continue to save', async () => {
      await capacity.getByRole('button', {name: 'צור טיוטת עבודה'}).first().click();
      const dialog = page.getByRole('dialog', {name: 'טיוטת עבודה'});
      await dialog.waitFor();
      await dialog.getByText('נדרשת הרשאת Operator כדי לשמור').waitFor();
      assert.equal(await dialog.getByRole('button', {name: 'המשך לשמירה…'}).isDisabled(), true);
      await shot(page, 'desktop-draft-viewer');
      await page.keyboard.press('Escape');
      await dialog.waitFor({state: 'detached'});
      await panelOf(page).waitFor();   // Escape closed the dialog only
    });

    await check('desktop: a rack link navigates to the rack', async () => {
      await capacity.getByRole('button', {name: /ארון.*Rack-01.*פתח את הארון/}).first().click();
      await page.waitForFunction(() => new URL(location.href).searchParams.get('rack') === 'Rack-01');
      assert.equal(new URL(page.url()).searchParams.get('tab'), 'racks');
    });

    await check('desktop: Tab reaches the panel from the page and Escape closes only the panel', async () => {
      await page.locator('main, #root').first().click({position: {x: 900, y: 300}});
      let inside = false;
      for (let i = 0; i < 80 && !inside; i++) {
        await page.keyboard.press('Tab');
        inside = await page.evaluate(() => !!document.getElementById('assistant-panel')?.contains(document.activeElement));
      }
      assert.ok(inside, 'Tab never reached the assistant panel');
      const url = page.url();
      await page.keyboard.press('Escape');
      await panelOf(page).waitFor({state: 'detached'});
      assert.equal(page.url(), url, 'Escape changed the page');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-controls') === 'assistant-panel');
    });

    await check('desktop: keyboard reopens the panel with the conversation kept', async () => {
      await page.keyboard.press('Enter');
      await panelOf(page).waitFor();
      await page.waitForFunction(() => document.getElementById('assistant-panel')?.contains(document.activeElement));
      await answers(page).nth(1).waitFor({timeout: 30_000});
    });

    await check('desktop: "new conversation" clears the log; delete removes it from history', async () => {
      await panelOf(page).getByRole('button', {name: 'שיחה חדשה'}).click();
      assert.equal(await panelOf(page).locator('[data-message]').count(), 0);
      await panelOf(page).getByRole('tab', {name: 'שיחות קודמות'}).click();
      const remove = panelOf(page).getByRole('button', {name: /^מחק את השיחה:/}).first();
      await remove.waitFor();
      const before = await panelOf(page).getByRole('button', {name: /^מחק את השיחה:/}).count();
      const deleted = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().includes('/api/assistant/conversations/'));
      await remove.click();
      await panelOf(page).getByRole('button', {name: 'מחק', exact: true}).click();
      assert.equal((await deleted).status(), 200);
      await page.waitForFunction(n => document.querySelectorAll('#assistant-panel button[aria-label^="מחק את השיחה:"]').length === n,
        before - 1);
      // The confirmation notice is shown in the chat tab.
      await panelOf(page).getByRole('tab', {name: 'שיחה', exact: true}).click();
      await panelOf(page).getByText('השיחה נמחקה.').waitFor();
    });

    await noHorizontalOverflow(page, 'desktop end');
    assert.deepEqual(log.errors, [], 'desktop errors');
    passed.push('desktop: 0 console errors, only assistant writes');
  } finally {
    await context.close();
  }
}

async function desktopOperator(browser) {
  const {context, page, log} = await session(browser, {width: 1440, height: 1000, user: 'operator'});
  try {
    await openPanel(page);
    await check('operator: draft shows the confirmation step and saves into the fixture', async () => {
      const capacity = await askQuestion(page, Q_CAPACITY);
      await capacity.getByRole('button', {name: 'צור טיוטת עבודה'}).first().click();
      const dialog = page.getByRole('dialog', {name: 'טיוטת עבודה'});
      await dialog.waitFor();
      await dialog.getByRole('button', {name: 'המשך לשמירה…'}).click();
      await dialog.getByRole('heading', {name: 'לשמור משימה חדשה?'}).waitFor();
      await shot(page, 'desktop-draft-confirm');
      await dialog.getByRole('button', {name: 'שמור משימה'}).click();
      await dialog.getByRole('button', {name: 'סגור', exact: true}).last().click();
      await dialog.waitFor({state: 'detached'});
      await panelOf(page).getByText(/נשמרה/).first().waitFor();
      await panelOf(page).getByRole('tab', {name: 'משימות עבודה'}).click();
      await panelOf(page).getByText('בדיקת היתכנות להוספת שרת לארון Rack-01').first().waitFor();
      await shot(page, 'desktop-work-items');
    });
    assert.deepEqual(log.errors, [], 'operator errors');
    assert.ok(log.writes.includes('POST /api/assistant/work-items'), 'the save was not sent');
    passed.push('operator: 0 console errors');
  } finally {
    await context.close();
  }
}

async function phoneViewer(browser) {
  const {context, page, log} = await session(browser, {width: 390, height: 844, user: 'viewer', mobile: true});
  try {
    await check('phone: panel is a full-screen sheet without sideways scrolling', async () => {
      await openPanel(page);
      const box = await panelOf(page).boundingBox();
      assert.ok(box && box.width >= 385 && box.x <= 1, `panel box ${JSON.stringify(box)}`);
      await noHorizontalOverflow(page, 'phone open');
    });
    await check('phone: answer renders and fits', async () => {
      const answer = await askQuestion(page, Q_DOWN);
      await answer.getByRole('heading', {name: 'עובדות'}).waitFor();
      await noHorizontalOverflow(page, 'phone answer');
      await shot(page, 'phone-answer');
    });
    await check('phone: a record link closes the sheet and opens the record', async () => {
      await answers(page).last().getByRole('button', {name: /PDU 01.*פתח את הרשומה/}).first().click();
      await panelOf(page).waitFor({state: 'detached'});
      await page.getByRole('button', {name: 'Back'}).first().waitFor();
    });
    assert.deepEqual(log.errors, [], 'phone errors');
    passed.push('phone: 0 console errors');
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  try {
    for (const run of [desktopViewer, desktopOperator, phoneViewer]) {
      try { await run(browser); } catch (e) { problems.push(`${run.name}: ${e.message.split('\n')[0]}`); }
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({passed, problems, screenshots: shots}, null, 1));
  if (problems.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });

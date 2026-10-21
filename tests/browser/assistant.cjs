// Lab assistant panel, end to end in Microsoft Edge against tests/browser/assistant_fixture.py (demo mode,
// temporary data, no hardware). Desktop 1440 and phone 390: demo banner, two owner questions, facts/sources/checks,
// source chips and record links, draft editor with the confirmation step (Viewer cannot save; Operator saves into
// the fixture database only), new conversation and delete, keyboard (Tab into the panel, Escape closes only the
// panel), no horizontal overflow and no console errors. Only GETs and assistant writes are sent.
// Also (SWEEP B13): short landscape screens keep a usable conversation (AM-1), tablet widths close the panel on a
// record or rack link (AM-2), a Viewer's draft is read-only (AM-3) and the phone sheet is modal (AM-4).
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

// Sizes of the open panel: the conversation log, whether the panel itself overflows, and whether Send is fully on
// screen and not covered; plus the parts the short-screen rules change (header padding, question box, hint).
async function panelLayout(page) {
  return page.evaluate(() => {
    const panel = document.getElementById('assistant-panel');
    const log = panel.querySelector('[role="log"]');
    const input = panel.querySelector('form textarea');
    const hint = document.getElementById(input.getAttribute('aria-describedby').split(' ')[0]);
    const send = panel.querySelector('form button[type="submit"]');
    const r = send.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {log: log.clientHeight, overflow: panel.scrollHeight - panel.clientHeight,
      headerPad: getComputedStyle(panel.firstElementChild).paddingTop, input: input.offsetHeight,
      hintPresent: !!hint, hint: hint ? hint.getBoundingClientRect().height : 0, send: [r.left, r.top, r.right, r.bottom].map(Math.round),
      sendVisible: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && !!hit && (hit === send || send.contains(hit))};
  });
}

async function tallLayoutUnchanged(page, label) {
  const m = await panelLayout(page);
  assert.equal(m.headerPad, '12px', `${label}: header padding changed`);
  assert.ok(m.input >= 70, `${label}: question box shrank to ${m.input}px`);
  assert.ok(m.hint > 1, `${label}: the keyboard hint is hidden`);
  assert.ok(m.log >= 400, `${label}: conversation only ${m.log}px`);
  assert.ok(m.overflow <= 1, `${label}: panel overflows by ${m.overflow}px`);
  assert.ok(m.sendVisible, `${label}: Send not fully visible ${m.send}`);
}

// The element itself (or its content) is what a click at its centre hits: nothing covers it.
const hitsItself = locator => locator.evaluate(el => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (hit === el || el.contains(hit));
});
const focusInside = locator => locator.evaluate(el => el.contains(document.activeElement));
const rootOverflow = page => page.evaluate(() => document.documentElement.style.overflow);

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

    await check('desktop: the side panel is not modal and the tall layout is unchanged', async () => {
      assert.equal(await panelOf(page).getAttribute('role'), 'complementary');
      assert.equal(await panelOf(page).getAttribute('aria-modal'), null);
      assert.notEqual(await rootOverflow(page), 'hidden', 'the page under the side panel was locked');
      await tallLayoutUnchanged(page, 'desktop 1440x1000');
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

    await check('desktop: Viewer sees the draft read-only (no hand-off promise) and cannot continue to save', async () => {
      await capacity.getByRole('button', {name: 'צור טיוטת עבודה'}).first().click();
      const dialog = page.getByRole('dialog', {name: 'טיוטת עבודה'});
      await dialog.waitFor();
      await dialog.getByText('נדרשת הרשאת Operator כדי לשמור').waitFor();
      await dialog.getByText('הטיוטה מוצגת לקריאה בלבד ולא תישמר.').waitFor();
      assert.doesNotMatch(await dialog.innerText(), /להעביר|אפשר לערוך/, 'the Viewer is still invited to edit or hand on the draft');
      assert.equal(await dialog.getByRole('button', {name: 'המשך לשמירה…'}).isDisabled(), true);
      const title = dialog.getByLabel('כותרת');
      assert.notEqual(await title.getAttribute('readonly'), null, 'the title is editable');
      const titleBefore = await title.inputValue();
      await title.press('End');
      await page.keyboard.type('xyz');
      assert.equal(await title.inputValue(), titleBefore, 'typing changed the read-only title');
      for (const field of [dialog.getByLabel('תיאור'), dialog.getByLabel('נימוק')]) {
        assert.notEqual(await field.getAttribute('readonly'), null, 'a text field is editable');
      }
      assert.equal(await dialog.getByLabel('עדיפות').isDisabled(), true, 'priority can be changed');
      assert.equal(await dialog.getByRole('button', {name: '+ הוסף שלב'}).isDisabled(), true, '"add step" is enabled');
      const steps = dialog.getByRole('textbox', {name: /^שלב \d+$/});
      const stepCount = await steps.count();
      assert.ok(stepCount >= 1, 'the draft has no steps to check');
      assert.notEqual(await steps.first().getAttribute('readonly'), null, 'a step is editable');
      await steps.first().press('Enter');
      assert.equal(await steps.count(), stepCount, 'Enter in a step added a step');
      for (const name of [/^העבר את שלב 1 למטה$/, /^מחק את שלב 1$/]) {
        assert.equal(await dialog.getByRole('button', {name}).isDisabled(), true, `${name} is enabled`);
      }
      assert.equal(await dialog.getByText('לסגור בלי לשמור?').count(), 0);
      await shot(page, 'desktop-draft-viewer');
      await dialog.getByRole('button', {name: 'ביטול', exact: true}).click();   // closes at once, nothing to discard
      await dialog.waitFor({state: 'detached'});
      await panelOf(page).waitFor();
    });

    await check('desktop: Escape closes only the Viewer draft dialog', async () => {
      await capacity.getByRole('button', {name: 'צור טיוטת עבודה'}).first().click();
      const dialog = page.getByRole('dialog', {name: 'טיוטת עבודה'});
      await dialog.waitFor();
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
      // Regression for AM-3: an Operator still edits the draft, and closing an edited draft asks first.
      assert.equal(await dialog.getByText('לקריאה בלבד').count(), 0, 'the Operator sees the read-only note');
      const title = dialog.getByLabel('כותרת');
      assert.equal(await title.getAttribute('readonly'), null, 'the Operator cannot edit the title');
      await title.fill(`${await title.inputValue()} (נבדק)`);
      await dialog.getByText('טיוטה', {exact: true}).waitFor();
      assert.equal(await dialog.getByLabel('עדיפות').isDisabled(), false);
      const steps = dialog.getByRole('textbox', {name: /^שלב \d+$/});
      const stepCount = await steps.count();
      await steps.first().press('Enter');
      assert.equal(await steps.count(), stepCount + 1, 'Enter in a step did not add a step');
      await dialog.getByRole('button', {name: 'ביטול', exact: true}).click();
      await dialog.getByText('לסגור בלי לשמור?').waitFor();
      await dialog.getByRole('button', {name: 'המשך לערוך'}).click();
      await dialog.getByText('לסגור בלי לשמור?').waitFor({state: 'detached'});
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
      await tallLayoutUnchanged(page, 'phone 390x844');
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

// AM-1: a phone or small tablet in landscape. The fixed parts get compact so the conversation keeps at least 7rem
// (112 px) and the question box and Send stay on screen.
async function shortScreens(browser) {
  for (const [width, height, user, mobile] of [[812, 375, 'viewer', false], [740, 360, 'operator', false], [568, 320, 'viewer', true]]) {
    const tag = `landscape ${width}x${height} ${user}`;
    const {context, page, log} = await session(browser, {width, height, user, mobile});
    try {
      await check(`${tag}: the conversation keeps >=112 px, the panel fits and Send is fully visible`, async () => {
        await openPanel(page);
        const m = await panelLayout(page);
        assert.ok(m.log >= 112, `conversation only ${m.log}px`);
        assert.ok(m.overflow <= 1, `panel overflows by ${m.overflow}px`);
        assert.ok(m.sendVisible, `Send not fully visible ${m.send}`);
        assert.ok(m.hintPresent && m.hint <= 1, 'the keyboard hint should stay for screen readers only');
        await noHorizontalOverflow(page, tag);
      });
      if (width === 812) {
        await check(`${tag}: after an answer the conversation still has >=112 px`, async () => {
          await askQuestion(page, Q_DOWN);
          const m = await panelLayout(page);
          assert.ok(m.log >= 112, `conversation only ${m.log}px`);
          assert.ok(m.sendVisible, `Send not fully visible ${m.send}`);
          await shot(page, 'landscape-812x375');
        });
      }
      assert.deepEqual(log.errors, [], `${tag} errors`);
      passed.push(`${tag}: 0 console errors`);
    } finally {
      await context.close();
    }
  }
}

// AM-2: up to 1023 px a record or rack link closes the 420 px panel, which would otherwise cover the page it opens.
async function tabletLinks(browser) {
  for (const [width, height, user] of [[768, 1024, 'viewer'], [600, 960, 'operator']]) {
    const tag = `tablet ${width}x${height}`;
    const {context, page, log} = await session(browser, {width, height, user});
    try {
      await openPanel(page);
      await check(`${tag}: a record link closes the panel and nothing covers Back on the record page`, async () => {
        const answer = await askQuestion(page, Q_DOWN);
        await answer.getByRole('button', {name: /PDU 01.*פתח את הרשומה/}).first().click();
        await panelOf(page).waitFor({state: 'detached'});
        const back = page.getByRole('button', {name: 'Back'}).first();
        await back.waitFor();
        assert.ok(await hitsItself(back), 'Back is covered');
      });
      await check(`${tag}: reopening keeps the answer; a rack link closes the panel`, async () => {
        await page.getByRole('button', {name: 'עוזר המעבדה', exact: true}).click();
        await panelOf(page).waitFor();
        await answers(page).first().waitFor();
        assert.match(await answers(page).first().innerText(), /OPT11/);
        const capacity = await askQuestion(page, Q_CAPACITY);
        await capacity.getByRole('button', {name: /ארון.*Rack-01.*פתח את הארון/}).first().click();
        await panelOf(page).waitFor({state: 'detached'});
        await page.waitForFunction(() => new URL(location.href).searchParams.get('rack') === 'Rack-01');
      });
      await noHorizontalOverflow(page, tag);
      assert.deepEqual(log.errors, [], `${tag} errors`);
      passed.push(`${tag}: 0 console errors`);
    } finally {
      await context.close();
    }
  }
}

// AM-4: on a phone the full-screen sheet is a modal dialog: the page under it does not scroll, Tab stays inside,
// Back closes it, and a reload does not reopen it over the page.
async function phoneSheet(browser) {
  const {context, page, log} = await session(browser, {width: 375, height: 812, user: 'viewer', mobile: true});
  try {
    await check('phone 375: a reload with the panel remembered open leaves the sheet closed', async () => {
      await page.evaluate(() => localStorage.setItem('dcim-assistant-open', '1'));
      await page.reload();
      await page.getByRole('heading', {name: 'Dashboard', exact: true}).waitFor();
      await page.getByRole('button', {name: 'עוזר המעבדה', exact: true}).waitFor();
      assert.equal(await panelOf(page).count(), 0, 'the sheet reopened by itself');
    });

    await check('phone 375: the sheet is a modal dialog and a wheel does not scroll the page under it', async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 100), 'the page is too short to test');
      await openPanel(page);
      assert.equal(await panelOf(page).getAttribute('role'), 'dialog');
      assert.equal(await panelOf(page).getAttribute('aria-modal'), 'true');
      assert.equal(await rootOverflow(page), 'hidden');
      for (const y of [30, 400, 760]) {
        await page.mouse.move(187, y);
        await page.mouse.wheel(0, 2500);
      }
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => window.scrollY), 0, 'the page under the sheet scrolled');
    });

    await check('phone 375: Tab and Shift+Tab stay inside the sheet', async () => {
      for (const key of ['Tab', 'Shift+Tab']) {
        for (let i = 0; i < 30; i++) {
          await page.keyboard.press(key);
          assert.ok(await focusInside(panelOf(page)), `${key} #${i + 1} left the sheet`);
        }
      }
    });

    await check('phone 375: the draft dialog over the sheet traps Tab; Escape closes only the dialog', async () => {
      const capacity = await askQuestion(page, Q_CAPACITY);
      await capacity.getByRole('button', {name: 'צור טיוטת עבודה'}).first().click();
      const dialog = page.getByRole('dialog', {name: 'טיוטת עבודה'});
      await dialog.waitFor();
      await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-modal="true"]:not(#assistant-panel)')?.contains(document.activeElement));
      for (const key of ['Tab', 'Shift+Tab']) {
        for (let i = 0; i < 20; i++) {
          await page.keyboard.press(key);
          assert.ok(await focusInside(dialog), `${key} #${i + 1} left the draft dialog`);
        }
      }
      await page.keyboard.press('Escape');
      await dialog.waitFor({state: 'detached'});
      await panelOf(page).waitFor();
    });

    await check('phone 375: Back closes the sheet and page scrolling comes back', async () => {
      const answer = await askQuestion(page, Q_DOWN);
      await answer.getByRole('button', {name: /PDU 01.*פתח את הרשומה/}).first().click();
      await panelOf(page).waitFor({state: 'detached'});
      await page.getByRole('button', {name: 'Back'}).first().waitFor();
      assert.equal(await rootOverflow(page), '', 'page scrolling not restored after the link');
      await page.getByRole('button', {name: 'עוזר המעבדה', exact: true}).click();
      await panelOf(page).waitFor();
      assert.ok(await answers(page).count() >= 2, 'the conversation was lost');
      await page.goBack();
      await panelOf(page).waitFor({state: 'detached'});
      await page.getByRole('heading', {name: 'Dashboard', exact: true}).waitFor();
      assert.equal(await rootOverflow(page), '', 'page scrolling not restored after Back');
    });

    await noHorizontalOverflow(page, 'phone 375 end');
    assert.deepEqual(log.errors, [], 'phone 375 errors');
    passed.push('phone 375: 0 console errors');
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  try {
    for (const run of [desktopViewer, desktopOperator, phoneViewer, phoneSheet, shortScreens, tabletLinks]) {
      try { await run(browser); } catch (e) { problems.push(`${run.name}: ${e.message.split('\n')[0]}`); }
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({passed, problems, screenshots: shots}, null, 1));
  if (problems.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

const DEFAULT_RESULTS = path.join('output', 'results.jsonl');

function parseArgs(argv) {
  const args = {
    students: path.join('data', 'students.csv'),
    config: 'config.local.json',
    results: DEFAULT_RESULTS,
    url: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--students') {
      args.students = value;
      i += 1;
    } else if (key === '--config') {
      args.config = value;
      i += 1;
    } else if (key === '--results') {
      args.results = value;
      i += 1;
    } else if (key === '--url') {
      args.url = value;
      i += 1;
    }
  }

  return args;
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        i += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) {
        rows.push(row);
      }
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== '')) {
      rows.push(row);
    }
  }

  return rows;
}

function loadStudents(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw new Error('students CSV must include a header and at least one student row');
  }

  const headers = rows[0].map((header) => header.trim());
  const students = rows.slice(1).map((row, index) => {
    const record = {};
    headers.forEach((header, headerIndex) => {
      record[header] = (row[headerIndex] || '').trim();
    });
    record.__row = index + 2;
    return record;
  });

  for (const student of students) {
    if (!student['姓名']) {
      throw new Error(`missing 姓名 at row ${student.__row}`);
    }
    if (!student['身份证号'] && !student['准考证号'] && !student['考生号'] && !student['报名序号']) {
      throw new Error(`missing 身份证号/准考证号/考生号/报名序号 at row ${student.__row}`);
    }
  }

  return students;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileName(value) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || 'unknown';
}

function maskSecret(value) {
  if (!value) {
    return '';
  }
  if (value.length <= 4) {
    return '*'.repeat(value.length);
  }
  return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

async function fillIfPresent(page, selector, value) {
  if (!selector || !value) {
    return false;
  }
  return tryFillLocator(page.locator(selector), value);
}

async function tryFillLocator(locator, value) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    const canFill = await item.evaluate((element) => {
      const tagName = element.tagName.toLowerCase();
      if (tagName === 'textarea') {
        return true;
      }
      if (tagName !== 'input') {
        return element.isContentEditable;
      }
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      return !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)
        && !element.disabled
        && !element.readOnly
        && element.getAttribute('aria-disabled') !== 'true';
    }).catch(() => false);
    if ((await item.isVisible().catch(() => false)) && canFill) {
      const filled = await item.fill(value, { timeout: 2000 }).then(() => true).catch(() => false);
      if (!filled) {
        continue;
      }
      return true;
    }
  }
  return false;
}

async function smartFill(page, selector, value, patterns, cssCandidates) {
  if (!value) {
    return false;
  }
  if (await fillIfPresent(page, selector, value).catch(() => false)) {
    return true;
  }

  for (const pattern of patterns) {
    if (await tryFillLocator(page.getByLabel(pattern), value)) {
      return true;
    }
    if (await tryFillLocator(page.getByPlaceholder(pattern), value)) {
      return true;
    }
  }

  for (const css of cssCandidates) {
    if (await tryFillLocator(page.locator(css), value)) {
      return true;
    }
  }

  return false;
}

function resolveQueryMode(config, student) {
  const configuredMode = String(config.queryMode || '').trim();
  if (configuredMode === 'registrationNo' || configuredMode === 'idCard') {
    return configuredMode;
  }
  if (!student['身份证号'] && student['报名序号']) {
    return 'registrationNo';
  }
  return 'idCard';
}

async function clickIfVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) {
      await item.click({ timeout: 2000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function selectQueryMode(page, selectors, mode) {
  const configuredSelector = mode === 'registrationNo'
    ? selectors.queryModeRegistrationNo
    : selectors.queryModeIdCard;
  const candidates = configuredSelector
    ? [page.locator(configuredSelector)]
    : mode === 'registrationNo'
      ? [
          page.locator('#bmxhradio'),
          page.locator('input[name="Qtype"][value="1"]'),
          page.getByLabel(/报名序号|报名号/),
        ]
      : [
          page.locator('#sfzradio'),
          page.locator('input[name="Qtype"][value="0"]'),
          page.getByLabel(/身份证号|身份证/),
        ];

  for (const locator of candidates) {
    if (await clickIfVisible(locator)) {
      await page.waitForTimeout(200);
      return true;
    }
  }
  return false;
}

async function fillStudentFields(page, selectors, student, queryMode) {
  const filled = {
    name: await smartFill(
      page,
      selectors.name,
      student['姓名'],
      [/姓名/, /考生姓名/, /学生姓名/],
      [
        'input[name*="name" i]',
        'input[id*="name" i]',
        'input[placeholder*="姓名"]',
        'input[aria-label*="姓名"]',
      ],
    ),
    idCard: false,
    admissionNo: await smartFill(
      page,
      selectors.admissionNo,
      student['准考证号'],
      [/准考证/, /准考证号/],
      [
        'input[name*="zk" i]',
        'input[id*="zk" i]',
        'input[name*="zkzh" i]',
        'input[id*="zkzh" i]',
        'input[name*="ks" i]',
        'input[id*="ks" i]',
        'input[placeholder*="准考证"]',
      ],
    ),
    examineeNo: await smartFill(
      page,
      selectors.examineeNo,
      student['考生号'] || student['准考证号'],
      [/考生号/, /考生号码/],
      [
        'input[name*="ks" i]',
        'input[id*="ks" i]',
        'input[name*="exam" i]',
        'input[id*="exam" i]',
        'input[placeholder*="考生号"]',
      ],
    ),
    registrationNo: false,
  };

  if (queryMode === 'registrationNo') {
    filled.registrationNo = await smartFill(
      page,
      selectors.registrationNo,
      student['报名序号'],
      [/报名序号/, /报名号/],
      [
        'input[name*="bm" i]',
        'input[id*="bm" i]',
        'input[name*="reg" i]',
        'input[id*="reg" i]',
        'input[placeholder*="报名序号"]',
        'input[placeholder*="报名号"]',
      ],
    );
  } else {
    filled.idCard = await smartFill(
      page,
      selectors.idCard,
      student['身份证号'],
      [/身份证/, /证件号/, /身份证号/, /居民身份证/],
      [
        'input[name*="id" i]',
        'input[id*="id" i]',
        'input[name*="sfz" i]',
        'input[id*="sfz" i]',
        'input[name*="sfzh" i]',
        'input[id*="sfzh" i]',
        'input[placeholder*="身份证"]',
        'input[placeholder*="证件"]',
      ],
    );
  }

  return filled;
}

async function hasLikelyNameField(page, selector) {
  if (selector) {
    return true;
  }
  const candidates = [
    'input[name*="name" i]:not([type="hidden"])',
    'input[id*="name" i]:not([type="hidden"])',
    'input[placeholder*="姓名"]:not([type="hidden"])',
    'input[aria-label*="姓名"]:not([type="hidden"])',
  ];
  for (const css of candidates) {
    if (await page.locator(css).count().then((count) => count > 0).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function textFromSelector(page, selector) {
  if (!selector) {
    return '';
  }
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) {
    return '';
  }
  return (await locator.innerText()).trim();
}

async function extractByScoreMap(page, scoreMap) {
  const scores = {};
  for (const [subject, selector] of Object.entries(scoreMap || {})) {
    const text = await textFromSelector(page, selector);
    if (text) {
      scores[subject] = text;
    }
  }
  return scores;
}

async function extractGenericTables(page) {
  return page.evaluate(() => {
    const result = {};
    const tables = Array.from(document.querySelectorAll('table'));
    const scoreAliases = {
      生物学: '生物',
      英语: '外语',
      政治: '思想政治',
    };
    const ignoredLabels = new Set(['考生号', '姓名', '身份证号', '报名序号', '准考证号']);
    const normalizeLabel = (value) => value.replace(/\s+/g, '').replace(/\u00a0/g, '');
    const addScore = (label, value) => {
      const normalized = normalizeLabel(label);
      if (!normalized || ignoredLabels.has(normalized)) {
        return;
      }
      const key = scoreAliases[normalized] || normalized;
      if (!result[key]) {
        result[key] = value;
      }
    };

    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th,td')).map((cell) => cell.textContent.trim()).filter(Boolean),
      );

      for (const row of rows) {
        if (row.length === 2) {
          addScore(row[0], row[1]);
        }
      }

      if (rows.length >= 2) {
        const headers = rows[0];
        const values = rows[1];
        if (headers.length >= 3 && headers.length === values.length) {
          headers.forEach((header, index) => {
            if (header && values[index]) {
              addScore(header, values[index]);
            }
          });
        }
      }
    }

    return result;
  });
}

async function extractGenericScoreText(page, resultContainerSelector) {
  return page.evaluate((selector) => {
    const container = selector ? document.querySelector(selector) : document.body;
    const text = (container || document.body).innerText.replace(/\u00a0/g, ' ');
    const result = {};
    const aliases = {
      总分: ['总分'],
      语文: ['语文'],
      数学: ['数学'],
      外语: ['外语', '英语'],
      物理: ['物理'],
      历史: ['历史'],
      化学: ['化学'],
      生物: ['生物'],
      思想政治: ['思想政治', '政治'],
      地理: ['地理'],
    };
    const scorePattern = '([0-9]{1,3}(?:\\.\\d+)?|[0-9]{1,4}|缺考|未选考|--|-)';

    for (const [subject, keys] of Object.entries(aliases)) {
      for (const key of keys) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = text.match(new RegExp(`${escapedKey}\\s*[：:]?\\s*${scorePattern}`));
        if (match && match[1]) {
          result[subject] = match[1];
          break;
        }
      }
    }

    return result;
  }, resultContainerSelector || '');
}

function mergeScores(primary, fallback) {
  const merged = { ...fallback, ...primary };
  for (const key of Object.keys(merged)) {
    if (!merged[key]) {
      delete merged[key];
    }
  }
  return merged;
}

function randomDelay(minMs, maxMs) {
  const min = Number(minMs || 0);
  const max = Number(maxMs || min);
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

async function waitForManualCaptcha(page, rl, config, studentName) {
  if (config.skipCaptchaPrompt) {
    return;
  }

  if (await hasTencentCaptcha(page)) {
    const timeoutMs = Number(config.captchaWaitTimeoutMs || 120000);
    const pollMs = Number(config.captchaPollMs || 200);
    const startedAt = Date.now();
    let sawChallengeWindow = false;
    console.log(`请在浏览器中为 ${studentName} 完成图片验证，脚本检测到验证成功后会自动继续。`);
    while (Date.now() - startedAt < timeoutMs) {
      if (await isMainTencentCaptchaVerified(page)) {
        return 'verified';
      }
      if (config.captchaAutoConfirm && await isTencentCaptchaFrameVerified(page)) {
        await confirmTencentCaptchaIfVisible(page);
        await page.waitForTimeout(pollMs);
        return 'verified';
      }
      const challengeOpen = await isTencentCaptchaChallengeOpen(page);
      if (challengeOpen) {
        sawChallengeWindow = true;
      } else if (sawChallengeWindow) {
        return 'closed';
      }
      await page.waitForTimeout(pollMs);
    }
    console.warn('等待图片验证超时，仍将尝试提交；如果失败，请重新运行该学生查询。');
    return 'timeout';
  }

  const selector = (config.selectors || {}).captcha;
  const captchaCode = await rl.question(`请输入 ${studentName} 的验证码；如果你已在浏览器中手动输入，直接按回车：`);
  if (!captchaCode.trim()) {
    return 'manual';
  }

  const filled = await smartFill(
    page,
    selector,
    captchaCode.trim(),
    [/验证码/, /校验码/, /图片验证码/],
    [
      'input[name*="captcha" i]',
      'input[id*="captcha" i]',
      'input[name*="code" i]',
      'input[id*="code" i]',
      'input[name*="yzm" i]',
      'input[id*="yzm" i]',
      'input[placeholder*="验证码"]',
      'input[placeholder*="校验码"]',
    ],
  );

  if (!filled) {
    await rl.question('没有自动定位到验证码输入框，请在浏览器中手动输入验证码后按回车继续：');
  }
  return 'manual';
}

async function clickFirstVisibleEnabled(locator) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    const clickable = await item.evaluate((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0
        && !element.disabled
        && element.getAttribute('aria-disabled') !== 'true';
    }).catch(() => false);
    if (clickable) {
      await item.click({ timeout: 10000 });
      return true;
    }
  }
  return false;
}

async function submitQuery(page, selector) {
  if (selector) {
    const submit = page.locator(selector).first();
    await submit.waitFor({ state: 'visible', timeout: 15000 });
    await submit.click({ timeout: 15000 });
    return;
  }

  const submitCandidates = [
    page.locator('#QueryBtn'),
    page.locator('input.QueryButton[value*="查询"]'),
    page.locator('input[type="button"][value*="查询"]'),
    page.locator('input[type="submit"][value*="查询"]'),
    page.locator('button:has-text("查询")'),
    page.getByRole('button', { name: /^\s*查\s*询\s*$/ }),
    page.getByRole('button', { name: /查询|提交|登录|进入|下一步/ }),
    page.locator('input[type="submit"]'),
    page.locator('button[type="submit"]'),
  ];

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const locator of submitCandidates) {
      if (await clickFirstVisibleEnabled(locator)) {
        return;
      }
    }
    await page.waitForTimeout(300);
  }

  await page.keyboard.press('Enter');
}

async function hasTencentCaptcha(page) {
  return page.locator('#TencentCaptcha').count().then((count) => count > 0).catch(() => false);
}

async function isTencentCaptchaChallengeOpen(page) {
  return page.evaluate(() => {
    const selectors = [
      'iframe[src*="captcha"]',
      'iframe[src*="turing"]',
      'iframe[src*="tencent"]',
      '[class*="tcaptcha"]',
      '[id*="tcaptcha"]',
    ];
    return selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    }));
  }).catch(() => false);
}

async function isMainTencentCaptchaVerified(page) {
  return page.evaluate(() => {
    const normalizeText = (value) => (value || '').replace(/\s+/g, '');
    const successPattern = /验证成功|已验证|验证通过|通过验证/;
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const readValue = (selectors) => {
      for (const selector of selectors) {
        const value = document.querySelector(selector)?.value || '';
        if (value.trim()) {
          return value.trim();
        }
      }
      return '';
    };
    const ticket = readValue([
      '#CaptchaTicket',
      'input[name="CaptchaTicket"]',
      'input[name="ticket"]',
      'input[name*="ticket" i]',
    ]);
    const rand = readValue([
      '#CaptchaRand',
      'input[name="CaptchaRand"]',
      'input[name="randstr"]',
      'input[name="rand"]',
      'input[name*="rand" i]',
    ]);
    if (ticket && rand) {
      return true;
    }

    const captchaRoot = document.querySelector('#TencentCaptcha');
    const nearbyText = normalizeText([
      captchaRoot?.textContent || '',
      captchaRoot?.getAttribute('value') || '',
      captchaRoot?.getAttribute('title') || '',
      captchaRoot?.getAttribute('aria-label') || '',
      captchaRoot?.parentElement?.textContent || '',
    ].join(' '));
    if (successPattern.test(nearbyText)) {
      return true;
    }

    const candidates = Array.from(document.querySelectorAll('input, button, a, span, div, td, label'));
    return candidates.some((element) => {
      if (!isVisible(element)) {
        return false;
      }
      const text = normalizeText([
        element.textContent || '',
        element.getAttribute('value') || '',
        element.getAttribute('title') || '',
        element.getAttribute('aria-label') || '',
      ].join(' '));
      if (!successPattern.test(text)) {
        return false;
      }

      const context = normalizeText([
        element.closest('tr')?.textContent || '',
        element.parentElement?.textContent || '',
        element.previousElementSibling?.textContent || '',
        element.nextElementSibling?.textContent || '',
      ].join(' '));
      return /验证码|安全验证|校验/.test(context) || text === '验证成功';
    });
  }).catch(() => false);
}

async function isTencentCaptchaFrameVerified(page) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) {
      continue;
    }
    const verified = await frame.evaluate(() => {
      const normalizeText = (value) => (value || '').replace(/\s+/g, '');
      return /验证成功|已验证|验证通过|通过验证/.test(normalizeText(document.body?.textContent || ''));
    }).catch(() => false);
    if (verified) {
      return true;
    }
  }
  return false;
}

async function confirmTencentCaptchaIfVisible(page) {
  for (const frame of page.frames()) {
    const buttons = [
      frame.getByRole('button', { name: /确定|确认|OK/i }),
      frame.locator('text=/^\\s*(确定|确认|OK)\\s*$/i'),
    ];
    for (const locator of buttons) {
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const item = locator.nth(i);
        if (await item.isVisible().catch(() => false)) {
          await item.click().catch(() => {});
          return;
        }
      }
    }
  }
}

async function waitForResultReady(page, selectors, scoreMap, timeoutMs) {
  if (selectors.resultContainer) {
    await page.locator(selectors.resultContainer).waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });
  } else {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
  }

  const scoreSelectors = Object.values(scoreMap || {}).filter(Boolean);
  if (selectors.resultContainer || scoreSelectors.length) {
    await page.waitForFunction(
      ({ resultContainer, selectors: configuredScoreSelectors }) => {
        const textFromSelector = (selector) => {
          if (!selector) {
            return '';
          }
          let element = null;
          if (selector.startsWith('xpath=')) {
            element = document.evaluate(
              selector.slice('xpath='.length),
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null,
            ).singleNodeValue;
          } else {
            element = document.querySelector(selector);
          }
          return element?.textContent?.trim() || '';
        };

        if (configuredScoreSelectors.some((selector) => textFromSelector(selector))) {
          return true;
        }

        const container = resultContainer ? document.querySelector(resultContainer) : document.body;
        const containerText = container?.textContent?.trim() || '';
        return Boolean(
          document.querySelector('#RestQuery')
            || document.querySelector('#tabInfo_ShowPZCJ')
            || containerText.includes('查询失败')
            || containerText.includes('无查询结果')
            || containerText.includes('很抱歉'),
        );
      },
      {
        resultContainer: selectors.resultContainer || '',
        selectors: scoreSelectors,
      },
      { timeout: timeoutMs },
    ).catch(() => {});
  }
}

async function queryOneStudent(page, rl, config, student, index, total, screenshotDir) {
  const selectors = config.selectors || {};
  const studentName = student['姓名'];
  const screenshotPath = path.join(screenshotDir, `${sanitizeFileName(studentName)}.png`);

    const publicStudent = {
    name: studentName,
    idCardMasked: maskSecret(student['身份证号']),
    admissionNoMasked: maskSecret(student['准考证号']),
    examineeNoMasked: maskSecret(student['考生号']),
    registrationNoMasked: maskSecret(student['报名序号']),
  };

  try {
    console.log(`\n[${index}/${total}] 查询 ${studentName}`);
    await page.goto(config.queryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs || 30000,
    });

    const queryMode = resolveQueryMode(config, student);
    await selectQueryMode(page, selectors, queryMode);

    const filled = await fillStudentFields(page, selectors, student, queryMode);
    if (!filled.name && await hasLikelyNameField(page, selectors.name)) {
      console.warn(`未自动定位到姓名输入框：${studentName}`);
    }
    if (!filled.examineeNo) {
      console.warn(`未自动定位到考生号输入框：${studentName}`);
    }
    if (queryMode === 'registrationNo') {
      if (student['报名序号'] && !filled.registrationNo) {
        console.warn(`未自动定位到报名序号输入框：${studentName}`);
      }
    } else if (student['身份证号'] && !filled.idCard) {
      console.warn(`未自动定位到身份证号输入框：${studentName}`);
    }
    const captchaState = await waitForManualCaptcha(page, rl, config, studentName);
    if (captchaState === 'verified') {
      console.log(`已识别 ${studentName} 图片验证成功，自动点击查询。`);
    } else if (captchaState === 'timeout') {
      console.warn(`未识别到 ${studentName} 图片验证成功状态，超时后尝试自动点击查询。`);
    }

    await submitQuery(page, selectors.submit);

    await waitForResultReady(page, selectors, config.scoreMap, config.resultTimeoutMs || 30000);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const mappedScores = await extractByScoreMap(page, config.scoreMap);
    const tableScores = await extractGenericTables(page);
    const textScores = await extractGenericScoreText(page, selectors.resultContainer);
    const scores = mergeScores(mappedScores, { ...textScores, ...tableScores });

    return {
      status: 'ok',
      student: publicStudent,
      scores,
      screenshotPath,
      queriedAt: new Date().toISOString(),
    };
  } catch (error) {
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    return {
      status: 'failed',
      student: publicStudent,
      scores: {},
      screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : '',
      error: error.message,
      queriedAt: new Date().toISOString(),
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireFile(args.config, 'config');
  requireFile(args.students, 'students CSV');

  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  if (args.url) {
    config.queryUrl = args.url;
  }
  if (!config.queryUrl) {
    throw new Error('config.queryUrl is required');
  }

  const students = loadStudents(args.students);
  const outputDir = config.outputDir || 'output';
  const screenshotDir = path.join(outputDir, 'screenshots');
  ensureDir(outputDir);
  ensureDir(screenshotDir);
  ensureDir(path.dirname(args.results));
  fs.writeFileSync(args.results, '', 'utf8');

  const browser = await chromium.launch({
    // 设置对应的浏览器例如下面的Microsoft；其他浏览器chrome是Google
    // channel: 'msedge',
    headless: Boolean(config.headless),
    slowMo: Number(config.slowMoMs || 0),
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const rl = readline.createInterface({ input, output });

  try {
    for (let i = 0; i < students.length; i += 1) {
      const result = await queryOneStudent(page, rl, config, students[i], i + 1, students.length, screenshotDir);
      fs.appendFileSync(args.results, `${JSON.stringify(result)}\n`, 'utf8');

      if (i < students.length - 1) {
        const delayMs = randomDelay(config.minDelayMs, config.maxDelayMs);
        console.log(`等待 ${Math.round(delayMs / 1000)} 秒后继续...`);
        await page.waitForTimeout(delayMs);
      }
    }
  } finally {
    rl.close();
    await context.close();
    await browser.close();
  }

  console.log(`\n查询完成，原始结果已写入 ${args.results}`);
  console.log('运行 npm run summary 生成 Excel 汇总表。');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

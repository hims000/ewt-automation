const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotDir = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

const CONFIG = {
  username: process.env.EWT_USER || '',
  password: process.env.EWT_PASS || '',
  headless: true,
  speed: '2X',
  progressThreshold: 0.85,
  checkInterval: 2000,
  maxErrors: 10,
};

const log = (m, msg, d) => {
  const t = new Date().toISOString().slice(11, 23);
  d ? console.log(`[${t}] [${m}]`, msg, d) : console.log(`[${t}] [${m}]`, msg);
};

const saveScreenshot = async (page, name) => {
  try {
    const fp = path.join(screenshotDir, `${name}_${Date.now()}.png`);
    await page.screenshot({ path: fp, fullPage: true });
    log('Screenshot', `已保存: ${fp}`);
  } catch (e) {
    log('Screenshot', '保存失败', e.message);
  }
};

const BYPASS = `(()=>{
  const oa=EventTarget.prototype.addEventListener,or=EventTarget.prototype.removeEventListener,m=new WeakMap();
  EventTarget.prototype.addEventListener=function(t,l,o){
    if(typeof l!=='function'||t!=='click'||!String(l).includes('isTrusted'))return oa.call(this,t,l,o);
    let w=m.get(l);if(!w){w=function(e){if(e&&typeof e==='object'&&'isTrusted'in e){const p=new Proxy(e,{get(t,p){if(p==='isTrusted'&&t.isTrusted===false&&(t.type==='click'||t.type==='submit'||t.type==='change'))return true;const v=t[p];return typeof v==='function'?v.bind(t):v}});return l.call(this,p)}return l.call(this,e)};m.set(l,w);m.set(w,l)}
    return oa.call(this,t,w,o);
  };
  EventTarget.prototype.removeEventListener=function(t,l,o){if(typeof l==='function'){const w=m.get(l);if(w)return or.call(this,t,w,o)}return or.call(this,t,l,o)};
})();`;

const LOCK = `(()=>{if(document.getElementById('ewt-progress-lock-style'))return;const s=document.createElement('style');s.id='ewt-progress-lock-style';s.textContent='[class*="progress"],[class*="prgs"]{pointer-events:none!important;cursor:not-allowed!important;}';document.head.appendChild(s);})();`;

const HIDE = `(()=>{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});})();`;

// ==================== 页面加载（带重试） ====================
async function gotoWithRetry(page, url, options = {}) {
  const opts = { timeout: 60000, waitUntil: 'load', ...options };
  for (let i = 0; i < 3; i++) {
    try {
      log('Navigate', `尝试访问 ${url} (第${i + 1}次)...`);
      await page.goto(url, opts);
      log('Navigate', '页面加载成功');
      return;
    } catch (e) {
      log('Navigate', `第${i + 1}次加载失败: ${e.message}`);
      if (i === 2) throw e;
      await page.waitForTimeout(5000);
    }
  }
}

// ==================== 协议弹窗处理 ====================
async function handleAgreementModal(page) {
  const preciseSelector = 'div.ant-modal-wrap:nth-of-type(2) > div.ant-modal.login__password-agreement-modal > div.ant-modal-content:nth-of-type(2) > div.ant-modal-body:nth-of-type(2) > div > div.privacy__agreement__modal-btn:nth-of-type(2) > button.ant-btn.ant-btn-primary:nth-of-type(2) > span';

  const preciseBtn = await page.$(preciseSelector);
  if (preciseBtn && await preciseBtn.isVisible().catch(() => false)) {
    log('Agreement', '找到精确选择器的"同意并继续"按钮');
    await preciseBtn.click();
    log('Agreement', '已点击"同意并继续"');
    await page.waitForTimeout(3000);
    return true;
  }

  const fallbackSelectors = [
    'button:has-text("同意并继续")',
    'button:has-text("同意")',
    'button:has-text("确认")',
    '.ant-btn-primary:has-text("同意")',
    '.login__password-agreement-modal button.ant-btn-primary',
    '.privacy__agreement__modal-btn button',
  ];

  for (const sel of fallbackSelectors) {
    const btn = await page.$(sel);
    if (btn && await btn.isVisible().catch(() => false)) {
      const text = await btn.textContent().catch(() => '');
      log('Agreement', `找到兜底按钮: "${text.trim()}" (${sel})`);
      const disabled = await btn.evaluate(e => e.disabled).catch(() => false);
      if (disabled) {
        log('Agreement', '按钮被禁用，等待倒计时...');
        await page.waitForFunction((s) => {
          const el = document.querySelector(s);
          return el && !el.disabled;
        }, { timeout: 10000 }, sel);
      }
      await btn.click();
      log('Agreement', `已点击"${text.trim()}"`);
      await page.waitForTimeout(3000);
      return true;
    }
  }

  return false;
}

// ==================== 通用登录函数 ====================
async function performLogin(page) {
  log('Login', '尝试在当前页面登录...');
  await saveScreenshot(page, 'login_attempt');

  const hasUserInput = await page.$('input#login__password_userName, input[placeholder*="账号"], input[name="username"], input[type="text"]').catch(() => null);
  const hasPassInput = await page.$('input#login__password_password, input[placeholder*="密码"], input[name="password"], input[type="password"]').catch(() => null);

  if (!hasUserInput || !hasPassInput) {
    log('Login', '当前页面没有登录表单');
    return false;
  }

  await page.fill('input#login__password_userName, input[placeholder*="账号"], input[name="username"], input[type="text"]', CONFIG.username);
  await page.fill('input#login__password_password, input[placeholder*="密码"], input[name="password"], input[type="password"]', CONFIG.password);
  log('Login', '已填写账号密码');

  const cb = await page.$('label.ant-checkbox-wrapper input[type="checkbox"], input[type="checkbox"]').catch(() => null);
  if (cb) {
    const checked = await cb.evaluate(e => e.checked).catch(() => true);
    if (!checked) {
      await cb.click();
      log('Login', '已勾选协议复选框');
    }
  }

  const loginBtn = await page.$('button.ant-btn.ant-btn-primary.ant-btn-lg.ant-btn-block, button:has-text("登录"), button[type="submit"]').catch(() => null);
  if (loginBtn) {
    await loginBtn.click();
    log('Login', '已点击登录按钮');
  } else {
    log('Login', '未找到登录按钮');
    return false;
  }

  await page.waitForTimeout(3000);
  await saveScreenshot(page, 'after_login_click');

  const modalHandled = await handleAgreementModal(page);
  if (modalHandled) {
    await saveScreenshot(page, 'after_agreement_modal');
  }

  return true;
}

// ==================== 主登录流程 ====================
async function login(page) {
  log('Login', '打开登录页...');
  await gotoWithRetry(page, 'https://web.ewt360.com/site-study/#/login');
  await saveScreenshot(page, 'login_page_loaded');

  if (!CONFIG.username || !CONFIG.password) {
    throw new Error('缺少账号或密码，请设置 EWT_USER 和 EWT_PASS 环境变量');
  }

  await performLogin(page);

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    const currentUrl = page.url();
    log('Login', `第${attempts}次尝试后URL: ${currentUrl}`);
    await saveScreenshot(page, `login_check_${attempts}`);

    if (!currentUrl.includes('/login') && !currentUrl.includes('/register')) {
      log('Login', '登录成功，已离开登录页');
      return;
    }

    if (currentUrl.includes('/login') || currentUrl.includes('/register')) {
      log('Login', '仍在登录页，检查是否需要重新登录...');

      const errorMsg = await page.$eval('.ant-form-item-explain-error, .login-error, [class*="error"], .ant-message-error', el => el.textContent).catch(() => null);
      if (errorMsg) {
        log('Login', `登录错误提示: ${errorMsg}`);
      }

      const hasForm = await page.$('input[type="password"]').catch(() => null);
      if (hasForm) {
        log('Login', '检测到登录表单，重新填写...');
        await performLogin(page);
      } else {
        log('Login', '未检测到登录表单，等待页面稳定...');
        await page.waitForTimeout(5000);
      }
    }
  }

  throw new Error('登录失败：多次尝试后仍在登录页，可能账号密码错误或需要验证码');
}

// ==================== 导航到课程 ====================
async function navigateToCourse(page) {
  await page.waitForTimeout(2000);
  const currentUrl = page.url();
  log('Navigate', `当前URL: ${currentUrl}`);
  await saveScreenshot(page, 'navigate_start');

  if (currentUrl.includes('/student/homework') || currentUrl.includes('/holiday') || currentUrl.includes('/index')) {
    log('Navigate', '在作业/首页，查找任务入口...');

    const selectors = [
      'div.content-Z09Pe:nth-of-type(2) > div.right-DuHqH:nth-of-type(2) > div.list-phpq1 > section > ul > li.taskItem-ZeyMG:nth-of-type(1) > div.row3-Ndo5z:nth-of-type(2) > div.row3_col2-uhJci:nth-of-type(2)',
      'div.btn-AoqsA[data-type="2"]',
      'div.btn-AoqsA:has(span.text-riKYz:has-text("学"))',
      'span:has-text("开始学习")',
      'button:has-text("开始学习")',
      'a:has-text("开始学习")',
      '.taskItem-ZeyMG',
      '[class*="task"]',
      '[class*="homework"]',
    ];

    let clicked = false;
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) {
        log('Navigate', `找到元素，点击: ${sel}`);
        await el.click();
        clicked = true;
        await page.waitForTimeout(3000);
        break;
      }
    }

    if (!clicked) {
      log('Navigate', '未找到任务入口按钮');
    }
  }

  if (!page.url().includes('student-task-overview')) {
    log('Navigate', '直接跳转目标课程URL');
    await gotoWithRetry(page, 'https://teacher.ewt360.com/ewtbend/bend/index/index.html#/holiday/student-task-overview?homeworkId=10508160');
    await page.waitForTimeout(3000);
  }

  await saveScreenshot(page, 'course_page');

  try {
    await page.waitForSelector('.listCon-zrsBh, video, .item-blpma, .video-js, [class*="video"], [class*="player"]', { timeout: 15000 });
    log('Navigate', '已进入课程播放页面');
  } catch (e) {
    log('Navigate', '未检测到标准视频列表，尝试备用检测...');
    await page.waitForSelector('video, iframe, [class*="play"]', { timeout: 10000 });
    log('Navigate', '检测到视频播放器');
  }
}

// ==================== 主循环 ====================
async function mainLoop(page) {
  await page.evaluate(LOCK);
  let errors = 0;
  let lastSwitch = Date.now();
  let lastPct = '';

  while (errors < CONFIG.maxErrors) {
    try {
      await page.evaluate((s) => {
        document.querySelectorAll('.vjs-menu-content .vjs-menu-item').forEach(i => {
          const txt = i.querySelector('.vjs-menu-item-text')?.textContent.trim();
          if (txt === s && !i.classList.contains('vjs-selected')) i.click();
        });
      }, CONFIG.speed);

      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button,a,span.btn,div.btn'))
          .find(x => x.textContent.trim() === '跳过');
        if (b && !b.dataset.skipClicked) {
          b.dataset.skipClicked = 'true';
          b.click();
          setTimeout(() => delete b.dataset.skipClicked, 5000);
        }
      });

      await page.evaluate(() => {
        const b = document.querySelector('span.btn-DOCWn');
        if (b && b.textContent.trim() === '点击通过检查' && !b.dataset.checkClicked) {
          b.dataset.checkClicked = 'true';
          b.click();
          setTimeout(() => delete b.dataset.checkClicked, 3000);
        }
      });

      const r = await page.evaluate((thresh) => {
        const list = document.querySelector('.listCon-zrsBh');
        if (!list) return { action: 'no-list' };
        const all = Array.from(list.querySelectorAll('.item-blpma'));
        const active = list.querySelector('.item-blpma.active-EI2Hl');
        if (!active) return { action: 'no-active' };
        const v = document.querySelector('video');
        if (!v || isNaN(v.duration) || v.duration <= 0) return { action: 'no-video' };
        const can = thresh >= 1.0 ? (v.duration - v.currentTime <= 2) : (v.currentTime / v.duration >= thresh);
        if (!can) return { action: 'waiting', pct: (v.currentTime / v.duration * 100).toFixed(1) + '%' };
        const idx = all.findIndex(e => e.classList.contains('active-EI2Hl'));
        if (idx < 0 || idx + 1 >= all.length) return { action: 'finished' };
        all[idx + 1].click();
        return { action: 'switched', to: idx + 2, total: all.length };
      }, CONFIG.progressThreshold);

      if (r.action === 'switched') {
        log('AutoPlay', `✅ 已切换到第 ${r.to}/${r.total} 个视频`);
        lastSwitch = Date.now();
        await page.evaluate(LOCK);
      } else if (r.action === 'finished') {
        log('AutoPlay', '🎉 所有视频已播放完毕！');
        await saveScreenshot(page, 'finished');
        break;
      } else if (r.action === 'waiting' && r.pct !== lastPct) {
        log('AutoPlay', `⏳ 当前进度: ${r.pct}`);
        lastPct = r.pct;
      }

      const stuck = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v && v.paused && v.currentTime > 0 && v.currentTime < v.duration;
      });
      if (stuck && Date.now() - lastSwitch > 300000) {
        log('Main', '⚠️ 检测到视频暂停，尝试恢复播放');
        await page.evaluate(() => document.querySelector('video')?.play());
      }

      errors = 0;
      await page.waitForTimeout(CONFIG.checkInterval);
    } catch (err) {
      errors++;
      log('Main', `❌ 循环出错 (${errors}/${CONFIG.maxErrors}): ${err.message}`);
      await saveScreenshot(page, `error_${errors}`);
      await page.waitForTimeout(3000);
    }
  }

  if (errors >= CONFIG.maxErrors) {
    throw new Error('连续错误次数过多，终止运行');
  }
}

// ==================== 入口 ====================
(async () => {
  log('Main', '启动浏览器 (GitHub Actions 模式)...');

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });

  const page = await ctx.newPage();
  await page.addInitScript(BYPASS);
  await page.addInitScript(HIDE);

  try {
    await login(page);
    await navigateToCourse(page);
    await mainLoop(page);
    log('Main', '✅ 全部任务完成');
  } catch (err) {
    log('Main', `💥 致命错误: ${err.message}`);
    await saveScreenshot(page, 'fatal_error');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

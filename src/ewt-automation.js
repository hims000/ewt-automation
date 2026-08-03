const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 确保截图目录存在
const screenshotDir = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

// ==================== 配置 ====================
const CONFIG = {
  username: process.env.EWT_USER || '',
  password: process.env.EWT_PASS || '',
  headless: true,               // GitHub Actions 必须无头
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

// ==================== 注入脚本 ====================
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

// ==================== 登录 ====================
async function login(page) {
  log('Login', '打开登录页...');
  await page.goto('https://web.ewt360.com/site-study/#/login', { waitUntil: 'networkidle', timeout: 30000 });
  await saveScreenshot(page, 'step1_login');

  if (!CONFIG.username || !CONFIG.password) {
    throw new Error('缺少账号或密码，请设置 EWT_USER 和 EWT_PASS 环境变量');
  }

  await page.fill('input#login__password_userName', CONFIG.username);
  await page.fill('input#login__password_password', CONFIG.password);
  log('Login', '已填写账号密码');

  // 协议复选框
  const cb = await page.$('label.ant-checkbox-wrapper input[type="checkbox"]');
  if (cb) {
    const checked = await cb.evaluate(e => e.checked);
    if (!checked) {
      await cb.click();
      log('Login', '已勾选协议复选框');
    }
  }

  await page.click('button.ant-btn.ant-btn-primary.ant-btn-lg.ant-btn-block');
  log('Login', '已点击登录');

  // 等待响应，检测协议弹窗
  await page.waitForTimeout(1500);
  await saveScreenshot(page, 'step2_after_login_click');

  const popupBtn = await page.$('button:has-text("同意"), button:has-text("确认"), .ant-btn:has-text("同意")');
  if (popupBtn && await popupBtn.isVisible().catch(() => false)) {
    const disabled = await popupBtn.evaluate(e => e.disabled).catch(() => false);
    if (disabled) {
      log('Login', '同意按钮被禁用，等待倒计时...');
      await page.waitForFunction(() => {
        const b = document.querySelector('button:has-text("同意"), button:has-text("确认")');
        return b && !b.disabled;
      }, { timeout: 10000 });
    }
    await popupBtn.click();
    log('Login', '已点击弹窗同意按钮');
    await page.waitForTimeout(1000);
  }

  // 等待登录成功标志（扩大检测范围）
  await page.waitForSelector(
    '.user-avatar, .content-Z09Pe, .taskItem-ZeyMG, .btn-AoqsA, .student-name, .home-container, .listCon-zrsBh, .holiday-task',
    { timeout: 15000 }
  );
  log('Login', '登录成功');
  await saveScreenshot(page, 'step3_login_success');
}

// ==================== 导航到课程 ====================
async function navigateToCourse(page) {
  await page.waitForTimeout(2000);
  const currentUrl = page.url();
  log('Navigate', `当前URL: ${currentUrl}`);
  await saveScreenshot(page, 'step4_homework_list');

  // 如果在作业列表页，点击第一个任务
  if (currentUrl.includes('/student/homework') || currentUrl.includes('/holiday')) {
    log('Navigate', '在作业列表页，查找任务入口...');

    // 精确选择器
    const primary = 'div.content-Z09Pe:nth-of-type(2) > div.right-DuHqH:nth-of-type(2) > div.list-phpq1 > section > ul > li.taskItem-ZeyMG:nth-of-type(1) > div.row3-Ndo5z:nth-of-type(2) > div.row3_col2-uhJci:nth-of-type(2)';
    const target = await page.$(primary);

    if (target && await target.isVisible().catch(() => false)) {
      log('Navigate', '找到主目标，点击...');
      await target.click();
    } else {
      // 备选：data-type="2" 的"学"按钮
      const btn = await page.$('div.btn-AoqsA[data-type="2"]');
      if (btn && await btn.isVisible().catch(() => false)) {
        log('Navigate', '找到"学"按钮，点击...');
        await btn.click();
      } else {
        // 兜底：直接跳转目标URL
        log('Navigate', '未找到按钮，直接跳转目标URL');
        await page.goto('https://teacher.ewt360.com/ewtbend/bend/index/index.html#/holiday/student-task-overview?homeworkId=10508160', {
          waitUntil: 'networkidle',
          timeout: 30000,
        });
      }
    }
  }

  // 等待课程页面加载
  await page.waitForTimeout(2000);
  await saveScreenshot(page, 'step5_course_page');

  try {
    await page.waitForSelector('.listCon-zrsBh, video, .item-blpma, .video-js, [class*="video"]', { timeout: 15000 });
    log('Navigate', '已进入课程播放页面');
  } catch (e) {
    log('Navigate', '未检测到标准视频列表，尝试备用检测...');
    await page.waitForSelector('video, iframe', { timeout: 10000 });
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
      // 1. 维持倍速
      await page.evaluate((s) => {
        document.querySelectorAll('.vjs-menu-content .vjs-menu-item').forEach(i => {
          const txt = i.querySelector('.vjs-menu-item-text')?.textContent.trim();
          if (txt === s && !i.classList.contains('vjs-selected')) i.click();
        });
      }, CONFIG.speed);

      // 2. 自动跳题
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button,a,span.btn,div.btn'))
          .find(x => x.textContent.trim() === '跳过');
        if (b && !b.dataset.skipClicked) {
          b.dataset.skipClicked = 'true';
          b.click();
          setTimeout(() => delete b.dataset.skipClicked, 5000);
        }
      });

      // 3. 自动过检
      await page.evaluate(() => {
        const b = document.querySelector('span.btn-DOCWn');
        if (b && b.textContent.trim() === '点击通过检查' && !b.dataset.checkClicked) {
          b.dataset.checkClicked = 'true';
          b.click();
          setTimeout(() => delete b.dataset.checkClicked, 3000);
        }
      });

      // 4. 自动连播
      const result = await page.evaluate((thresh) => {
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

      if (result.action === 'switched') {
        log('AutoPlay', `✅ 已切换到第 ${result.to}/${result.total} 个视频`);
        lastSwitch = Date.now();
        await page.evaluate(LOCK);
      } else if (result.action === 'finished') {
        log('AutoPlay', '🎉 所有视频已播放完毕！');
        await saveScreenshot(page, 'step6_finished');
        break;
      } else if (result.action === 'waiting' && result.pct !== lastPct) {
        log('AutoPlay', `⏳ 当前进度: ${result.pct}`);
        lastPct = result.pct;
      }

      // 5. 防挂机：视频暂停自动恢复
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

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const dns = require('dns');
const https = require('https');

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
  heartbeatInterval: 30000,
};

let lastHeartbeat = Date.now();

const log = (m, msg, d) => {
  const t = new Date().toISOString().slice(11, 23);
  const line = d ? `[${t}] [${m}] ${msg} ${JSON.stringify(d)}` : `[${t}] [${m}] ${msg}`;
  console.log(line);
  lastHeartbeat = Date.now();
};

const heartbeat = () => {
  const elapsed = Date.now() - lastHeartbeat;
  if (elapsed > CONFIG.heartbeatInterval) {
    log('Heartbeat', `脚本仍在运行，已等待 ${(elapsed / 1000).toFixed(0)} 秒无事件...`);
  }
};

const saveScreenshot = async (page, name) => {
  try {
    const fp = path.join(screenshotDir, `${name}_${Date.now()}.png`);
    await page.screenshot({ path: fp, fullPage: true });
    log('Screenshot', `已保存: ${fp}`);
  } catch (e) {
    log('Screenshot', `保存失败: ${e.message}`);
  }
};

// 打印页面HTML片段用于调试
const dumpPageHtml = async (page, maxLen = 2000) => {
  try {
    const html = await page.content();
    const snippet = html.replace(/\s+/g, ' ').slice(0, maxLen);
    log('Debug', `页面HTML前${maxLen}字符: ${snippet}`);
  } catch (e) {
    log('Debug', `获取HTML失败: ${e.message}`);
  }
};

// ==================== 网络诊断 ====================
function dnsLookup(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, addresses: addresses.map(a => a.address) });
    });
  });
}

function httpCheck(url, timeout = 10000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        success: true,
        status: res.statusCode,
        bodyPreview: data.slice(0, 500).replace(/\s+/g, ' ')
      }));
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
    req.setTimeout(timeout);
  });
}

async function networkDiagnostics() {
  log('NetDiag', '========== 网络诊断开始 ==========');
  try {
    const ip = execSync('curl -s https://api.ipify.org', { encoding: 'utf8', timeout: 10000 });
    log('NetDiag', `本机出口IP: ${ip.trim()}`);
  } catch (e) {
    log('NetDiag', `获取本机IP失败: ${e.message}`);
  }

  for (const host of ['web.ewt360.com', 'teacher.ewt360.com']) {
    const dnsResult = await dnsLookup(host);
    log('NetDiag', `DNS ${host}:`, dnsResult);
  }

  for (const url of ['https://web.ewt360.com', 'https://teacher.ewt360.com']) {
    const httpResult = await httpCheck(url);
    log('NetDiag', `HTTP ${url}:`, httpResult);
  }

  log('NetDiag', '========== 网络诊断结束 ==========');
}

// ==================== 页面加载 ====================
async function gotoWithRetry(page, url, options = {}) {
  const opts = { timeout: 60000, waitUntil: 'load', ...options };
  for (let i = 0; i < 3; i++) {
    try {
      log('Navigate', `尝试访问 ${url} (第${i + 1}次)...`);
      const start = Date.now();
      await page.goto(url, opts);
      log('Navigate', `页面加载成功，耗时 ${Date.now() - start}ms，当前URL: ${page.url()}`);
      return;
    } catch (e) {
      log('Navigate', `第${i + 1}次加载失败: ${e.message}`);
      if (i === 2) throw e;
      await page.waitForTimeout(5000);
    }
  }
}

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

// ==================== 检测页面是否有登录表单 ====================
async function hasLoginForm(page) {
  const userInput = await page.$('input#login__password_userName').catch(() => null);
  const passInput = await page.$('input#login__password_password').catch(() => null);
  const anyUser = await page.$('input[placeholder*="账号"], input[name="username"]').catch(() => null);
  const anyPass = await page.$('input[placeholder*="密码"], input[name="password"], input[type="password"]').catch(() => null);

  log('Login', `登录表单检测: userInput=${!!userInput} passInput=${!!passInput} anyUser=${!!anyUser} anyPass=${!!anyPass}`);

  return !!(userInput || anyUser) && !!(passInput || anyPass);
}

// ==================== 通用登录函数 ====================
async function performLogin(page) {
  log('Login', '尝试在当前页面登录...');
  await saveScreenshot(page, 'login_attempt');
  await dumpPageHtml(page, 1500);

  const hasForm = await hasLoginForm(page);
  if (!hasForm) {
    log('Login', '当前页面没有登录表单，打印页面标题...');
    const title = await page.title().catch(() => 'unknown');
    log('Login', `页面标题: "${title}"`);
    return false;
  }

  // 优先使用精确ID
  const userInput = await page.$('input#login__password_userName');
  const passInput = await page.$('input#login__password_password');

  if (userInput && passInput) {
    await userInput.fill(CONFIG.username);
    await passInput.fill(CONFIG.password);
  } else {
    await page.fill('input[placeholder*="账号"], input[name="username"]', CONFIG.username);
    await page.fill('input[placeholder*="密码"], input[name="password"], input[type="password"]', CONFIG.password);
  }
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
  await dumpPageHtml(page, 1500);

  if (!CONFIG.username || !CONFIG.password) {
    throw new Error('缺少账号或密码，请设置 EWT_USER 和 EWT_PASS 环境变量');
  }

  await performLogin(page);

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    const currentUrl = page.url();
    const hasForm = await hasLoginForm(page);
    log('Login', `第${attempts}次检查: URL=${currentUrl} hasForm=${hasForm}`);
    await saveScreenshot(page, `login_check_${attempts}`);
    await dumpPageHtml(page, 1000);

    // 如果页面没有登录表单且不在登录页，认为登录成功
    if (!hasForm && !currentUrl.includes('/login') && !currentUrl.includes('/register')) {
      log('Login', '登录成功，已离开登录页且无登录表单');
      return;
    }

    // 如果页面没有登录表单但在登录页，可能是被重定向了，等一等
    if (!hasForm && (currentUrl.includes('/login') || currentUrl.includes('/register'))) {
      log('Login', '在登录页但没有表单，等待页面加载...');
      await page.waitForTimeout(5000);
      continue;
    }

    // 如果还有表单，重新尝试登录
    if (hasForm) {
      log('Login', '检测到登录表单仍在，重新填写...');
      await performLogin(page);
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
  await dumpPageHtml(page, 1000);

  // 如果在作业列表页，点击第一个任务
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

  // 确保进入课程页面
  if (!page.url().includes('student-task-overview')) {
    log('Navigate', '直接跳转目标课程URL');
    await gotoWithRetry(page, 'https://teacher.ewt360.com/ewtbend/bend/index/index.html#/holiday/student-task-overview?homeworkId=10508160');
    await page.waitForTimeout(3000);
  }

  await saveScreenshot(page, 'course_page');
  await dumpPageHtml(page, 2000);

  // 更宽松的检测：先等页面稳定
  log('Navigate', '等待页面元素稳定...');
  await page.waitForTimeout(5000);

  // 检测视频相关元素（扩大范围）
  const videoSelectors = [
    'video',
    'iframe',
    '.listCon-zrsBh',
    '.item-blpma',
    '.video-js',
    '[class*="video"]',
    '[class*="player"]',
    '[class*="play"]',
    '.vjs-tech',
    '#vjs_video_3',
    '[id*="video"]',
  ];

  for (const sel of videoSelectors) {
    const el = await page.$(sel);
    if (el) {
      log('Navigate', `找到视频相关元素: ${sel}`);
      return;
    }
  }

  log('Navigate', '未找到任何视频相关元素，但继续执行...');
}

// ==================== 主循环 ====================
async function mainLoop(page) {
  log('Main', '开始注入进度条锁定...');
  await page.evaluate(LOCK);
  log('Main', '进度条锁定已注入');

  let errors = 0;
  let lastSwitch = Date.now();
  let lastPct = '';
  let loopCount = 0;

  while (errors < CONFIG.maxErrors) {
    loopCount++;
    heartbeat();

    try {
      log('Loop', `=== 第 ${loopCount} 轮循环开始 ===`);

      // 1. 维持倍速
      log('Loop', '检查倍速...');
      const speedChanged = await page.evaluate((s) => {
        let changed = false;
        document.querySelectorAll('.vjs-menu-content .vjs-menu-item').forEach(i => {
          const txt = i.querySelector('.vjs-menu-item-text')?.textContent.trim();
          if (txt === s && !i.classList.contains('vjs-selected')) {
            i.click();
            changed = true;
          }
        });
        return changed;
      }, CONFIG.speed);
      if (speedChanged) log('Loop', `已切换倍速到 ${CONFIG.speed}`);
      else log('Loop', '倍速正常或不存在倍速菜单');

      // 2. 自动跳题
      log('Loop', '检查是否有"跳过"按钮...');
      const skipped = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button,a,span.btn,div.btn'))
          .find(x => x.textContent.trim() === '跳过');
        if (b && !b.dataset.skipClicked) {
          b.dataset.skipClicked = 'true';
          b.click();
          setTimeout(() => delete b.dataset.skipClicked, 5000);
          return true;
        }
        return false;
      });
      if (skipped) log('Loop', '已点击"跳过"按钮');
      else log('Loop', '没有"跳过"按钮');

      // 3. 自动过检
      log('Loop', '检查是否有"点击通过检查"...');
      const passed = await page.evaluate(() => {
        const b = document.querySelector('span.btn-DOCWn');
        if (b && b.textContent.trim() === '点击通过检查' && !b.dataset.checkClicked) {
          b.dataset.checkClicked = 'true';
          b.click();
          setTimeout(() => delete b.dataset.checkClicked, 3000);
          return true;
        }
        return false;
      });
      if (passed) log('Loop', '已点击"点击通过检查"');
      else log('Loop', '没有"点击通过检查"按钮');

      // 4. 自动连播
      log('Loop', '检查视频播放进度...');
      const result = await page.evaluate((thresh) => {
        const list = document.querySelector('.listCon-zrsBh');
        if (!list) return { action: 'no-list' };
        const all = Array.from(list.querySelectorAll('.item-blpma'));
        const active = list.querySelector('.item-blpma.active-EI2Hl');
        if (!active) return { action: 'no-active', totalVideos: all.length };
        const v = document.querySelector('video');
        if (!v || isNaN(v.duration) || v.duration <= 0) {
          return { action: 'no-video', hasVideo: !!v, duration: v?.duration };
        }
        const pct = v.currentTime / v.duration;
        const can = thresh >= 1.0 ? (v.duration - v.currentTime <= 2) : (pct >= thresh);
        if (!can) {
          return {
            action: 'waiting',
            pct: (pct * 100).toFixed(1) + '%',
            current: v.currentTime.toFixed(1),
            total: v.duration.toFixed(1),
            paused: v.paused,
            ended: v.ended,
          };
        }
        const idx = all.findIndex(e => e.classList.contains('active-EI2Hl'));
        if (idx < 0 || idx + 1 >= all.length) return { action: 'finished', total: all.length };
        all[idx + 1].click();
        return { action: 'switched', to: idx + 2, total: all.length };
      }, CONFIG.progressThreshold);

      log('Loop', `视频检测结果: ${JSON.stringify(result)}`);

      if (result.action === 'switched') {
        log('AutoPlay', `✅ 已切换到第 ${result.to}/${result.total} 个视频`);
        lastSwitch = Date.now();
        await page.evaluate(LOCK);
        log('AutoPlay', '进度条锁定已重新注入');
      } else if (result.action === 'finished') {
        log('AutoPlay', '🎉 所有视频已播放完毕！');
        await saveScreenshot(page, 'finished');
        break;
      } else if (result.action === 'waiting' && result.pct !== lastPct) {
        log('AutoPlay', `⏳ 当前进度: ${result.pct} (${result.current}s / ${result.total}s) [暂停:${result.paused} 结束:${result.ended}]`);
        lastPct = result.pct;
      } else if (result.action === 'no-list') {
        log('AutoPlay', '⚠️ 未找到视频列表 (.listCon-zrsBh)，可能页面结构不同');
      } else if (result.action === 'no-active') {
        log('AutoPlay', `⚠️ 未找到当前激活的视频，视频总数: ${result.totalVideos}`);
      } else if (result.action === 'no-video') {
        log('AutoPlay', `⚠️ 未找到 video 标签 (hasVideo:${result.hasVideo} duration:${result.duration})`);
      }

      // 5. 防挂机
      const stuck = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v && v.paused && v.currentTime > 0 && v.currentTime < v.duration;
      });
      if (stuck) {
        const stuckTime = Date.now() - lastSwitch;
        log('Loop', `⚠️ 视频处于暂停状态，已暂停 ${(stuckTime / 1000).toFixed(0)} 秒`);
        if (stuckTime > 300000) {
          log('Main', '⚠️ 视频暂停超过5分钟，尝试恢复播放');
          await page.evaluate(() => document.querySelector('video')?.play());
          log('Main', '已调用 video.play()');
        }
      } else {
        log('Loop', '视频播放正常或不存在视频');
      }

      errors = 0;
      log('Loop', `=== 第 ${loopCount} 轮循环结束，等待 ${CONFIG.checkInterval}ms ===\n`);
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

  await networkDiagnostics();

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
    log('Main', '关闭浏览器...');
    await browser.close();
  }
})();

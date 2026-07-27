// scripts/login.js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

// 启用隐形插件，专门用来绕过 Cloudflare 5秒盾
puppeteer.use(StealthPlugin());

const LOGIN_URL = 'https://betadash.lunes.host/servers/91427';

// Telegram 通知
async function notifyTelegram({ ok, stage, msg, screenshotPath }) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const text = [
      `🔔 Lunes 自动操作：${ok ? '✅ 成功' : '❌ 失败'}`,
      `阶段：${stage}`,
      msg ? `信息：${msg}` : '',
      `时间：${new Date().toISOString()}`
    ].filter(Boolean).join('\n');

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });

    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const fileBuffer = fs.readFileSync(screenshotPath);
      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('caption', `Lunes 自动操作截图（${stage}）`);
      formData.append('photo', new Blob([fileBuffer], { type: 'image/png' }), 'screenshot.png');

      await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        body: formData
      });
    }
  } catch (e) {
    console.log('[WARN] Telegram 通知失败：', e.message);
  }
}

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`环境变量 ${name} 未设置`);
  return v;
}

// 解决 Turnstile 验证码
async function solveTurnstile(page, apiKey) {
  console.log('检测到表单验证码，开始寻找 sitekey...');

  let sitekey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    return el ? el.getAttribute('data-sitekey') : null;
  });

  if (!sitekey) {
    const content = await page.content();
    const match = content.match(/0x4[A-Za-z0-9_-]{20,30}/);
    if (match) sitekey = match[0];
  }

  if (!sitekey) throw new Error('没有找到 Turnstile sitekey');
  console.log('找到 sitekey:', sitekey);

  const createRes = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      key: apiKey,
      method: 'turnstile',
      sitekey: sitekey,
      pageurl: page.url(),
      json: '1'
    })
  });

  const createData = await createRes.json();
  if (createData.status !== 1) throw new Error('2Captcha 提交失败: ' + JSON.stringify(createData));

  const requestId = createData.request;
  console.log('2Captcha 任务 ID:', requestId);

  let token = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const resultRes = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`);
    const resultData = await resultRes.json();

    if (resultData.status === 1) {
      token = resultData.request;
      console.log('2Captcha 成功拿到 token');
      break;
    }
    if (resultData.request !== 'CAPCHA_NOT_READY') {
      throw new Error('2Captcha 返回错误: ' + JSON.stringify(resultData));
    }
    console.log(`等待打码中... (${i + 1}/40)`);
  }
  if (!token) throw new Error('2Captcha 超时');

  await page.evaluate((token) => {
    const setAndDispatch = (el) => {
      if (!el) return;
      el.value = token;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    document.querySelectorAll('[name="cf-turnstile-response"], [name="g-recaptcha-response"]').forEach(setAndDispatch);

    let form = document.querySelector('form') || document.body;
    let cfInput = document.querySelector('input[name="cf-turnstile-response"]');
    if (!cfInput) {
      cfInput = document.createElement('input');
      cfInput.type = 'hidden';
      cfInput.name = 'cf-turnstile-response';
      form.appendChild(cfInput);
    }
    setAndDispatch(cfInput);
  }, token);

  console.log('Token 注入完成');
  await new Promise(r => setTimeout(r, 3000));
  return token;
}

async function main() {
  const username = envOrThrow('LUNES_USERNAME');
  const password = envOrThrow('LUNES_PASSWORD');
  const apiKey = envOrThrow('TWOCAPTCHA_API_KEY');

  // 使用伪装度极高的 Puppeteer 启动参数
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  const screenshot = (name) => `./${name}.png`;

  try {
    console.log('正在打开登录页面...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // 留出 5 秒给 Cloudflare 自动完成指纹校验（隐形插件通常会自动过盾）
    await new Promise(r => setTimeout(r, 5000));

    // 检查是否依然有小框验证码
    const hasTurnstile = await page.$('[data-sitekey]') !== null || 
                         await page.$('iframe[src*="turnstile"]') !== null;

    if (hasTurnstile) {
      const sp = screenshot('01-before-captcha');
      await page.screenshot({ path: sp, fullPage: true });
      await notifyTelegram({ ok: false, stage: '检测到验证码', msg: '开始调用 2Captcha', screenshotPath: sp });

      await solveTurnstile(page, apiKey);
    }

    // 填写账号密码
    console.log('开始填写账号密码...');
    await page.waitForSelector('input[type="email"], input[name="username"], input[name="email"]', { timeout: 20000 });
    
    // 模拟真人敲键盘输入（防抓包识别）
    const userInput = (await page.$('input[name="username"]')) || (await page.$('input[type="email"]'));
    const passInput = await page.$('input[type="password"]');

    await userInput.type(username, { delay: 50 });
    await passInput.type(password, { delay: 50 });

    const loginBtn = await page.$('button[type="submit"]');

    const spBefore = screenshot('02-before-submit');
    await page.screenshot({ path: spBefore, fullPage: true });

    // 点击提交并等待
    await Promise.all([
      loginBtn.click(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
    ]);

    await new Promise(r => setTimeout(r, 5000));

    const spAfter = screenshot('03-after-submit');
    await page.screenshot({ path: spAfter, fullPage: true });

    const url = page.url();
    const success = !url.includes('/login');

    if (success) {
      console.log('✅ 登录成功！当前URL:', url);
      await notifyTelegram({ ok: true, stage: '登录成功', msg: `当前 URL：${url}`, screenshotPath: spAfter });
      process.exitCode = 0;
    } else {
      console.log('❌ 登录可能失败');
      await notifyTelegram({ ok: false, stage: '登录失败', msg: `仍在登录相关页面：${url}`, screenshotPath: spAfter });
      process.exitCode = 1;
    }

  } catch (e) {
    console.error('出错了：', e);
    const sp = screenshot('99-error');
    try { await page.screenshot({ path: sp, fullPage: true }); } catch {}
    await notifyTelegram({ ok: false, stage: '异常', msg: e?.message || String(e), screenshotPath: fs.existsSync(sp) ? sp : undefined });
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();

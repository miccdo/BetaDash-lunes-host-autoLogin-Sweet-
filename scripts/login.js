// scripts/login.js
import { chromium } from '@playwright/test';
import fs from 'fs';

const LOGIN_URL = 'https://betadash.lunes.host/login?next=/';

// Telegram 通知
async function notifyTelegram({ ok, stage, msg, screenshotPath }) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.log('[WARN] TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID 未设置，跳过通知');
      return;
    }

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

// 解决 Turnstile
async function solveTurnstile(page, apiKey) {
  console.log('检测到 Cloudflare 验证，开始寻找 sitekey...');

  // 1. 多通道尝试获取 sitekey
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

  // 2. 提交给 2Captcha
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

  // 3. 轮询获取 Token
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

  // 4. 全面注入 Token 并触发事件
  await page.evaluate((token) => {
    const setAndDispatch = (el) => {
      if (!el) return;
      el.value = token;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // 覆盖常规输入框与隐藏域
    document.querySelectorAll('[name="cf-turnstile-response"], [name="g-recaptcha-response"]').forEach(setAndDispatch);

    // 确保 DOM 中至少有一个容器保存变量
    let form = document.querySelector('form') || document.body;
    let cfInput = document.querySelector('input[name="cf-turnstile-response"]');
    if (!cfInput) {
      cfInput = document.createElement('input');
      cfInput.type = 'hidden';
      cfInput.name = 'cf-turnstile-response';
      form.appendChild(cfInput);
    }
    setAndDispatch(cfInput);

    // 尝试执行 Cloudflare 回调函数
    if (window.turnstile) {
      try {
        // 如果使用了 turnstile 对象的内部回调
        Object.keys(window).forEach(key => {
          if (key.startsWith('cf') || key.toLowerCase().includes('turnstile')) {
            if (typeof window[key] === 'function') window[key](token);
          }
        });
      } catch (e) {}
    }
  }, token);

  console.log('Token 已注入完成');
  await page.waitForTimeout(3000);
  return token;
}

async function main() {
  const username = envOrThrow('LUNES_USERNAME');
  const password = envOrThrow('LUNES_PASSWORD');
  const apiKey = envOrThrow('TWOCAPTCHA_API_KEY');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled' // 防指纹识别关键项
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });

  // 抹除 webdriver 特征
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const screenshot = (name) => `./${name}.png`;

  try {
    console.log('正在打开登录页面...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 延迟 3 秒给 Cloudflare 渲染时间
    await page.waitForTimeout(3000);

    // 检查 Turnstile
    const hasTurnstile = await page.locator('[data-sitekey]').count() > 0 ||
                         await page.locator('iframe[src*="turnstile"]').count() > 0 ||
                         await page.locator('text=/Verify you are human|security verification/i').count() > 0;

    if (hasTurnstile) {
      const sp = screenshot('01-before-captcha');
      await page.screenshot({ path: sp, fullPage: true });
      await notifyTelegram({ ok: false, stage: '检测到验证', msg: '开始调用 2Captcha', screenshotPath: sp });

      await solveTurnstile(page, apiKey);
    }

    // 填写账号密码
    console.log('开始填写账号密码...');
    const userInput = page.locator('input[name="username"], input[name="email"], input[type="email"]').first();
    const passInput = page.locator('input[name="password"], input[type="password"]').first();

    await userInput.waitFor({ state: 'visible', timeout: 20000 });
    await passInput.waitFor({ state: 'visible', timeout: 20000 });

    await userInput.fill(username);
    await passInput.fill(password);

    const loginBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login")').first();
    await loginBtn.waitFor({ state: 'visible', timeout: 10000 });

    const spBefore = screenshot('02-before-submit');
    await page.screenshot({ path: spBefore, fullPage: true });

    // 点击提交
    await loginBtn.click();

    // 等待页面跳转或网络加载完成
    await Promise.race([
      page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15000 }),
      page.waitForLoadState('networkidle', { timeout: 15000 })
    ]).catch(() => {});

    await page.waitForTimeout(5000);

    const spAfter = screenshot('03-after-submit');
    await page.screenshot({ path: spAfter, fullPage: true });

    const url = page.url();
    const success = !url.includes('/login') || await page.locator('text=/Dashboard|Logout|Servers|控制台/i').count() > 0;

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
    await context.close();
    await browser.close();
  }
}

await main();

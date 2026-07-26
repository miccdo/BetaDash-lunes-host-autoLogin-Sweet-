// scripts/login.js
import { chromium } from '@playwright/test';
import fs from 'fs';

const LOGIN_URL = 'https://betadash.lunes.host/login?next=/';

// Telegram 通知（可选）
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
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    });

    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const photoUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', `Lunes 自动操作截图（${stage}）`);
      form.append('photo', new Blob([fs.readFileSync(screenshotPath)]), 'screenshot.png');
      await fetch(photoUrl, { method: 'POST', body: form });
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

// 调用 2Captcha 解决 Turnstile
// 调用 2Captcha 解决 Turnstile（改进版）
async function solveTurnstile(page, apiKey) {
  console.log('检测到 Cloudflare 验证，开始调用 2Captcha...');

  // 获取 sitekey
  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    return el ? el.getAttribute('data-sitekey') : null;
  });

  if (!sitekey) {
    throw new Error('没有找到 Turnstile sitekey');
  }

  console.log('sitekey:', sitekey);

  // 提交到 2Captcha
  const createRes = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      key: apiKey,
      method: 'turnstile',
      sitekey: sitekey,
      pageurl: LOGIN_URL,
      json: '1'
    })
  });

  const createData = await createRes.json();
  if (createData.status !== 1) {
    throw new Error('2Captcha 提交失败: ' + JSON.stringify(createData));
  }

  const requestId = createData.request;
  console.log('2Captcha 任务ID:', requestId);

  // 轮询获取结果
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

  if (!token) {
    throw new Error('2Captcha 超时，没有拿到 token');
  }

  // ========== 改进的注入方式 ==========
  await page.evaluate((token) => {
    // 1. 设置所有可能的响应字段
    const selectors = [
      '[name="cf-turnstile-response"]',
      'input[name="cf-turnstile-response"]',
      'textarea[name="cf-turnstile-response"]',
      '#cf-turnstile-response'
    ];

    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.value = token;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    // 2. 如果页面有回调函数，尝试调用
    if (typeof window.turnstileCallback === 'function') {
      try { window.turnstileCallback(token); } catch (e) {}
    }

    // 3. 尝试触发 turnstile 的成功回调
    if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
      // 有些实现会检查这个
    }

    // 4. 强制创建隐藏字段（防止没有）
    let form = document.querySelector('form');
    if (form) {
      let hidden = form.querySelector('input[name="cf-turnstile-response"]');
      if (!hidden) {
        hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'cf-turnstile-response';
        form.appendChild(hidden);
      }
      hidden.value = token;
    }
  }, token);

  console.log('Token 已注入页面（改进版）');

  // 等待页面反应
  await page.waitForTimeout(4000);

  // 尝试点击验证区域（有时需要）
  try {
    const checkbox = page.locator('text=/Verify you are human|验证你是人类/i').first();
    if (await checkbox.count() > 0) {
      await checkbox.click({ timeout: 3000 }).catch(() => {});
    }
  } catch (e) {}

  await page.waitForTimeout(3000);
  return token;
}

async function main() {
  const username = envOrThrow('LUNES_USERNAME');
  const password = envOrThrow('LUNES_PASSWORD');
  const apiKey = envOrThrow('TWOCAPTCHA_API_KEY');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const screenshot = (name) => `./${name}.png`;

  try {
    console.log('正在打开登录页面...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 检查是否有人机验证
    const hasTurnstile = await page.locator('text=/Verify you are human|验证|security verification/i').count() > 0 ||
                         await page.locator('[data-sitekey]').count() > 0;

    if (hasTurnstile) {
      const sp = screenshot('01-before-captcha');
      await page.screenshot({ path: sp, fullPage: true });
      await notifyTelegram({ ok: false, stage: '检测到验证', msg: '开始调用 2Captcha', screenshotPath: sp });

      await solveTurnstile(page, apiKey);

      // 等待一下让页面处理 token
      await page.waitForTimeout(3000);
    }

    // 填写账号密码
    console.log('开始填写账号密码...');
    const userInput = page.locator('input[name="username"], input[type="email"], input[placeholder*="email" i], input[placeholder*="Email" i]').first();
    const passInput = page.locator('input[name="password"], input[type="password"]').first();

    await userInput.waitFor({ state: 'visible', timeout: 20000 });
    await passInput.waitFor({ state: 'visible', timeout: 20000 });

    await userInput.fill(username);
    await passInput.fill(password);

    const loginBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("登录")').first();
    await loginBtn.waitFor({ state: 'visible', timeout: 10000 });

    const spBefore = screenshot('02-before-submit');
    await page.screenshot({ path: spBefore, fullPage: true });

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
      loginBtn.click({ timeout: 10000 })
    ]);

    await page.waitForTimeout(5000);

    const spAfter = screenshot('03-after-submit');
    await page.screenshot({ path: spAfter, fullPage: true });

    const url = page.url();
    const success = !url.includes('/login') || await page.locator('text=/Dashboard|Logout|Sign out|Server|控制台|面板/i').count() > 0;

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

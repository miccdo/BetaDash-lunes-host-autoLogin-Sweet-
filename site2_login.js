const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const FormData = require('form-data');
puppeteer.use(StealthPlugin());

// 发送图片到 Telegram 的辅助函数
async function sendTelegramPhoto(botToken, chatId, photoBuffer, caption) {
  if (!botToken || !chatId) {
    console.log('⚠️ 未配置 Telegram 变量，跳过截图发送');
    return;
  }
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('photo', photoBuffer, { filename: 'screenshot.png' });

    await axios.post(`https://api.telegram.org/bot${botToken}/sendPhoto`, form, {
      headers: form.getHeaders(),
    });
    console.log('📱 Telegram 截图通知已发送！');
  } catch (err) {
    console.error('❌ 发送 Telegram 消息失败:', err.message);
  }
}

(async () => {
  const username = process.env.SITE_USERNAME;
  const password = process.env.SITE_PASSWORD;
  const tgToken = process.env.TG_BOT_TOKEN;
  const tgChatId = process.env.TG_CHAT_ID;

  console.log('🚀 开始执行 ctrl.lunes.host 每日保活登录...');

  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  // 设置视口大小以截取美观的全屏图
  await page.setViewport({ width: 1280, height: 800 });

  try {
    // 1. 打开登录页面
    await page.goto('https://ctrl.lunes.host/server/58d21414', { waitUntil: 'networkidle2' });

    // 2. 填写账号和密码
    await page.type('input[name="username"]', username);
    await page.type('input[name="password"]', password);

    // 3. 点击登录按钮并等待跳转
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    console.log('✅ 登录成功！正在截取登录后页面...');

    // 4. 截图并发送到 Telegram
    const screenshot = await page.screenshot({ fullPage: false });
    await sendTelegramPhoto(
      tgToken,
      tgChatId,
      screenshot,
      `✅ ctrl.lunes.host 每日保活登录成功！\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
    );

  } catch (error) {
    console.error('❌ 登录流程出现异常:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();

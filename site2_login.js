import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

// 使用原生 fetch 发送图片到 Telegram 的辅助函数 (无需 axios/form-data 依赖)
async function sendTelegramPhoto(botToken, chatId, photoBuffer, caption) {
  if (!botToken || !chatId) {
    console.log('⚠️ 未配置 Telegram 变量，跳过截图发送');
    return;
  }
  try {
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('caption', caption);
    
    // 将 Buffer 转换为 Blob
    const blob = new Blob([photoBuffer], { type: 'image/png' });
    formData.append('photo', blob, 'screenshot.png');

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      body: formData,
    });

    if (response.ok) {
      console.log('📱 Telegram 截图通知已发送！');
    } else {
      const errText = await response.text();
      console.error('❌ 发送 Telegram 消息失败:', errText);
    }
  } catch (err) {
    console.error('❌ 发送 Telegram 消息请求异常:', err.message);
  }
}

(async () => {
  // 从 GitHub Secrets 读取变量
  const username = process.env.SITE_USERNAME;
  const password = process.env.SITE_PASSWORD;
  const tgToken = process.env.TG_BOT_TOKEN;
  const tgChatId = process.env.TG_CHAT_ID;

  console.log('🔍 环境变量检查：');
  console.log(' - 用户名:', username ? '已读取' : '❌ 未读取');
  console.log(' - TG Token:', tgToken ? '已读取' : '❌ 未读取(请检查Secrets名称)');
  console.log(' - TG Chat ID:', tgChatId ? '已读取' : '❌ 未读取(请检查Secrets名称)');

  console.log('🚀 开始执行 Lunes Ctrl 登录保活...');

  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  // 设置视口大小以截取较清晰的图
  await page.setViewport({ width: 1440, height: 900 });

  try {
    // 1. 打开登录页面
    console.log('🔗 正在打开登录页...');
    await page.goto('https://ctrl.lunes.host/auth/login', { waitUntil: 'networkidle2' });

    // 2. 自动填入账号密码
    await page.type('input[name="username"]', username);
    await page.type('input[name="password"]', password);

    // 3. 点击登录按钮并等待跳转
    console.log('⏳ 正在提交登录...');
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    console.log('✅ 登录成功！正在跳转到特定服务器页...');

    // 4. 🔗 【新增步骤】强制跳转到目标服务器页面
    await page.goto('https://ctrl.lunes.host/server/58d21414', { waitUntil: 'networkidle2' });
    
    // 稍微等待一下，确保页面上的服务器状态（如 CPU/内存图表）加载出来
    console.log('⏳ 正在等待服务器状态加载...');
    await page.waitForTimeout(3000); 

    // 5. 截图服务器管理页（调整为全页截图，能看到更多信息）
    console.log('📸 正在截取服务器状态页...');
    const screenshot = await page.screenshot({ fullPage: true });

    // 6. 发送截图到 Telegram
    await sendTelegramPhoto(
      tgToken,
      tgChatId,
      screenshot,
      `✅ Lunes 服务器保活成功！\n📎 服务器 ID: 58d21414\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
    );

  } catch (error) {
    console.error('❌ 登录流程出现异常:', error.message);
    process.exit(1); // 抛出错误让 Actions 标记为失败
  } finally {
    // 始终关闭浏览器
    await browser.close();
  }
})();

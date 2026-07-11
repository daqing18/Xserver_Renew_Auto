const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ACC = process.env.ACC || process.env.EML;
const ACC_PWD = process.env.ACC_PWD || process.env.PWD;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_ID = process.env.TG_ID;
const PROXY_URL = process.env.PROXY_URL;

const LOGIN_URL = 'https://secure.xserver.ne.jp/xapanel/login/xmgame';
const STATUS_FILE = 'status.json';

function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveStatus(data) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
}

function getAccountStatus() {
  return loadStatus()[ACC] || {};
}

function gitCommitPush(commitMsg) {
  try {
    execSync('git config --global user.email "bot@xserver.renew" && git config --global user.name "XServer Bot"', { stdio: 'pipe' });
    execSync('git add status.json', { stdio: 'pipe' });
    execSync('git commit -m "' + commitMsg + '"', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('📤 status.json 已推送');
    return true;
  } catch (e) {
    console.log('⚠️ Git 推送失败（非 Git 环境或无远程）');
    return false;
  }
}

function getTodayStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function addDaysStr(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatSeconds(sec) {
  return Math.floor(sec / 3600) + '小时' + Math.floor((sec % 3600) / 60) + '分钟';
}

async function sendTG(statusIcon, statusText, extra, imagePath) {
  if (!TG_TOKEN || !TG_ID) return;
  extra = extra || '';
  imagePath = imagePath || null;
  try {
    var time = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    var text = 'XServer 延期提醒\n' + statusIcon + ' ' + statusText + '\n' + extra + '\n账号: ' + ACC + '\n时间: ' + time;
    if (imagePath && fs.existsSync(imagePath)) {
      var fileData = fs.readFileSync(imagePath);
      var fd = new FormData();
      fd.append('chat_id', TG_ID);
      fd.append('caption', text);
      fd.append('photo', new Blob([fileData], { type: 'image/png' }), path.basename(imagePath));
      var res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendPhoto', { method: 'POST', body: fd });
      if (res.ok) console.log('✅ TG 通知已发送');
      else console.log('⚠️ TG 发送失败:', res.status, await res.text());
    } else {
      var res2 = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_ID, text: text })
      });
      if (res2.ok) console.log('✅ TG 通知已发送');
      else console.log('⚠️ TG 发送失败:', res2.status, await res2.text());
    }
  } catch (e) { console.log('⚠️ TG 发送失败:', e.message); }
}

function checkScheduling() {
  const today = getTodayStr();
  const s = getAccountStatus();
  if (!s.nextCheckDate) { console.log('🆕 首次运行'); return; }
  if (process.env.GITHUB_EVENT_NAME !== 'schedule') { console.log('💻 本地模式'); return; }
  if (today < s.nextCheckDate) {
    var days = Math.ceil((new Date(s.nextCheckDate) - new Date(today)) / 86400000);
    console.log('⏳ 预约 ' + s.nextCheckDate + '，还剩 ' + days + ' 天，秒退');
    process.exit(0);
  }
  console.log('📅 到达预约日期 ' + today);
}

async function parseRemainingMinutes(page) {
  try {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    var text = await page.evaluate(function() {
      var el = document.querySelector('[class*="remain"], [class*="time"], [class*="period"]');
      if (el) return el.innerText;
      return document.body.innerText;
    });
    var m = text.match(/残り(\d+)時間(\d+)分/);
    if (m) { console.log('⏱️ 剩余时间: ' + m[1] + '小时' + m[2] + '分钟'); return parseInt(m[1]) * 60 + parseInt(m[2]); }
    m = text.match(/残り(\d+)時間/);
    if (m) { console.log('⏱️ 剩余时间: ' + m[1] + '小时'); return parseInt(m[1]) * 60; }
    m = text.match(/(\d+)時間(\d+)分/);
    if (m) { console.log('⏱️ 剩余时间: ' + m[1] + '小时' + m[2] + '分钟'); return parseInt(m[1]) * 60 + parseInt(m[2]); }
    console.log('⚠️ 未找到剩余时间');
    return null;
  } catch (e) { console.log('⚠️ 解析失败:', e.message); return null; }
}

function calcNextCheckDays(afterH) {
  // 距离进入续签窗口（<16h）还有多久，提前2h到达作为缓冲
  var hoursUntilWindow = afterH - 16 - 2;
  return Math.max(1, Math.floor(hoursUntilWindow / 24));
}

function updateNextCheckDate(daysLater, reason) {
  var next = addDaysStr(getTodayStr(), daysLater);
  var status = loadStatus();
  if (!status[ACC]) status[ACC] = {};
  status[ACC].nextCheckDate = next;
  saveStatus(status);
  console.log('📅 下次预约: ' + next + '（' + reason + '）');
  gitCommitPush('[Bot] ' + ACC + ' 下次检查 ' + next);
}

async function tryRenew(page, beforeMins) {
  try {
    console.log('🔄 滚动到页面底部...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await page.getByRole('link', { name: '期限を延長する' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByRole('link', { name: '期限を延長する' }).click();
    await page.waitForLoadState('load');
    await page.getByRole('button', { name: '確認画面に進む' }).click();
    await page.waitForLoadState('load');
    console.log('🖱️ 执行延期...');
    await page.getByRole('button', { name: '期限を延長する' }).click();
    await page.waitForLoadState('load');
    await page.screenshot({ path: '5_before_back.png' });
    console.log('✅ 延期成功，正在获取新的剩余时间...');
    await page.getByRole('link', { name: '戻る' }).click();
    await page.waitForLoadState('load');
    await page.screenshot({ path: 'success.png' });

    var afterMins = await parseRemainingMinutes(page);
    var beforeH = beforeMins ? (beforeMins / 60).toFixed(1) : '?';
    var afterH = afterMins ? (afterMins / 60).toFixed(1) : '?';
    var timeInfo = '续签前 ' + beforeH + 'h → 续签后 ' + afterH + 'h';
    console.log('⏱️ ' + timeInfo);

    var status = loadStatus();
    if (!status[ACC]) status[ACC] = {};
    status[ACC].lastSuccess = Date.now();
    saveStatus(status);

    if (afterMins !== null) {
      // 根据续签后实际剩余时间动态计算下次检查时机
      var afterHNum = afterMins / 60;
      var skipDays = calcNextCheckDays(afterHNum);
      updateNextCheckDate(skipDays, '续签成功，续签后' + afterHNum.toFixed(1) + 'h，' + skipDays + '天后检查');
      await sendTG('✅', '续签成功', timeInfo + '\n续签后' + afterHNum.toFixed(1) + 'h，下次检查' + skipDays + '天后', 'success.png');
    } else {
      // 续签后剩余时间解析失败，保守处理1天后再查
      updateNextCheckDate(1, '续签成功，剩余时间解析失败，保守1天后检查');
      await sendTG('✅', '续签成功', timeInfo + '\n剩余时间解析失败，保守1天后检查', 'success.png');
    }
  } catch (e) {
    console.log('⚠️ 未找到延期按钮');
    await page.screenshot({ path: 'skip.png' });
    var s = getAccountStatus();
    if (!s.lastSuccess) await sendTG('🕐', '等待中', '按钮未出现', 'skip.png');
    else await sendTG('⚠️', '跳过', '未到时间', 'skip.png');
  }
}

(async function main() {
  console.log('==================================================');
  console.log('XServer 自动延期 (叠加续签动态调度版)');
  console.log('==================================================');
  if (!ACC || !ACC_PWD) { console.log('❌ 未找到账号或密码'); process.exit(1); }
  checkScheduling();
  var launchOpts = { headless: true, channel: 'chrome' };
  if (PROXY_URL) launchOpts.proxy = { server: 'http://127.0.0.1:8080' };
  var browser = await chromium.launch(launchOpts);
  var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  var page = await context.newPage();
  try {
    if (PROXY_URL) {
      console.log('🌐 检查代理 IP...');
      try {
        await page.goto('https://api.ipify.org/?format=json', { timeout: 15000 });
        console.log('✅ IP: ' + JSON.parse(await page.textContent('body')).ip);
      } catch (e) { console.log('⚠️ IP 检查失败'); }
    }
    console.log('🌐 打开登录页面');
    await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 30000 });
    await page.screenshot({ path: '1_navigation.png' });
    console.log('📧 填写账号密码');
    await page.locator('#memberid').fill(ACC);
    await page.locator('#user_password').fill(ACC_PWD);
    await page.screenshot({ path: '1.5_filled.png' });
    console.log('🖱️ 提交登录');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
      page.locator('input[name="action_user_login"]').click()
    ]);
    await page.screenshot({ path: '2_after_login.png' });
    console.log('🚀 点击游戏管理');
    await page.getByRole('link', { name: 'ゲーム管理' }).click();
    await page.waitForLoadState('load');
    await page.screenshot({ path: '3_game_manage.png' });
    var totalMins = await parseRemainingMinutes(page);
    console.log('🚀 点击延期');
    await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();
    await page.screenshot({ path: '4_renew_page.png' });

    if (totalMins === null) {
      console.log('⚠️ 无法解析剩余时间，尝试直接续签');
      await tryRenew(page, null);
    } else {
      var h = totalMins / 60;

      if (h > 16) {
        // 探测模式：距离进入续签窗口（<16h）还有多久，提前2h到达
        var hoursUntilWindow = h - 16 - 2;
        var skipDays = Math.max(1, Math.floor(hoursUntilWindow / 24));
        console.log('🔭 探测模式: 剩余' + h.toFixed(1) + 'h，距续签窗口还有' + hoursUntilWindow.toFixed(1) + 'h，预约' + skipDays + '天后检查');
        await sendTG('🔭', '探测跳过', '剩余' + h.toFixed(1) + 'h，距窗口' + hoursUntilWindow.toFixed(1) + 'h，' + skipDays + '天后检查', '3_game_manage.png');
        updateNextCheckDate(skipDays, '探测模式，距窗口' + hoursUntilWindow.toFixed(1) + 'h');
      } else if (h > 12) {
        // 伏击模式：在续签窗口内（12h~16h），随机延迟0~2h后续签
        var maxDelaySec = 2 * 3600;
        var delay = Math.floor(Math.random() * maxDelaySec);
        console.log('🎯 伏击模式: 剩余' + h.toFixed(1) + 'h，随机延迟' + formatSeconds(delay) + '后续签');
        await sendTG('🎯', '伏击模式', '剩余' + h.toFixed(1) + 'h，' + formatSeconds(delay) + '后执行');
        await new Promise(function(r) { setTimeout(r, delay * 1000); });
        await tryRenew(page, totalMins);
      } else {
        // 紧急模式：剩余 ≤ 12h，立即续签
        console.log('🚨 紧急模式: 剩余' + h.toFixed(1) + 'h，立即执行');
        await tryRenew(page, totalMins);
      }
    }
  } catch (error) {
    console.log('❌ 流程失败: ' + error.message);
    await page.screenshot({ path: 'failure.png' });
    await sendTG('❌', '续签失败', error.message, 'failure.png');
  } finally {
    await context.close();
    await browser.close();
  }
})();

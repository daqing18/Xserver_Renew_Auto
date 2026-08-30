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

// ===== 抗 GitHub Actions 调度延迟配置 =====
// 自等待上限：距续期窗口(剩余<4h)的等待时间不超过这个值(小时)时，
// 脚本不再"预约退出"等 cron 再次触发，而是直接在本次任务内睡到窗口时间再续期。
// GitHub Actions 免费版单 job 最长运行约 6 小时（公共仓库 360 分钟上限）。
// 自等待实际睡眠时长 = 剩余h - TARGET_REMAIN_H，需控制在 job 余量内。
// 设 5h：睡眠 ≤5h + 登录/续期操作约 1h，接近但不超过 6h 上限。
// 若仓库是私有的且 workflow 里 timeout-minutes 设得更大，可再调大（如 6）。
const SELF_WAIT_MAX_H = 5;   // 可调：自等待最长时间(小时)
// 提前缓冲：cron 触发时刻若距预约时间还有不到 BUFFER_MIN 分钟，则不秒退，
// 直接继续检查（避免"预约14:03、cron 14:00 差3分钟就白等2小时"的问题）。
const EARLY_RUN_BUFFER_MIN = 45; // 可调：分钟
const AMBUSH_DELAY_SEC = 1800; // 伏击模式随机延迟上限(秒)，默认30分钟

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

function formatSeconds(sec) {
  if (sec < 3600) return Math.floor(sec / 60) + '分钟' + (sec % 60) + '秒';
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

// 修改为按小时/时间戳调度，适应12小时生命周期
function checkScheduling() {
  const now = Date.now();
  const s = getAccountStatus();
  if (!s.nextCheckTime) { console.log('🆕 首次运行或无旧定时状态，开始检查'); return; }
  if (process.env.GITHUB_EVENT_NAME !== 'schedule') { console.log('💻 本地/手动触发模式，忽略定时预约'); return; }

  var diffMs = now - s.nextCheckTime;
  if (diffMs < 0) {
    var hoursLeft = (-diffMs / 3600000).toFixed(1);
    var nextStr = new Date(s.nextCheckTime + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    // 提前缓冲：距离预约时间很近了（如 cron 14:00 触发、预约 14:03），
    // 此时秒退会白等一整轮 cron 间隔，直接继续执行更稳妥。
    var minutesLeft = -diffMs / 60000;
    if (minutesLeft <= EARLY_RUN_BUFFER_MIN) {
      console.log('📅 距预约 ' + nextStr + ' 仅剩 ' + minutesLeft.toFixed(0) + ' 分钟（< ' + EARLY_RUN_BUFFER_MIN + 'min），不秒退，直接执行检查');
      return;
    }
    console.log('⏳ 预约北京时间 ' + nextStr + '，还剩 ' + hoursLeft + ' 小时，秒退');
    process.exit(0);
  }
  console.log('📅 到达或超过预约时间，开始执行检查');
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

// 计算下一次检查需要等待的小时数
function calcNextCheckHours(afterH) {
  // 距离进入续签窗口（<4h）还有多久，提前0.5小时到达作为缓冲
  var hoursUntilWindow = afterH - 4 - 0.5;
  return Math.max(1, Math.floor(hoursUntilWindow));
}

function updateNextCheckTime(hoursLater, reason) {
  var nextTime = Date.now() + hoursLater * 3600000;
  var nextStr = new Date(nextTime + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  var status = loadStatus();
  if (!status[ACC]) status[ACC] = {};
  status[ACC].nextCheckTime = nextTime;
  status[ACC].nextCheckStr = nextStr; // 写入易读的北京时间字符串
  saveStatus(status);
  console.log('📅 下次检查: 北京时间 ' + nextStr + '（' + reason + '）');
  gitCommitPush('[Bot] ' + ACC + ' 下次检查 ' + nextStr);
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
      // 根据续签后实际剩余时间动态计算下次检查时机（按小时计算）
      var afterHNum = afterMins / 60;
      var skipHours = calcNextCheckHours(afterHNum);
      updateNextCheckTime(skipHours, '续签成功，续签后' + afterHNum.toFixed(1) + 'h，' + skipHours + '小时后检查');
      await sendTG('✅', '续签成功', timeInfo + '\n续签后' + afterHNum.toFixed(1) + 'h，下次检查' + skipHours + '小时后', 'success.png');
    } else {
      // 续签后剩余时间解析失败，保守处理6小时后再查（12小时生命周期的一半）
      updateNextCheckTime(6, '续签成功，剩余时间解析失败，保守6小时后检查');
      await sendTG('✅', '续签成功', timeInfo + '\n剩余时间解析失败，保守6小时后检查', 'success.png');
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
  console.log('XServer 自动延期 (自等待抗延迟版)');
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

      if (h > 4) {
        // ===== 探测模式：剩余 >4h，还不能续期 =====
        // 续期窗口：剩余时间 <4h 才允许续期（用户确认：≥4h 不能续，续一次 +12h）。
        // 目标：睡到剩余约 TARGET_REMAIN_H=3h（确保醒来时一定在窗口内 <4h），然后立即续期。
        // 剩余 ≤8.5h（距窗口≤4.5h）都会走自等待，本次任务内完成续期，不依赖 cron。
        var TARGET_REMAIN_H = 3;
        var waitMs = Math.round((h - TARGET_REMAIN_H) * 3600000);
        if (waitMs <= SELF_WAIT_MAX_H * 3600000) {
          // ===== 自等待模式（抗 GitHub 调度延迟）=====
          // 等待时间不长：直接在本次任务内睡到窗口时间，然后重新加载页面继续续期，
          // 不再依赖 GitHub Actions 下一次 cron 触发，彻底避免调度延迟导致的错过窗口。
          console.log('🕐 自等待模式: 剩余' + h.toFixed(1) + 'h，任务内等待' + formatSeconds(waitMs / 1000) + '后（剩余约' + TARGET_REMAIN_H + 'h，进入<4h窗口）立即续期，不依赖下次触发');
          await sendTG('🕐', '自等待', '剩余' + h.toFixed(1) + 'h，任务内等待' + formatSeconds(waitMs / 1000) + '后续期（抗调度延迟，本次任务内完成）', '3_game_manage.png');
          await new Promise(function(r) { setTimeout(r, waitMs); });
          // 等待结束，重新读取剩余时间并继续（此时应已在 <4h 窗口内）
          console.log('⏰ 等待结束，重新检查剩余时间...');
          await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 30000 });
          await page.waitForTimeout(2000);
          await page.locator('#memberid').fill(ACC);
          await page.locator('#user_password').fill(ACC_PWD);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
            page.locator('input[name="action_user_login"]').click()
          ]);
          await page.getByRole('link', { name: 'ゲーム管理' }).click();
          await page.waitForLoadState('load');
          totalMins = await parseRemainingMinutes(page);
          h = totalMins ? totalMins / 60 : 0;
          console.log('🚀 重新点击延期');
          await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();
          await page.waitForLoadState('load');
          if (h >= 4) {
            // 意外仍在4h及以上（理论不该发生，可能是页面解析异常），预约兜底
            var skipHours = calcNextCheckHours(h);
            console.log('🔭 仍剩余' + h.toFixed(1) + 'h（异常≥4h），预约' + skipHours + '小时后检查');
            updateNextCheckTime(skipHours, '自等待后仍剩余' + h.toFixed(1) + 'h');
          } else if (h > 3) {
            // 已在窗口内(3h~4h)，但为确保一次到位，不做随机延迟直接续
            console.log('🎯 窗口内: 剩余' + h.toFixed(1) + 'h，立即续期');
            await tryRenew(page, totalMins);
          } else {
            console.log('🚨 窗口内: 剩余' + h.toFixed(1) + 'h，立即续期');
            await tryRenew(page, totalMins);
          }
        } else {
          // 等待时间过长，无法在单次 job 内等待，退回"预约-退出"模式
          var skipHours = Math.max(1, Math.floor(h - 4));
          console.log('🔭 探测模式: 剩余' + h.toFixed(1) + 'h，距续期窗口还有' + (h - 4).toFixed(1) + 'h，超过自等待上限(' + SELF_WAIT_MAX_H + 'h)，预约' + skipHours + '小时后检查');
          await sendTG('🔭', '探测跳过', '剩余' + h.toFixed(1) + 'h，距窗口' + (h - 4).toFixed(1) + 'h，' + skipHours + '小时后检查', '3_game_manage.png');
          updateNextCheckTime(skipHours, '探测模式，距窗口' + (h - 4).toFixed(1) + 'h');
        }
      } else if (h > 3) {
        // 伏击模式：在续签窗口内（3h~4h），随机延迟0~30分钟后续签（缩短伏击时间）
        var maxDelaySec = AMBUSH_DELAY_SEC; // 30分钟
        var delay = Math.floor(Math.random() * maxDelaySec);
        console.log('🎯 伏击模式: 剩余' + h.toFixed(1) + 'h，随机延迟' + formatSeconds(delay) + '后续签');
        await sendTG('🎯', '伏击模式', '剩余' + h.toFixed(1) + 'h，' + formatSeconds(delay) + '后执行');
        await new Promise(function(r) { setTimeout(r, delay * 1000); });
        await tryRenew(page, totalMins);
      } else {
        // 紧急模式：剩余 ≤ 3h，立即续签（延长紧急模式范围）
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

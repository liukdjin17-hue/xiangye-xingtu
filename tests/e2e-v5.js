/* v5 专项：无登录直接进 → 首次引导 → 我的设置 → 小星星 → 备份迁移 → 手机尺寸 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL: fileURL } = require('url');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9346);
// 刻意不带任何参数：要测的就是"第一次打开直接能用"
const APP = process.env.APP_URL || fileURL(path.join(__dirname, '..', 'app', 'index.html')).href;
const SHOTS = path.join(__dirname, '..', '..', '测试截图');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const profile = path.join(os.tmpdir(), 'xyxt-e2e-v5-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=900,1200',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    APP
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJSON('http://127.0.0.1:' + PORT + '/json/list'); if (targets.length) break; } catch (e) {}
    await sleep(250);
  }
  if (!targets || !targets.length) { console.error('FAIL: 无法连接 Chrome'); process.exit(1); }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception || {}).description);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map(a => a.value || a.description).join(' '));
    }
  };

  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1500);

  const results = [];
  const evalIn = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  };
  // 只截可视区：引导/浮层都是 fixed，全页截图会把视口外的内容拍成"没被遮罩盖住"，看起来像 bug
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  };
  const reload = async (wait) => {
    await send('Page.reload', { ignoreCache: true });
    await sleep(wait || 1400);
  };

  try {
    /* ---------- 1. 打开即用，没有登录这一步 ---------- */
    const open = await evalIn(`(() => ({
      authScreen: !!document.getElementById('authScreen'),
      authing: document.body.classList.contains('authing'),
      authApi: typeof window.XYXT_AUTH,
      appVisible: getComputedStyle(document.getElementById('app')).display !== 'none',
      nick: (document.getElementById('userName') || {}).textContent || '',
      tabs: document.querySelectorAll('.tab').length,
      tour: !!document.getElementById('tourLayer') && !document.getElementById('tourLayer').hidden
    }))()`);
    check('打开直接进主界面（无登录页、无登录脚本）',
      !open.authScreen && !open.authing && open.authApi === 'undefined' && open.appVisible && open.nick === '同学' && open.tabs === 7,
      JSON.stringify(open));

    /* ---------- 2. 第一次进来自动播新手引导 ---------- */
    check('首次进入自动弹出新手引导（第 1 步）', open.tour, JSON.stringify(open));
    const t1 = await evalIn(`(() => {
      const card = document.querySelector('.tour-card');
      const hole = document.getElementById('tourHole');
      const r = hole ? hole.getBoundingClientRect() : null;
      return {
        text: card ? card.innerText.replace(/\\n+/g, ' ').slice(0, 60) : '',
        step: card ? (card.querySelector('.tour-k') || {}).textContent : '',
        holeW: r ? Math.round(r.width) : 0
      };
    })()`);
    check('引导第 1 步指向品牌区且有高亮框', /第\s*1\s*\//.test(t1.step || '') && t1.holeW > 40, JSON.stringify(t1));
    await shot('v5-tour');

    /* ---------- 3. 走完 9 步 → 记下 tourDone ---------- */
    const walked = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      let clicks = 0;
      for (let i = 0; i < 12; i++) {
        const layer = document.getElementById('tourLayer');
        if (!layer || layer.hidden) break;
        const next = layer.querySelector('[data-tour="next"]');
        if (!next) break;
        next.click();
        clicks++;
        await s(260);
      }
      await s(300);
      return {
        clicks,
        layerHidden: !document.getElementById('tourLayer') || document.getElementById('tourLayer').hidden,
        tourDone: window.XYXT_APP.state().tourDone
      };
    })()`);
    check('引导可走完 9 步并记住已完成', walked.clicks === 9 && walked.layerHidden && walked.tourDone, JSON.stringify(walked));

    /* ---------- 4. 刷新后不再重复弹 ---------- */
    await reload(1600);
    const noRepeat = await evalIn(`({
      tour: !!document.getElementById('tourLayer') && !document.getElementById('tourLayer').hidden,
      appVisible: getComputedStyle(document.getElementById('app')).display !== 'none'
    })`);
    check('刷新后不再自动弹引导，直接进主界面', !noRepeat.tour && noRepeat.appVisible, JSON.stringify(noRepeat));

    /* ---------- 5. 我的设置：分组齐全 ---------- */
    await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.getElementById('btnUser').click();
      await s(340);
      return true;
    })()`);
    await shot('v5-settings');
    const set1 = await evalIn(`(() => {
      const sheet = document.getElementById('sheet');
      const heads = [...sheet.querySelectorAll('.set-h')].map(h => h.textContent.trim());
      const txt = sheet.innerText;
      return {
        heads,
        stats: sheet.querySelectorAll('.set-stats > div').length,
        hasLogout: /退出登录|切换账号|注销账号|设置密码/.test(txt),
        hasBackup: !!sheet.querySelector('[data-act="export-backup"]') && !!sheet.querySelector('[data-act="import-backup"]'),
        nickname: (sheet.querySelector('[data-set="nick"] .set-val') || {}).textContent || ''
      };
    })()`);
    check('设置面板：个人/使用/数据/关于齐全，且没有登录相关项',
      JSON.stringify(set1.heads) === JSON.stringify(['个人', '使用', '数据', '关于']) && set1.stats === 4 &&
      !set1.hasLogout && set1.hasBackup, JSON.stringify(set1));

    /* ---------- 6. 改称呼 → 顶栏与数据一起变，刷新还在 ---------- */
    const nick = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('#sheet [data-set="nick"]').click();
      await s(280);
      const inp = document.getElementById('setNickIn');
      inp.value = '小满';
      document.querySelector('#sheet [data-act="set-nick-save"]').click();
      await s(400);
      return {
        chip: document.getElementById('userName').textContent,
        ava: document.getElementById('userAva').textContent,
        stored: window.XYXT_APP.state().profile.nick,
        sheetClosed: !document.getElementById('sheet').classList.contains('on')
      };
    })()`);
    await reload(1400);
    const nickAfter = await evalIn(`({
      chip: document.getElementById('userName').textContent,
      stored: window.XYXT_APP.state().profile.nick
    })`);
    check('改称呼后顶栏同步，刷新后仍保留',
      nick.chip === '小满' && nick.ava === '小' && nick.stored === '小满' && nick.sheetClosed &&
      nickAfter.chip === '小满' && nickAfter.stored === '小满',
      JSON.stringify({ nick, nickAfter }));

    /* ---------- 7. 隐私说明与使用条款可读 ---------- */
    const docs = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.getElementById('btnUser').click();
      await s(320);
      document.querySelector('#sheet [data-set="privacy"]').click();
      await s(300);
      const privacy = document.getElementById('sheet').innerText;
      document.querySelector('#sheet [data-act="close-sheet"]').click();
      await s(260);
      document.getElementById('btnUser').click();
      await s(320);
      document.querySelector('#sheet [data-set="user"]').click();
      await s(300);
      const terms = document.getElementById('sheet').innerText;
      document.querySelector('#sheet [data-act="close-sheet"]').click();
      await s(250);
      return {
        privacy: /数据不出这台设备/.test(privacy) && /清空本机数据/.test(privacy),
        terms: /不是测评诊断/.test(terms) && /招生简章/.test(terms)
      };
    })()`);
    check('隐私说明与使用条款能打开且内容到位', docs.privacy && docs.terms, JSON.stringify(docs));

    /* ---------- 8. 小星星：离线答"报告在哪导出"并带动作 ---------- */
    const star = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.getElementById('starFab').click();
      await s(400);
      const panel = document.getElementById('starPanel');
      const greet = (document.getElementById('starLog') || {}).innerText || '';
      window.XYXT_STAR.ask('报告在哪导出');
      await s(700);
      const msgs = [...document.querySelectorAll('#starLog .star-msg')];
      const last = msgs[msgs.length - 1];
      const btn = last && last.querySelector('[data-star-act]');
      return {
        open: !!panel && !panel.hidden,
        greet: /我是小星星/.test(greet),
        answer: last ? last.innerText.slice(0, 40) : '',
        hitReport: last ? /报告|导出/.test(last.innerText) : false,
        hasAct: !!btn,
        actLabel: btn ? btn.textContent.trim() : ''
      };
    })()`);
    await shot('v5-star');
    check('小星星能答出"报告在哪导出"并给可执行按钮',
      star.open && star.greet && star.hitReport && star.hasAct && /首页|报告/.test(star.actLabel), JSON.stringify(star));

    const starAct = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const btns = [...document.querySelectorAll('#starLog [data-star-act]')];
      btns[btns.length - 1].click();
      await s(500);
      return {
        closed: document.getElementById('starPanel').hidden,
        route: document.querySelector('.tab.active') ? document.querySelector('.tab.active').dataset.view : ''
      };
    })()`);
    check('点小星星的动作会真的跳转', starAct.closed && starAct.route === 'home', JSON.stringify(starAct));

    /* ---------- 9. 备份导出 → 篡改 → 导入恢复 ---------- */
    const backup = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      let captured = null;
      const origCreate = URL.createObjectURL;
      const origClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = b => { captured = b; return 'blob:test'; };
      HTMLAnchorElement.prototype.click = function () {};
      document.getElementById('btnUser').click();
      await s(320);
      document.querySelector('#sheet [data-act="export-backup"]').click();
      await s(400);
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
      const text = captured ? await captured.text() : '';
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return {
        isJson: !!json,
        nick: json && json.profile ? json.profile.nick : '',
        hasAnswers: json ? typeof json.answers === 'object' : false
      };
    })()`);
    check('导出备份是完整 JSON（含称呼与作答）', backup.isJson && backup.nick === '小满' && backup.hasAnswers, JSON.stringify(backup));

    const restore = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      // 先改成别的名字，模拟"数据被清掉/换了台机器"
      const st = window.XYXT_APP.state();
      st.profile.nick = '被改坏了';
      st.fav = [];
      window.XYXT_APP.save();
      await s(150);
      const payload = { v: 5, profile: { nick: '小满', grade: '高二', county: '信宜', subjects: ['生物'] },
        answers: { 0: 5, 1: 4 }, cursor: 2, testing: false, result: { code: 'CSI', order: ['C','S','I'], at: Date.now(), answered: 2, scores: {}, diff: 6, cons: { level: '中' } },
        history: [], tasksDone: [0], chat: [], starChat: [], fav: ['nurse'], compare: [], filter: {}, teacherAgg: null,
        hideVoiceNotice: true, tourDone: true, createdAt: Date.now() };
      const file = new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const inp = document.getElementById('backupFile');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      await s(700);
      const now = window.XYXT_APP.state();
      return { nick: now.profile.nick, fav: now.fav.length, tasks: now.tasksDone.length, chip: document.getElementById('userName').textContent };
    })()`);
    check('导入备份能把记录整份恢复', restore.nick === '小满' && restore.fav === 1 && restore.tasks === 1, JSON.stringify(restore));

    /* ---------- 10. 兼容 v4：旧账号数据自动接管 ---------- */
    const adopt = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      localStorage.clear();
      localStorage.setItem('xyxt.v3.u.olduser', JSON.stringify({
        v: 4, profile: { nick: '旧账号小美', grade: '高三', county: '', subjects: [] },
        answers: {}, fav: ['nurse', 'teacher'], tasksDone: [], chat: [], starChat: [], tourDone: true,
        createdAt: 1700000000000
      }));
      return true;
    })()`);
    await sleep(200);
    await reload(1500);
    const adopted = await evalIn(`({
      nick: window.XYXT_APP.state().profile.nick,
      fav: window.XYXT_APP.state().fav.length,
      tour: !!document.getElementById('tourLayer') && !document.getElementById('tourLayer').hidden
    })`);
    check('v4 账号里的旧记录会被接管，不当作丢失',
      adopt && adopted.nick === '旧账号小美' && adopted.fav === 2 && !adopted.tour, JSON.stringify(adopted));

    /* ---------- 11. 手机 390px：设置抽屉与小星星不溢出 ---------- */
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(500);
    const mobile = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.getElementById('btnUser').click();
      await s(320);
      const sheet = document.getElementById('sheet');
      const ok1 = sheet.scrollWidth <= window.innerWidth + 1;
      sheet.querySelector('[data-act="close-sheet"]').click();
      await s(260);
      document.getElementById('starFab').click();
      await s(400);
      const panel = document.getElementById('starPanel');
      const r = panel.getBoundingClientRect();
      const ok2 = r.width <= window.innerWidth + 1 && panel.scrollWidth <= panel.clientWidth + 1;
      const ok3 = panel.getBoundingClientRect().bottom <= window.innerHeight + 1;
      document.querySelector('[data-star="close"]').click();
      await s(250);
      return { ok1, ok2, ok3, page: document.documentElement.scrollWidth, vw: window.innerWidth, panelW: Math.round(r.width), panelH: Math.round(r.height) };
    })()`);
    check('手机 390px：设置抽屉与小星星都不横向溢出',
      mobile.ok1 && mobile.ok2 && mobile.ok3 && mobile.page <= mobile.vw, JSON.stringify(mobile));
    await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.getElementById('btnUser').click();
      await s(320);
      return true;
    })()`);
    await shot('v5-mobile-settings');
    await send('Emulation.clearDeviceMetricsOverride');

    /* ---------- 12. 无脚本错误 ---------- */
    check('无未捕获脚本错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

  } catch (e) {
    check('执行过程无异常', false, e.message);
  }

  const passed = results.filter(r => r.ok).length;
  console.log('\n' + passed + '/' + results.length + ' passed');
  fs.writeFileSync(path.join(SHOTS, 'e2e-v5-report.json'), JSON.stringify(results, null, 2));

  ws.close();
  chrome.kill();
  process.exit(passed === results.length ? 0 : 1);
})();

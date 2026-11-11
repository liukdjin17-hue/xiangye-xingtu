/* v6.2 专项：朗读统一温柔女声（pickVoice 挑声/避开男声/兜底不抛错）
   → 设置里「试听朗读声音」 → 页脚精简（留赛事署名、去「不用登录」） → 资源 ?v=8 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL: fileURL } = require('url');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9349);
const APP = process.env.APP_URL || (fileURL(path.join(__dirname, '..', 'app', 'index.html')).href + '?tour=0');
const TEACHER = fileURL(path.join(__dirname, '..', 'app', 'teacher.html')).href;
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

/* 新建一个 target，返回它的 webSocketDebuggerUrl。
   DevTools HTTP 端点是 PUT /json/new?{url}（url 直接当查询串），老版本 Chrome 用 GET。 */
function newTarget(url) {
  const tryMethod = method => new Promise(resolve => {
    const req = http.request('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const o = JSON.parse(d);
          resolve(o && o.webSocketDebuggerUrl ? o : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
  return tryMethod('PUT').then(o => o || tryMethod('GET'));
}

/* 一个 target 一条 WebSocket，包一层 evalIn/shot/check 需要的 send */
function attach(wsUrl, consoleErrors) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      const msgId = ++id;
      pending.set(msgId, { resolve: res, reject: rej });
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
    ws.onopen = () => resolve({ ws, send });
    ws.onerror = e => reject(new Error('WS 连接失败 ' + wsUrl));
  });
}

(async () => {
  const profile = path.join(os.tmpdir(), 'xyxt-e2e-v8-' + Date.now());
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
  const consoleErrors = [];
  const main = await attach(page.webSocketDebuggerUrl, consoleErrors);
  const send = main.send;

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1500);

  const results = [];
  const evalIn = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail: detail || '' });
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  };
  /* 把一段表达式包成「一定返回 {ok, error, value}」的形式，绝不因抛错中断整轮 */
  const safe = async (body) => {
    try {
      return await evalIn(`(() => { try { return { ok: true, value: (() => { ${body} })() }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; } })()`);
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  };

  try {
    /* ---------- 1. 导出面：pickVoice / speak / voiceIsWarm 都挂在 XYXT_APP 上 ---------- */
    const api = await evalIn(`(() => ({
      app: typeof window.XYXT_APP,
      pick: typeof window.XYXT_APP.pickVoice,
      speak: typeof window.XYXT_APP.speak,
      warm: typeof window.XYXT_APP.voiceIsWarm,
      version: window.XYXT_APP.version
    }))()`);
    check('XYXT_APP 导出 pickVoice / speak / voiceIsWarm，版本 6.2.0',
      api.pick === 'function' && api.speak === 'function' && api.warm === 'function' && api.version === '6.2.0',
      JSON.stringify(api));

    /* ---------- 2. 男声在前、女声在后：跳过男声选女声 ---------- */
    const skipMale = await safe(`
      const got = window.XYXT_APP.pickVoice([
        { name: 'Microsoft Yunxi', lang: 'zh-CN' },
        { name: 'Microsoft Xiaoxiao Online (Natural)', lang: 'zh-CN' }
      ]);
      return { name: got && got.name, warm: window.XYXT_APP.voiceIsWarm(got) };
    `);
    check('注入云希（男）+ 晓晓 → 跳过男声，返回 Xiaoxiao',
      skipMale.ok && /Xiaoxiao/i.test(String(skipMale.value.name || '')) && skipMale.value.warm === true,
      JSON.stringify(skipMale));

    /* ---------- 3. 慧慧 vs Google 普通话：优先系统里的中文女声 ---------- */
    const preferHuihui = await safe(`
      const got = window.XYXT_APP.pickVoice([
        { name: 'Microsoft Huihui Desktop', lang: 'zh-CN' },
        { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' }
      ]);
      return { name: got && got.name };
    `);
    check('注入慧慧 + Google 普通话 → 返回 Huihui',
      preferHuihui.ok && /Huihui/i.test(String(preferHuihui.value.name || '')),
      JSON.stringify(preferHuihui));

    /* ---------- 4. 只有男声：仍返回该对象，不 null、不抛错 ---------- */
    const onlyMale = await safe(`
      const got = window.XYXT_APP.pickVoice([{ name: 'Microsoft Kangkang', lang: 'zh-CN' }]);
      return { name: got && got.name, warm: window.XYXT_APP.voiceIsWarm(got), nil: got === null };
    `);
    check('只有康康（男声）时仍返回该音色，并标记为不柔和',
      onlyMale.ok && onlyMale.value.nil === false && onlyMale.value.warm === false &&
      /Kangkang/i.test(String(onlyMale.value.name || '')),
      JSON.stringify(onlyMale));

    /* ---------- 5. 全是英文 voice：返回 null，不抛错 ---------- */
    const noZh = await safe(`
      const got = window.XYXT_APP.pickVoice([{ name: 'Alex', lang: 'en-US' }]);
      return { nil: got === null, name: got && got.name };
    `);
    check('只有英文音色（Alex / en-US）→ 返回 null，不抛错',
      noZh.ok && noZh.value.nil === true, JSON.stringify(noZh));

    /* ---------- 6. 空列表：不抛错 ---------- */
    const empty = await safe(`
      const got = window.XYXT_APP.pickVoice([]);
      return { type: typeof got, nil: got === null };
    `);
    check('传入空数组不抛异常（返回 null 或全局音色）',
      empty.ok && (empty.value.nil === true || empty.value.type === 'object'), JSON.stringify(empty));

    /* ---------- 7. speak() 在 headless 下不抛异常 ---------- */
    const spoken = await safe(`
      window.XYXT_APP.speak('测试一下朗读');
      return 'ok';
    `);
    check('speak("测试一下朗读") 不抛异常（无声环境只断言不报错）',
      spoken.ok && spoken.value === 'ok', JSON.stringify(spoken));

    /* ---------- 8. 首页页脚：留赛事署名，去掉「不用登录」 ---------- */
    const foot = await evalIn(`(() => {
      const f = document.querySelector('footer.foot');
      const t = f ? f.innerText.replace(/\\s+/g, ' ').trim() : '';
      return { text: t, hasCup: /联通杯/.test(t), hasNoLogin: /不用登录/.test(t), hasTeam: /拾光职引/.test(t), dots: f ? f.querySelectorAll('.dot').length : -1 };
    })()`);
    check('首页页脚含「联通杯」与「拾光职引」，不含「不用登录」',
      foot.hasCup && foot.hasTeam && !foot.hasNoLogin && foot.dots === 0,
      JSON.stringify(foot));
    await evalIn(`(() => { window.scrollTo(0, document.documentElement.scrollHeight); return true; })()`);
    await sleep(400);
    await shot('v8-footer');

    /* ---------- 9. 设置 →「使用」里有「试听朗读声音」，点一下能出声不炸、出 toast ---------- */
    const vt = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      window.scrollTo(0, 0);
      window.XYXT_APP.openSettings();
      await s(450);
      const row = document.querySelector('[data-act="voice-test"]');
      const sec = row ? row.closest('.set-sec') : null;
      const head = sec ? (sec.querySelector('.set-h') || {}).textContent : '';
      const val = row ? (row.querySelector('.set-val') || {}).textContent : '';
      const label = row ? (row.querySelector('span') || {}).textContent : '';
      const note = sec ? (sec.querySelector('.set-note') || {}).textContent : '';
      if (row) row.click();
      await s(500);
      const t = document.getElementById('toast');
      return {
        row: !!row, head: (head || '').trim(), label: (label || '').trim(),
        val: (val || '').trim(), note: /中文女声/.test(note || ''),
        toast: t ? t.textContent.trim() : '', sheetOpen: document.body.classList.contains('sheeting'),
        stillThere: !!document.querySelector('[data-act="voice-test"]')
      };
    })()`);
    check('设置「使用」分组里有「试听朗读声音」，说明写了中文女声',
      vt.row && vt.head === '使用' && vt.label === '试听朗读声音' && /温柔女声/.test(vt.val) && vt.note,
      JSON.stringify(vt));
    check('点「试听朗读声音」：面板不重绘、不关闭，并弹出 toast',
      vt.toast.length > 0 && vt.sheetOpen && vt.stillThere,
      JSON.stringify({ toast: vt.toast, sheetOpen: vt.sheetOpen, stillThere: vt.stillThere }));
    await shot('v8-settings-voice');
    await evalIn(`(() => { const b = document.querySelector('[data-act="close-sheet"]'); if (b) b.click(); return true; })()`);
    await sleep(350);

    /* ---------- 10. 8 处 ?v=8 资源都挂上且没有 404 ---------- */
    const res = await evalIn(`(() => {
      const urls = [...document.querySelectorAll('script[src],link[rel=stylesheet]')].map(e => e.src || e.href);
      const notV8 = urls.filter(u => !/\\?v=8/.test(u));
      const perf = performance.getEntriesByType('resource') || [];
      const failed = perf.filter(r => typeof r.responseStatus === 'number' && r.responseStatus >= 400).map(r => r.name);
      return {
        count: urls.length, notV8, failed,
        globals: [typeof window.XYXT, typeof window.XYXT_APP, typeof window.XYXT_STAR, typeof window.XYXT_TOUR].join(','),
        sheets: document.styleSheets.length
      };
    })()`);
    check('首页 5 处资源都带 ?v=8，无 404，四个全局对象都在',
      res.count === 5 && res.notV8.length === 0 && res.failed.length === 0 &&
      res.globals === 'object,object,object,object' && res.sheets >= 1,
      JSON.stringify(res));

    /* ---------- 11. 教师端页脚同样只留赛事署名 ---------- */
    let teacherTarget = await newTarget(TEACHER);
    if (!teacherTarget) {
      /* 兜底：让浏览器进程直接建一个 target，再从列表里找回来 */
      try { await send('Target.createTarget', { url: TEACHER }); } catch (e) { /* 忽略 */ }
      for (let i = 0; i < 20 && !teacherTarget; i++) {
        await sleep(300);
        const list = await getJSON('http://127.0.0.1:' + PORT + '/json/list');
        teacherTarget = (list || []).find(t => t.type === 'page' && /teacher\.html/.test(t.url || ''));
      }
    }
    if (teacherTarget && teacherTarget.webSocketDebuggerUrl) {
      try {
        const t2 = await attach(teacherTarget.webSocketDebuggerUrl, consoleErrors);
        await t2.send('Runtime.enable');
        await sleep(1800);
        const r = await t2.send('Runtime.evaluate', {
          expression: `(() => {
            const f = document.querySelector('footer.foot');
            const t = f ? f.innerText.replace(/\\s+/g, ' ').trim() : '';
            const urls = [...document.querySelectorAll('script[src],link[rel=stylesheet]')].map(e => e.src || e.href);
            const priv = document.body.innerText.replace(/\\s+/g, ' ');
            return {
              text: t, hasCup: /联通杯/.test(t), hasNoLogin: /不用登录/.test(t), hasTeam: /拾光职引/.test(t),
              notV8: urls.filter(u => !/\\?v=8/.test(u)).length, count: urls.length,
              privacy: /本机/.test(priv)
            };
          })()`,
          returnByValue: true
        });
        const tv = r.result.value || {};
        check('教师端页脚含「联通杯」「拾光职引」，不含「不用登录」，3 处资源 ?v=8',
          tv.hasCup === true && tv.hasTeam === true && tv.hasNoLogin === false && tv.notV8 === 0 && tv.count === 3 && tv.privacy === true,
          JSON.stringify(tv));
      } catch (e) {
        check('教师端页脚含「联通杯」「拾光职引」，不含「不用登录」，3 处资源 ?v=8', false, e.message);
      }
    } else {
      check('教师端页脚含「联通杯」「拾光职引」，不含「不用登录」，3 处资源 ?v=8', false, '无法打开教师端 target');
    }

    /* ---------- 12. 390×844 下页脚与设置面板都不横向溢出 ---------- */
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(700);
    const mobile1 = await evalIn(`(() => {
      const f = document.querySelector('footer.foot');
      const r = f ? f.getBoundingClientRect() : null;
      return { scrollW: document.documentElement.scrollWidth, vw: window.innerWidth, right: r ? Math.round(r.right) : 0, inner: f ? f.scrollWidth <= f.clientWidth + 1 : false };
    })()`);
    const mobile2 = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      window.XYXT_APP.openSettings();
      await s(500);
      const sh = document.getElementById('sheet');
      return {
        scrollW: document.documentElement.scrollWidth, vw: window.innerWidth,
        inner: sh ? sh.scrollWidth <= sh.clientWidth + 1 : false,
        right: sh ? Math.round(sh.getBoundingClientRect().right) : 0
      };
    })()`);
    await shot('v8-mobile');
    await evalIn(`(() => { const b = document.querySelector('[data-act="close-sheet"]'); if (b) b.click(); return true; })()`);
    check('390px：首页页脚与设置面板都不横向溢出',
      mobile1.scrollW <= mobile1.vw + 1 && mobile1.right <= mobile1.vw + 1 && mobile1.inner &&
      mobile2.scrollW <= mobile2.vw + 1 && mobile2.right <= mobile2.vw + 1 && mobile2.inner,
      JSON.stringify({ mobile1, mobile2 }));
    await send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);

    /* ---------- 13. 源码层自查：没有残留 v7 版本号 ---------- */
    const root = path.join(__dirname, '..', 'app');
    const appJs = fs.readFileSync(path.join(root, 'assets', 'app.js'), 'utf8');
    const idxHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const tchHtml = fs.readFileSync(path.join(root, 'teacher.html'), 'utf8');
    const swJs = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
    const v7left = (idxHtml.match(/\?v=7/g) || []).length + (tchHtml.match(/\?v=7/g) || []).length;
    const v8num = (idxHtml.match(/\?v=8/g) || []).length + (tchHtml.match(/\?v=8/g) || []).length;
    check('源码无 ?v=7（共 8 处 ?v=8）、无 xyxt-v7，APP_VERSION 为 6.2.0',
      v7left === 0 && v8num === 8 && !/xyxt-v7/.test(swJs) && /xyxt-v8/.test(swJs) && /APP_VERSION = '6\.2\.0'/.test(appJs),
      JSON.stringify({ v7left, v8num, cache: (swJs.match(/CACHE = '[^']+'/) || [''])[0], version: (appJs.match(/APP_VERSION = '[^']+'/) || [''])[0] }));

    /* ---------- 14. 无未捕获脚本错误 ---------- */
    check('无未捕获脚本错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

  } catch (e) {
    check('执行过程无异常', false, e.message);
  }

  const passed = results.filter(r => r.ok).length;
  console.log('\n' + passed + '/' + results.length + ' passed');
  fs.writeFileSync(path.join(SHOTS, 'e2e-v8-report.json'), JSON.stringify(results, null, 2));

  main.ws.close();
  chrome.kill();
  process.exit(passed === results.length ? 0 : 1);
})();

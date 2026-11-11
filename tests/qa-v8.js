/* qa-v8.js · QA 独立复验：v6.1 → v6.2 增量（朗读统一温柔女声 / 页脚精简）
 *
 * 与 e2e-v8.js 的关键差异：工程只验「pickVoice() 的返回值」，
 * 这里劫持 window.SpeechSynthesisUtterance（Proxy 包原构造）+ speechSynthesis.speak，
 * 抓真正送进语音引擎的 utterance，逐个朗读入口断言 rate/pitch/lang/voice.name/text。
 *
 * 用例编号对应验收表 1—15：
 *   A1        utterance 参数（5 个朗读入口逐个抓）
 *   A2        真机音色表 + 实际选中音色
 *   A3        退化：只有男声 / 空列表 / 全英文
 *   A4        voices 未加载的竞态（首句风险）
 *   A5        设置「试听朗读声音」
 *   B6/B7     首页 / 教师端页脚
 *   B8        「不用登录 / 记录只存」残留逐处定位
 *   B9        报告页脚 / 导出报告 / 关于「出品」未被误删
 *   C10       由外部脚本跑（本文件不重复）
 *   C11       ?v=8 无 404 + SW 缓存升级路径（xyxt-v7 → 只剩 xyxt-v8）
 *   C12       390×844 无横向溢出
 *   C13       无未捕获脚本错误
 *   C14       交付 14 文件 MD5 全等 + 交付 teacher.html file:// 可用
 *   C15       整轮 0 外部网络请求
 *
 * 跑法：node tests/qa-v8.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL: fileURL } = require('url');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9353);
const SRC = path.join(__dirname, '..', 'app');
const DEL = path.join(__dirname, '..', '..', '交付', '乡野星图-桌面版', 'App');
const SHOTS = path.join(__dirname, '..', '..', '测试截图');
const APP = fileURL(path.join(SRC, 'index.html')).href + '?tour=0';
const TEACHER = fileURL(path.join(SRC, 'teacher.html')).href;
const DEL_TEACHER = fileURL(path.join(DEL, 'teacher.html')).href;
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
let group = '';
const check = (id, name, ok, detail) => {
  results.push({ id, group, name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + id + ' | ' + name + ' | ' + String(detail == null ? '' : detail).slice(0, 420));
};

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/* ---------- 本地静态服务（只给 SW 升级路径用例用） ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
function startServer(root) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent((req.url || '/').split('?')[0]);
      if (u === '/seed.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>seed</title><body>seed</body>');
        return;
      }
      const p = path.join(root, u === '/' ? 'index.html' : u.replace(/^\/+/, ''));
      if (p.indexOf(root) !== 0 || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
      res.end(fs.readFileSync(p));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* ---------- CDP ---------- */
function newTarget(url) {
  const tryMethod = method => new Promise(resolve => {
    const req = http.request('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { const o = JSON.parse(d); resolve(o && o.webSocketDebuggerUrl ? o : null); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
  return tryMethod('PUT').then(o => o || tryMethod('GET'));
}

function attach(wsUrl, ctx) {
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
        ctx.errors.push('EXC ' + (m.params.exceptionDetails.text || '') + ' ' + ((m.params.exceptionDetails.exception || {}).description || ''));
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        ctx.errors.push('CONSOLE ' + m.params.args.map(a => a.value || a.description).join(' '));
      } else if (m.method === 'Network.requestWillBeSent') {
        ctx.reqs.push(m.params.request.url);
      } else if (m.method === 'Network.responseReceived') {
        ctx.statuses.push({ url: m.params.response.url, status: m.params.response.status });
      } else if (m.method === 'Network.loadingFailed') {
        ctx.fails.push(m.params.errorText + ' ' + (m.params.blockedReason || ''));
      }
    };
    ws.onopen = () => resolve({ ws, send });
    ws.onerror = () => reject(new Error('WS 连接失败 ' + wsUrl));
  });
}

/* ---------- 页面内注入：劫持 utterance + speak ---------- */
const HOOK = `(() => {
  if (!window.__ttsLog) window.__ttsLog = [];
  if (!window.__utLog) window.__utLog = [];
  window.__ttsLog.length = 0;
  window.__utLog.length = 0;
  if (!window.__speakHooked) {
    const ss = window.speechSynthesis;
    const origSpeak = ss.speak.bind(ss);
    ss.speak = function (u) {
      const rec = {
        text: String(u.text == null ? '' : u.text),
        rate: u.rate, pitch: u.pitch, lang: u.lang,
        voiceName: u.voice ? u.voice.name : null,
        voiceLang: u.voice ? u.voice.lang : null,
        isUtter: false, ctor: (u && u.constructor && u.constructor.name) || ''
      };
      try { rec.isUtter = u instanceof window.SpeechSynthesisUtterance; } catch (e) { rec.isUtter = 'err'; }
      window.__ttsLog.push(rec);
      try { return origSpeak(u); } catch (e) { rec.speakErr = String((e && e.message) || e); }
    };
    window.__speakHooked = true;
  }
  if (!window.__utterHooked && typeof window.SpeechSynthesisUtterance === 'function') {
    const Orig = window.SpeechSynthesisUtterance;
    window.SpeechSynthesisUtterance = new Proxy(Orig, {
      construct(t, args, nt) {
        const u = Reflect.construct(t, args, nt);
        window.__utLog.push({ raw: String(args[0] == null ? '' : args[0]).slice(0, 80), real: u instanceof Orig });
        return u;
      }
    });
    window.__utterHooked = true;
  }
  if (!window.__origGetVoices) window.__origGetVoices = window.speechSynthesis.getVoices.bind(window.speechSynthesis);
  window.__ttsReset = function () { window.__ttsLog.length = 0; window.__utLog.length = 0; };
  return {
    speakHooked: window.__speakHooked, utterHooked: window.__utterHooked,
    voices: (window.speechSynthesis.getVoices() || []).length,
    uttType: typeof window.SpeechSynthesisUtterance
  };
})()`;

/* 断言一条 utterance 记录：温柔女声（pitch 1.06）*/
const MALE_RE_SRC = 'Kangkang|Yunxi|Yunjian|Yunyang|Yunhao|Yunye|Yunjie|male|男';
function judge(rec, wantPitch) {
  const maleRe = new RegExp(MALE_RE_SRC, 'i');
  const rateOk = typeof rec.rate === 'number' && Math.abs(rec.rate - 0.92) < 0.02;
  const langOk = rec.lang === 'zh-CN';
  const pitchOk = typeof rec.pitch === 'number' && Math.abs(rec.pitch - wantPitch) < 0.02;
  const voicePresent = !!rec.voiceName;
  const maleOk = voicePresent ? !maleRe.test(rec.voiceName) : wantPitch === 1.14;
  const textOk = !!String(rec.text || '').trim() && !/[*#>_`]/.test(String(rec.text || ''));
  return {
    rateOk, langOk, pitchOk, maleOk, textOk, voicePresent,
    all: rateOk && langOk && pitchOk && maleOk && textOk && rec.isUtter === true
  };
}

(async () => {
  const profile = path.join(os.tmpdir(), 'xyxt-qa-v8-' + Date.now());
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
  const ctx = { errors: [], reqs: [], statuses: [], fails: [] };
  const page = targets.find(t => t.type === 'page');
  const main = await attach(page.webSocketDebuggerUrl, ctx);
  const send = main.send;

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await sleep(1700);

  const evalIn = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  /* 所有页面内代码统一包在 async IIFE + try/catch 里，绝不让一条断言炸掉整轮 */
  const run = async body => {
    try {
      return await evalIn(`(async () => { try { ${body} } catch (e) { return { __err: String((e && e.message) || e) }; } })()`);
    } catch (e) {
      return { __err: String((e && e.message) || e) };
    }
  };

  try {
    /* ================= 0. 劫持与预热 ================= */
    group = 'A 朗读参数';
    const hook = await run(`return ${HOOK};`);
    check('A0', '成功劫持 SpeechSynthesisUtterance（Proxy 保留原构造）与 speechSynthesis.speak',
      !hook.__err && hook.speakHooked === true && hook.utterHooked === true && hook.uttType === 'function',
      JSON.stringify(hook));

    /* 等音色列表就绪（Chrome/Edge 的 voices 是异步装载的） */
    let warmed = null;
    for (let i = 0; i < 20; i++) {
      warmed = await run(`const v = window.XYXT_APP.pickVoice(); return { name: v ? v.name : null, n: (window.speechSynthesis.getVoices() || []).length };`);
      if (warmed && warmed.name) break;
      await sleep(250);
    }

    /* ================= A2 真机音色表 ================= */
    const vt = await run(`
      const all = window.speechSynthesis.getVoices() || [];
      const zh = all.filter(v => /^zh/i.test(v.lang || ''));
      const picked = window.XYXT_APP.pickVoice();
      return {
        total: all.length,
        zh: zh.map(v => v.name + ' | ' + v.lang + ' | local=' + v.localService),
        other: all.filter(v => !/^zh/i.test(v.lang || '')).map(v => v.name + ' | ' + v.lang).slice(0, 8),
        picked: picked ? picked.name : null,
        pickedLang: picked ? picked.lang : null,
        warm: window.XYXT_APP.voiceIsWarm(picked),
        isMale: new RegExp('${MALE_RE_SRC}', 'i').test(picked ? picked.name : '')
      };
    `);
    check('A2', '真机音色表已采集，pickVoice() 选中的是中文女声（不是 Microsoft Kangkang）',
      !vt.__err && vt.picked && vt.warm === true && vt.isMale === false,
      JSON.stringify(vt));

    /* ================= A1 逐个入口抓 utterance ================= */
    const entryDefs = [
      {
        key: 'A1-1', label: '测评页 🔊 听题',
        body: `
          const s = ms => new Promise(r => setTimeout(r, ms));
          const st = window.XYXT_APP.state();
          st.testing = true; st.cursor = 0; st.result = null; st.autoRead = false;
          window.XYXT_APP.save(); window.XYXT_APP.go('test');
          await s(400);
          window.__ttsReset();
          const btn = document.querySelector('[data-act="read-q"]');
          if (!btn) return { none: true, view: (document.getElementById('view') || {}).innerText ? 'x' : '' };
          btn.click(); await s(350);
          return { none: false, log: window.__ttsLog.slice(), ut: window.__utLog.slice(), n: document.querySelectorAll('[data-act="read-q"]').length };`
      },
      {
        key: 'A1-2', label: '自动朗读（勾 #autoRead 后切题）',
        body: `
          const s = ms => new Promise(r => setTimeout(r, ms));
          const st = window.XYXT_APP.state();
          st.testing = true; st.result = null;
          window.XYXT_APP.save(); window.XYXT_APP.go('test');
          await s(350);
          const cb = document.getElementById('autoRead');
          if (!cb) return { none: true };
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          await s(350);
          window.__ttsReset();
          const cur0 = window.XYXT_APP.state().cursor;
          const b = document.querySelectorAll('#scale button');
          if (!b.length) return { none: true, why: 'no scale' };
          b[2].click();          /* 作答 → 进下一题，autoRead 触发朗读新题 */
          await s(600);
          const cur1 = window.XYXT_APP.state().cursor;
          return { none: false, advanced: cur1 !== cur0, cur0, cur1, log: window.__ttsLog.slice(), ut: window.__utLog.slice() };`
      },
      {
        key: 'A1-3', label: '结果页「朗读结果」',
        body: `
          const s = ms => new Promise(r => setTimeout(r, ms));
          const st = window.XYXT_APP.state();
          st.answers = {}; st.autoRead = false;
          window.XYXT.ITEMS.forEach(it => { st.answers[it.id] = 3; });
          st.testing = false;
          st.result = window.XYXT_APP.computeResult();
          window.XYXT_APP.save(); window.XYXT_APP.go('test');
          await s(450);
          window.__ttsReset();
          const btn = document.querySelector('[data-act="read-result"]');
          if (!btn) return { none: true };
          btn.click(); await s(350);
          return { none: false, code: window.XYXT_APP.state().result.code, log: window.__ttsLog.slice(), ut: window.__utLog.slice() };`
      },
      {
        key: 'A1-4', label: '职业详情「🔊 朗读」',
        body: `
          const s = ms => new Promise(r => setTimeout(r, ms));
          const id = window.XYXT.CAREERS[0].id;
          window.XYXT_APP.openCareer(id);
          await s(450);
          window.__ttsReset();
          const btn = document.querySelector('[data-act="read-career"]');
          if (!btn) return { none: true };
          btn.click(); await s(350);
          const log = window.__ttsLog.slice(), ut = window.__utLog.slice();
          const close = document.querySelector('[data-act="close-sheet"]');
          if (close) close.click();
          await s(250);
          return { none: false, id, log, ut };`
      },
      {
        key: 'A1-5', label: '小星星回答的朗读按钮（read-last）',
        body: `
          const s = ms => new Promise(r => setTimeout(r, ms));
          const st = window.XYXT_APP.state();
          st.chat = [{ role: 'ai', text: '护理在县城的岗位主要在县医院、乡镇卫生院和养老机构。', careerId: null }];
          window.XYXT_APP.save(); window.XYXT_APP.go('ask');
          await s(450);
          /* 先查 UI 里到底有没有这个按钮 */
          const uiBtns = document.querySelectorAll('[data-act="read-last"]').length;
          window.__ttsReset();
          /* 没有 UI 入口就用一个临时按钮走同一条事件委托（证明处理器本身是好的） */
          const probe = document.createElement('button');
          probe.setAttribute('data-act', 'read-last');
          probe.style.display = 'none';
          document.body.appendChild(probe);
          probe.click();
          await s(350);
          probe.remove();
          return { none: false, uiBtns, log: window.__ttsLog.slice(), ut: window.__utLog.slice() };`
      }
    ];

    for (const e of entryDefs) {
      const r = await run(e.body);
      const log = (r && r.log) || [];
      const last = log[log.length - 1];
      const j = last ? judge(last, 1.06) : { all: false, why: 'no utterance captured' };
      check(e.key, e.label + ' → 送进引擎的 utterance 是温柔女声（rate .92 / pitch 1.06 / zh-CN / 非男声 / 纯文本）',
        !r.__err && !r.none && log.length >= 1 && j.all === true,
        JSON.stringify({ err: r.__err, none: r.none, n: log.length, last, judge: j, extra: r.uiBtns !== undefined ? { uiBtns: r.uiBtns } : undefined, advanced: r.advanced }));
    }
    /* A1-5 附带发现：UI 里没有「朗读回答」按钮 */
    const a15 = (await run(`
      const s = ms => new Promise(r => setTimeout(r, ms));
      const st = window.XYXT_APP.state();
      st.chat = [{ role: 'ai', text: '护理在县城的岗位主要在县医院。' }];
      window.XYXT_APP.save(); window.XYXT_APP.go('ask'); await s(400);
      const ui = document.querySelectorAll('[data-act="read-last"]').length;
      const acts = new Set();
      ['home','test','map','compare','ask','task','science'].forEach(v => {
        window.XYXT_APP.go(v);
        document.querySelectorAll('[data-act]').forEach(x => acts.add(x.getAttribute('data-act')));
      });
      return { ui, hasReadLastInUI: ui > 0, acts: [...acts].filter(a => /^read-/.test(a)) };
    `));
    check('A1-5b', '副作用发现：ask 页没有「朗读回答」按钮（read-last 处理器存在但无 UI 入口）',
      !a15.__err && a15.hasReadLastInUI === false,
      JSON.stringify(a15));

    /* ================= A3 退化路径 ================= */
    const maleOnly = await run(`
      const all = window.__origGetVoices();
      const male = all.filter(v => /kangkang/i.test(v.name));
      const ss = window.speechSynthesis;
      ss.getVoices = () => male;
      ss.dispatchEvent(new Event('voiceschanged'));
      await new Promise(r => setTimeout(r, 200));
      const got = window.XYXT_APP.pickVoice();
      const warm = window.XYXT_APP.voiceIsWarm(got);
      window.__ttsReset();
      window.XYXT_APP.speak('只有男声时的兜底测试');
      await new Promise(r => setTimeout(r, 250));
      const rec = window.__ttsLog[window.__ttsLog.length - 1];
      ss.getVoices = window.__origGetVoices;
      ss.dispatchEvent(new Event('voiceschanged'));
      await new Promise(r => setTimeout(r, 200));
      return { maleCount: male.length, picked: got ? got.name : null, warm, rec, judge: rec ? null : 'none' };
    `);
    const maleJudge = maleOnly.rec ? judge(maleOnly.rec, 1.14) : { all: false };
    check('A3a', '注入「只有男声」列表 → 返回该对象、voiceIsWarm=false、pitch 退到 1.14（不是 1.06）',
      !maleOnly.__err && maleOnly.maleCount >= 1 && maleOnly.picked && maleOnly.warm === false &&
      maleOnly.rec && maleJudge.rateOk && maleJudge.langOk && maleJudge.pitchOk &&
      maleOnly.rec.voiceName === maleOnly.picked && maleOnly.rec.isUtter === true,
      JSON.stringify(maleOnly));

    const emptyVoices = await run(`
      const ss = window.speechSynthesis;
      ss.getVoices = () => [];
      ss.dispatchEvent(new Event('voiceschanged'));
      await new Promise(r => setTimeout(r, 200));
      const got = window.XYXT_APP.pickVoice();
      let threw = null;
      window.__ttsReset();
      try { window.XYXT_APP.speak('空列表兜底'); } catch (e) { threw = String((e && e.message) || e); }
      await new Promise(r => setTimeout(r, 250));
      const rec = window.__ttsLog[window.__ttsLog.length - 1];
      ss.getVoices = window.__origGetVoices;
      ss.dispatchEvent(new Event('voiceschanged'));
      await new Promise(r => setTimeout(r, 200));
      return { picked: got === null ? null : got.name, threw, rec };
    `);
    const emptyJudge = emptyVoices.rec ? judge(emptyVoices.rec, 1.14) : { all: false };
    check('A3b', '注入空音色列表 → pickVoice 返回 null、speak 不抛错、pitch 1.14、lang 仍 zh-CN',
      !emptyVoices.__err && emptyVoices.picked === null && emptyVoices.threw === null &&
      emptyVoices.rec && emptyJudge.langOk && emptyJudge.pitchOk && emptyVoices.rec.voiceName === null,
      JSON.stringify(emptyVoices));

    /* 全英文设备：全局池里没有 zh 音色，且候选列表全是 en-US */
    const enOnly = await run(`
      const ss = window.speechSynthesis;
      ss.getVoices = () => [];
      ss.dispatchEvent(new Event('voiceschanged'));
      await new Promise(r => setTimeout(r, 200));
      const got = window.XYXT_APP.pickVoice([{ name: 'Microsoft Alex', lang: 'en-US' }, { name: 'Google US English', lang: 'en-US' }]);
      let threw = null;
      window.__ttsReset();
      try { window.XYXT_APP.speak('全英文音色兜底'); } catch (e) { threw = String((e && e.message) || e); }
      await new Promise(r => setTimeout(r, 250));
      const rec = window.__ttsLog[window.__ttsLog.length - 1];
      ss.getVoices = window.__origGetVoices;
      ss.dispatchEvent(new Event('voiceschanged'));
      await new Promise(r => setTimeout(r, 200));
      return { picked: got === null ? null : got.name, threw, rec };
    `);
    const enJudge = enOnly.rec ? judge(enOnly.rec, 1.14) : { all: false };
    check('A3c', '全英文设备（无 zh 音色 + 候选全 en-US）→ pickVoice 返回 null、不抛错、pitch 1.14、不崩',
      !enOnly.__err && enOnly.picked === null && enOnly.threw === null && enOnly.rec &&
      enJudge.langOk && enJudge.pitchOk && enOnly.rec.voiceName === null,
      JSON.stringify({ picked: enOnly.picked, threw: enOnly.threw, rate: enOnly.rec && enOnly.rec.rate, pitch: enOnly.rec && enOnly.rec.pitch, voice: enOnly.rec && enOnly.rec.voiceName, judge: enJudge }));

    /* ================= A4 竞态：voices 未加载 ================= */
    const race = await run(`
      const ss = window.speechSynthesis;
      ss.getVoices = () => [];
      ss.dispatchEvent(new Event('voiceschanged'));
      await new Promise(r => setTimeout(r, 150));
      /* 模拟「首屏立刻朗读」：此时 voices 池是空的 */
      const before = window.XYXT_APP.pickVoice();
      let threw = null;
      window.__ttsReset();
      try { window.XYXT_APP.speak('首句竞态'); } catch (e) { threw = String((e && e.message) || e); }
      await new Promise(r => setTimeout(r, 250));
      const rec = window.__ttsLog[window.__ttsLog.length - 1];
      /* 音色回填后能否自愈 */
      ss.getVoices = window.__origGetVoices;
      ss.dispatchEvent(new Event('voiceschanged'));
      await new Promise(r => setTimeout(r, 250));
      const after = window.XYXT_APP.pickVoice();
      return {
        before: before === null ? null : before.name, threw, rec,
        healed: after ? after.name : null,
        hasListener: true
      };
    `);
    check('A4', 'voices 未加载时 speak 不抛错、lang 仍 zh-CN；音色回填后能自愈选中女声',
      !race.__err && race.before === null && race.threw === null && race.rec && race.rec.lang === 'zh-CN' &&
      race.healed && !new RegExp(MALE_RE_SRC, 'i').test(race.healed),
      JSON.stringify(race));

    /* ================= A5 「试听朗读声音」================= */
    const vtest = await run(`
      const s = ms => new Promise(r => setTimeout(r, ms));
      window.scrollTo(0, 0);
      window.XYXT_APP.openSettings();
      await s(500);
      const row = document.querySelector('[data-act="voice-test"]');
      if (!row) return { none: true };
      const sec = row.closest('.set-sec');
      const val = row.querySelector('.set-val');
      const note = sec ? sec.querySelector('.set-note') : null;
      const sheetBefore = document.getElementById('sheet');
      const sheetHadOn = sheetBefore && sheetBefore.classList.contains('on');
      window.__ttsReset();
      row.click();
      await s(600);
      const sh = document.getElementById('sheet');
      const toast = document.getElementById('toast');
      return {
        none: false,
        label: (row.querySelector('span') || {}).textContent,
        val: val ? val.textContent.trim() : '',
        note: note ? note.textContent.trim() : '',
        head: (sec.querySelector('.set-h') || {}).textContent,
        sheetHadOn, sheetStillOn: sh ? sh.classList.contains('on') : false,
        rowStillThere: !!document.querySelector('[data-act="voice-test"]'),
        toast: toast ? toast.textContent.trim() : '',
        toastShown: toast ? getComputedStyle(toast).opacity !== '0' : false,
        log: window.__ttsLog.slice(), ut: window.__utLog.slice()
      };
    `);
    const vLast = (vtest.log || []).slice(-1)[0];
    const vJudge = vLast ? judge(vLast, 1.06) : { all: false };
    check('A5', '「试听朗读声音」行存在、.set-val 是温柔女声、点击真的送出 utterance、有 toast、面板不重绘不关闭',
      !vtest.__err && !vtest.none && vtest.label === '试听朗读声音' && /温柔女声/.test(vtest.val) &&
      vtest.head === '使用' && /中文女声/.test(vtest.note) &&
      (vtest.log || []).length >= 1 && vJudge.all === true &&
      vtest.sheetHadOn === true && vtest.sheetStillOn === true && vtest.rowStillThere === true && vtest.toast.length > 0,
      JSON.stringify(vtest));
    await shot('qa-v8-voice-test');
    await run(`const b = document.querySelector('[data-act="close-sheet"]'); if (b) b.click(); return 1;`);
    await sleep(320);

    /* ================= B6 首页页脚 ================= */
    group = 'B 页脚与文案';
    const foot = await run(`
      window.XYXT_APP.go('home');
      await new Promise(r => setTimeout(r, 400));
      const f = document.querySelector('footer.foot');
      if (!f) return { none: true };
      const t = f.innerText.replace(/\\s+/g, ' ').trim();
      const cs = getComputedStyle(f);
      const rects = f.getClientRects().length;
      const span = f.querySelector('span');
      const lines = span ? Math.round(span.getBoundingClientRect().height / parseFloat(cs.lineHeight || 15)) : -1;
      return {
        none: false, text: t, spans: f.children.length, dots: f.querySelectorAll('.dot').length,
        hasCup: /联通杯/.test(t), hasTeam: /拾光职引/.test(t),
        hasNoLogin: /不用登录/.test(t), hasLocalOnly: /记录只存|只存在这台设备|留在这台设备/.test(t),
        hasSep: /·/.test(t), rects, footH: Math.round(f.getBoundingClientRect().height),
        spanH: span ? Math.round(span.getBoundingClientRect().height) : -1,
        lineH: parseFloat(cs.lineHeight || 0), wrap: cs.flexWrap,
        tabs: document.querySelectorAll('.tabs .tab').length >= 7
      };
    `);
    check('B6', '首页 footer 单行、含「联通杯」「拾光职引」、无「不用登录」、无 .dot 分隔符',
      !foot.__err && !foot.none && foot.hasCup && foot.hasTeam && !foot.hasNoLogin && !foot.hasLocalOnly &&
      foot.dots === 0 && foot.rects === 1 && foot.spans === 1 && foot.spanH <= (foot.lineH + 2) && foot.hasSep,
      JSON.stringify(foot));
    await run(`window.scrollTo(0, document.documentElement.scrollHeight); return 1;`);
    await sleep(350);
    await shot('qa-v8-footer-home');

    /* ================= B7 教师端页脚（源码 + 交付副本） ================= */
    const teacherCheck = async (url, tag) => {
      let t = await newTarget(url);
      if (!t) {
        try { await send('Target.createTarget', { url }); } catch (e) {}
        for (let i = 0; i < 20 && !t; i++) {
          await sleep(300);
          const list = await getJSON('http://127.0.0.1:' + PORT + '/json/list');
          t = (list || []).find(x => x.type === 'page' && new RegExp(tag === 'del' ? '交付' : '\\\\app\\\\teacher', 'i').test(decodeURIComponent(x.url || '')));
        }
      }
      if (!t || !t.webSocketDebuggerUrl) return { fail: '无法打开 target' };
      const tc = { errors: [], reqs: [], statuses: [], fails: [] };
      const at = await attach(t.webSocketDebuggerUrl, tc);
      await at.send('Runtime.enable');
      await at.send('Page.enable');
      await sleep(2000);
      const r = await at.send('Runtime.evaluate', {
        expression: `(() => {
          const f = document.querySelector('footer.foot');
          const t = f ? f.innerText.replace(/\\s+/g, ' ').trim() : '';
          const urls = [...document.querySelectorAll('script[src],link[rel=stylesheet]')].map(e => e.src || e.href);
          const span = f ? f.querySelector('span') : null;
          const cs = f ? getComputedStyle(f) : {};
          return {
            text: t, hasCup: /联通杯/.test(t), hasTeam: /拾光职引/.test(t),
            hasNoLogin: /不用登录/.test(t), dots: f ? f.querySelectorAll('.dot').length : -1,
            rects: f ? f.getClientRects().length : -1, spans: f ? f.children.length : -1,
            spanH: span ? Math.round(span.getBoundingClientRect().height) : -1,
            lineH: parseFloat(cs.lineHeight || 0),
            resCount: urls.length, notV8: urls.filter(u => !/\\?v=8/.test(u)),
            input: !!document.getElementById('aggIn'),
            sheets: document.styleSheets.length,
            bg: getComputedStyle(document.body).backgroundColor,
            vw: window.innerWidth, sw: document.documentElement.scrollWidth
          };
        })()`, returnByValue: true
      });
      const v = r.result.value || {};
      v.errors = tc.errors.slice(0, 3);
      v.delivered = /^file:\/\/\/.*交付/.test(decodeURIComponent(url)) || tag === 'del';
      return v;
    };
    const tSrc = await teacherCheck(TEACHER, 'src');
    check('B7a', '教师端（源码）footer 同样单行、含「联通杯」「拾光职引」、无「不用登录」、无 .dot',
      !tSrc.fail && tSrc.hasCup && tSrc.hasTeam && !tSrc.hasNoLogin && tSrc.dots === 0 &&
      tSrc.rects === 1 && tSrc.spans === 1 && tSrc.spanH <= tSrc.lineH + 2 && tSrc.resCount === 3 && tSrc.notV8.length === 0,
      JSON.stringify(tSrc));

    /* ================= B8 「不用登录 / 记录只存」残留定位 ================= */
    const scan = await run(`
      const s = ms => new Promise(r => setTimeout(r, ms));
      const RE = /不用登录|记录只存|记录只存在这台设备|只存在这台设备|记录留在这台设备/g;
      const hit = txt => { const m = String(txt || '').match(RE); return m ? m : []; };
      const out = [];
      const views = ['home','test','map','compare','ask','task','science'];
      for (const v of views) {
        window.XYXT_APP.go(v);
        await s(260);
        const foot = document.querySelector('footer.foot');
        const view = document.getElementById('view');
        const firstCard = view ? view.querySelector('.card, .hero, section') : null;
        out.push({ where: 'view:' + v, foot: hit(foot && foot.innerText).length, body: hit(view && view.innerText).length,
                   first: hit(firstCard && firstCard.innerText).length });
      }
      /* 报告页眉 */
      const stt = window.XYXT_APP.state();
      if (stt.result) {
        window.XYXT_APP.go('home'); await s(320);
        const rep = document.getElementById('report');
        out.push({ where: 'report', foot: 0, body: hit(rep && rep.innerText).length, first: 0 });
      }
      /* 新手引导：走完全部步骤，扫 #tourCard（注意 .sheet 关闭后是 translate 出屏、innerText 仍有残留，不能拿它当依据） */
      try {
        const before = !!document.getElementById('tourLayer');
        window.XYXT_APP.startTour(); await s(700);
        const steps = [];
        for (let i = 0; i < 12; i++) {
          const card = document.getElementById('tourCard');
          if (!card) break;
          const layer = document.getElementById('tourLayer');
          const onScreen = layer && !layer.hidden;
          steps.push({ i, onScreen, text: (card.innerText || '').replace(/\\s+/g, ' ').slice(0, 160), hits: hit(card.innerText).length });
          const next = card.querySelector('[data-tour="next"]');
          const done = card.querySelector('[data-tour="done"]');
          if (done) { done.click(); await s(260); break; }
          if (!next) break;
          next.click(); await s(320);
        }
        out.push({ where: 'tour', foot: 0, body: steps.reduce((a, x) => a + x.hits, 0), first: 0,
                   steps: steps.length, onScreen: steps.filter(x => x.onScreen).length, hadLayer: before,
                   sample: steps.map(x => x.text).slice(0, 3) });
        const sk = document.querySelector('[data-tour="skip"], [data-tour="done"]');
        if (sk) sk.click();
        await s(300);
        const lay = document.getElementById('tourLayer');
        out.push({ where: 'tour-closed', foot: 0, body: lay && !lay.hidden ? hit(lay.innerText).length : 0, first: 0 });
      } catch (e) { out.push({ where: 'tour', err: String((e && e.message) || e) }); }
      /* 各个设置面板 */
      const sheets = [['setmain', null], ['setabout', 'about'], ['setprivacy', 'privacy'], ['setuser', 'user'], ['setstar', 'star']];
      for (const [name, k] of sheets) {
        window.XYXT_APP.openSettings(k || undefined);
        await s(420);
        const sh = document.getElementById('sheet');
        out.push({ where: name, foot: 0, body: hit(sh && sh.innerText).length, first: 0,
                   head: sh ? (sh.querySelector('h2, .eyebrow') || {}).textContent : '' });
        const cb = document.querySelector('[data-act="close-sheet"]');
        if (cb) cb.click();
        await s(260);
      }
      return { list: out };
    `);
    const scanList = (scan && scan.list) || [];
    const bad = scanList.filter(x => x.foot > 0 || x.first > 0 || ((x.where === 'tour' || x.where === 'report') && x.body > 0));
    check('B8', '「不用登录 / 记录只存」不残留在页脚、首屏主视觉、新手引导、报告页眉（仅允许设置/关于/manifest）',
      !scan.__err && bad.length === 0,
      JSON.stringify({ bad, all: scanList.map(x => x.where + '=' + (x.body || 0)) }));

    /* ================= B9 报告页脚 / 导出报告 / 关于「出品」 ================= */
    const reportBits = await run(`
      const s = ms => new Promise(r => setTimeout(r, ms));
      const st = window.XYXT_APP.state();
      st.answers = {}; window.XYXT.ITEMS.forEach(it => { st.answers[it.id] = 4; });
      st.testing = false; st.result = window.XYXT_APP.computeResult();
      window.XYXT_APP.save(); window.XYXT_APP.go('home'); await s(500);
      const rep = document.getElementById('report');
      const repText = rep ? rep.innerText.replace(/\\s+/g, ' ') : '';
      /* 拦截导出：抓 Blob */
      const blobs = [];
      if (!window.__blobHooked) {
        const oc = URL.createObjectURL.bind(URL);
        window.__origCreateObjectURL = oc;
        URL.createObjectURL = function (b) { try { blobs.push(b); } catch (e) {} window.__blobs = blobs; return oc(b); };
        window.__blobHooked = true;
      }
      window.__blobs = blobs;
      const btn = document.querySelector('[data-act="export-report"]');
      if (btn) btn.click();
      await s(700);
      let html = '';
      const lastBlob = (window.__blobs || []).slice(-1)[0];
      if (lastBlob) html = await lastBlob.text();
      if (window.__origCreateObjectURL) URL.createObjectURL = window.__origCreateObjectURL;
      window.__blobHooked = false;
      /* 关于 → 出品 */
      window.XYXT_APP.openSettings('about'); await s(500);
      const sh = document.getElementById('sheet');
      let chupin = '';
      if (sh) {
        [...sh.querySelectorAll('.dl .item')].forEach(it => {
          const k = (it.querySelector('.k') || {}).textContent || '';
          if (/出品/.test(k)) chupin = (it.querySelector('.v') || {}).textContent || '';
        });
      }
      const cb = document.querySelector('[data-act="close-sheet"]'); if (cb) cb.click();
      await s(250);
      return {
        reportHasCup: /联通杯/.test(repText), reportHasTeam: /拾光职引/.test(repText),
        reportHasNoLogin: /不用登录/.test(repText),
        repTextTail: repText.slice(-120),
        exportLen: html.length,
        exportHasCup: /联通杯/.test(html), exportHasTeam: /拾光职引/.test(html),
        exportFoot: (html.match(/<p class="foot">([^<]*)<\\/p>/) || [])[1] || '',
        chupin, chupinHasCup: /联通杯/.test(chupin), chupinHasTeam: /拾光职引/.test(chupin)
      };
    `);
    check('B9', '报告页脚 / 导出报告 / 关于「出品」仍带赛事署名与队伍名（未被页脚精简误删）',
      !reportBits.__err && reportBits.reportHasCup && reportBits.reportHasTeam && !reportBits.reportHasNoLogin &&
      reportBits.exportLen > 800 && reportBits.exportHasCup && reportBits.exportHasTeam &&
      reportBits.chupinHasCup && reportBits.chupinHasTeam,
      JSON.stringify(reportBits));
    await shot('qa-v8-report-foot');

    /* ================= C11 ?v=8 / SW 升级路径 ================= */
    group = 'C 回归';
    const v8 = await run(`
      const urls = [...document.querySelectorAll('script[src],link[rel=stylesheet]')].map(e => e.src || e.href);
      const perf = performance.getEntriesByType('resource') || [];
      const bad = perf.filter(r => typeof r.responseStatus === 'number' && r.responseStatus >= 400).map(r => r.name);
      /* file:// 下没有 resource timing、cssRules 也读不到，所以改用「样式确实生效」来证明 CSS 没 404 */
      const cs = getComputedStyle(document.body);
      const top = document.querySelector('.topbar');
      const tcs = top ? getComputedStyle(top) : {};
      return {
        count: urls.length, notV8: urls.filter(u => !/\\?v=8/.test(u)),
        perfN: perf.length, bad,
        urls,
        globals: [typeof window.XYXT, typeof window.XYXT_APP, typeof window.XYXT_STAR, typeof window.XYXT_TOUR].join(','),
        sheets: document.styleSheets.length,
        bodyBg: cs.backgroundColor,
        bodyFont: cs.fontFamily.slice(0, 40),
        topSticky: tcs.position || '',
        cssApplied: cs.backgroundColor === 'rgb(251, 247, 239)' || /-apple-system|PingFang|Microsoft YaHei|system-ui/i.test(cs.fontFamily)
      };
    `);
    check('C11a', '首页 5 处资源都带 ?v=8、无 404（file:// 下以「样式与脚本确实生效」为证）、四个全局对象都在',
      !v8.__err && v8.count === 5 && v8.notV8.length === 0 && v8.bad.length === 0 &&
      v8.globals === 'object,object,object,object' && v8.sheets >= 1 && v8.cssApplied === true &&
      v8.topSticky !== '',
      JSON.stringify(v8));

    /* SW：老用户已缓存 xyxt-v7，新版激活后只应剩 xyxt-v8 */
    const { srv, port } = await startServer(SRC);
    const BASE = 'http://127.0.0.1:' + port;
    let swOut = { fail: '未执行' };
    let swTarget = await newTarget(BASE + '/seed.html');
    if (swTarget && swTarget.webSocketDebuggerUrl) {
      const sc = { errors: [], reqs: [], statuses: [], fails: [] };
      const at = await attach(swTarget.webSocketDebuggerUrl, sc);
      await at.send('Runtime.enable');
      await at.send('Page.enable');
      await at.send('Network.enable');
      await sleep(900);
      const seeded = await at.send('Runtime.evaluate', {
        expression: `(async () => {
          const c = await caches.open('xyxt-v7');
          await c.put('/old-bust.js', new Response('old code v7', { headers: { 'Content-Type': 'text/javascript' } }));
          return { keys: await caches.keys() };
        })()`, awaitPromise: true, returnByValue: true
      });
      await at.send('Page.navigate', { url: BASE + '/index.html?tour=0' });
      await sleep(4200);
      const r = await at.send('Runtime.evaluate', {
        expression: `(async () => {
          const keys = await caches.keys();
          const reg = await navigator.serviceWorker.getRegistration();
          const v8 = await caches.open('xyxt-v8').catch(() => null);
          const v8keys = v8 ? (await v8.keys()).map(x => x.url.replace(location.origin, '')) : [];
          return {
            keys, hasV8: keys.indexOf('xyxt-v8') >= 0, hasV7: keys.indexOf('xyxt-v7') >= 0,
            swActive: !!(reg && (reg.active || reg.installing || reg.waiting)),
            controller: !!navigator.serviceWorker.controller,
            v8Assets: v8keys.length,
            v8HasAppJs: v8keys.some(u => /assets\\/app\\.js$/.test(u)),
            appVersion: window.XYXT_APP ? window.XYXT_APP.version : null
          };
        })()`, awaitPromise: true, returnByValue: true
      });
      const sv = r.result.value || {};
      swOut = Object.assign({}, sv, { seeded: (seeded.result || {}).value, httpFails: sc.fails.slice(0, 3),
        http404: sc.statuses.filter(x => x.status >= 400).map(x => x.status + ' ' + x.url).slice(0, 5),
        errors: sc.errors.slice(0, 3) });
      try { at.ws.close(); } catch (e) {}
    }
    srv.close();
    check('C11b', 'SW 缓存名 xyxt-v8；老用户已缓存 xyxt-v7 时，新 SW 激活后旧缓存被清掉（caches.keys() 只剩 xyxt-v8）',
      swOut.fail === undefined && swOut.hasV8 === true && swOut.hasV7 === false &&
      swOut.swActive === true && swOut.v8Assets >= 10 && swOut.v8HasAppJs === true &&
      swOut.seeded && swOut.seeded.keys && swOut.seeded.keys.indexOf('xyxt-v7') >= 0 &&
      (swOut.http404 || []).length === 0,
      JSON.stringify(swOut));

    /* ================= C12 390×844 ================= */
    await run(`window.XYXT_APP.go('home'); return 1;`);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(700);
    const m1 = await run(`
      const f = document.querySelector('footer.foot');
      const r = f ? f.getBoundingClientRect() : null;
      return {
        sw: document.documentElement.scrollWidth, vw: window.innerWidth,
        right: r ? Math.round(r.right) : 0,
        footInner: f ? f.scrollWidth <= f.clientWidth + 1 : false,
        footH: r ? Math.round(r.height) : 0
      };
    `);
    const m2 = await run(`
      const s = ms => new Promise(r2 => setTimeout(r2, ms));
      window.XYXT_APP.openSettings();
      await s(600);
      const sh = document.getElementById('sheet');
      const row = document.querySelector('[data-act="voice-test"]');
      const note = row ? row.closest('.set-sec').querySelector('.set-note') : null;
      return {
        sw: document.documentElement.scrollWidth, vw: window.innerWidth,
        sheetInner: sh ? sh.scrollWidth <= sh.clientWidth + 1 : false,
        right: sh ? Math.round(sh.getBoundingClientRect().right) : 0,
        rowOk: !!row, rowRight: row ? Math.round(row.getBoundingClientRect().right) : 0,
        rowWidth: row ? Math.round(row.getBoundingClientRect().width) : 0,
        noteOk: !!note, noteH: note ? Math.round(note.getBoundingClientRect().height) : 0,
        noteOverflow: note ? note.scrollWidth <= note.clientWidth + 1 : false
      };
    `);
    await shot('qa-v8-mobile-settings');
    await run(`const b = document.querySelector('[data-act="close-sheet"]'); if (b) b.click(); return 1;`);
    await sleep(250);
    await send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);

    /* 教师端 390 */
    let m3 = { skip: true };
    if (tSrc && !tSrc.fail) {
      /* 复用源码教师端 target（重新开一个更简单） */
      const tt = await newTarget(TEACHER);
      if (tt && tt.webSocketDebuggerUrl) {
        const tc2 = { errors: [], reqs: [], statuses: [], fails: [] };
        const at2 = await attach(tt.webSocketDebuggerUrl, tc2);
        await at2.send('Runtime.enable');
        await at2.send('Page.enable');
        await sleep(1800);
        await at2.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await sleep(600);
        const rr = await at2.send('Runtime.evaluate', {
          expression: `(() => {
            const f = document.querySelector('footer.foot');
            const r = f ? f.getBoundingClientRect() : null;
            return { sw: document.documentElement.scrollWidth, vw: window.innerWidth, right: r ? Math.round(r.right) : 0,
                     footInner: f ? f.scrollWidth <= f.clientWidth + 1 : false, footH: r ? Math.round(r.height) : 0 };
          })()`, returnByValue: true
        });
        m3 = rr.result.value || {};
        const s2 = await at2.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(SHOTS, 'qa-v8-mobile-teacher.png'), Buffer.from(s2.data, 'base64'));
        try { at2.ws.close(); } catch (e) {}
      }
    }
    check('C12', '390×844：首页页脚、设置面板（含试听行+新说明段）、教师端页脚 scrollWidth <= innerWidth',
      !m1.__err && m1.sw <= m1.vw + 1 && m1.right <= m1.vw + 1 && m1.footInner &&
      !m2.__err && m2.sw <= m2.vw + 1 && m2.sheetInner && m2.right <= m2.vw + 1 && m2.rowOk && m2.rowRight <= m2.vw + 1 &&
      m2.noteOk && m2.noteH > 0 && m2.noteOverflow &&
      !m3.skip && m3.sw <= m3.vw + 1 && m3.right <= m3.vw + 1 && m3.footInner,
      JSON.stringify({ m1, m2, m3 }));

    /* ================= C13 无未捕获脚本错误 ================= */
    check('C13', '整轮无未捕获脚本错误（Runtime.exceptionThrown / console.error）',
      ctx.errors.length === 0, ctx.errors.join(' | ').slice(0, 400));

    /* ================= C14 交付一致性 + 交付 teacher.html file:// 可用 ================= */
    const listFiles = (dir, base = dir, out = []) => {
      for (const n of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, n);
        if (fs.statSync(p).isDirectory()) listFiles(p, base, out);
        else out.push(path.relative(base, p).replace(/\\/g, '/'));
      }
      return out;
    };
    const md5 = p => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
    const srcFiles = listFiles(SRC);
    const delFiles = listFiles(DEL);
    const onlySrc = srcFiles.filter(f => delFiles.indexOf(f) < 0);
    const onlyDel = delFiles.filter(f => srcFiles.indexOf(f) < 0);
    const diffMd5 = srcFiles.filter(f => delFiles.indexOf(f) >= 0 && md5(path.join(SRC, f)) !== md5(path.join(DEL, f)));
    const delT = await teacherCheck(DEL_TEACHER, 'del');
    check('C14', '交付 App/ 与源码逐文件 MD5 全等（' + srcFiles.length + ' 个）、无多余/缺失文件，交付 teacher.html file:// 直开可用',
      onlySrc.length === 0 && onlyDel.length === 0 && diffMd5.length === 0 && srcFiles.length === 14 &&
      !delT.fail && delT.input === true && delT.sheets >= 1 && (delT.errors || []).length === 0 &&
      delT.hasCup && delT.hasTeam && delT.notV8.length === 0,
      JSON.stringify({ srcN: srcFiles.length, delN: delFiles.length, onlySrc, onlyDel, diffMd5, delT }));

    /* ================= C15 0 外部网络请求 ================= */
    const perfReqs = await run(`
      const perf = performance.getEntriesByType('resource') || [];
      return { n: perf.length, urls: perf.map(r => r.name).slice(0, 40), initiators: [...new Set(perf.map(r => r.initiatorType))] };
    `);
    const isExternal = u => /^(https?|wss?):/i.test(String(u || ''));
    const extNet = (ctx.reqs || []).filter(isExternal);
    const extPerf = ((perfReqs && perfReqs.urls) || []).filter(isExternal);
    check('C15', '整轮 0 外部网络请求（朗读走系统语音引擎，无 CDN / 无字体 / 无埋点）',
      !perfReqs.__err && extNet.length === 0 && extPerf.length === 0,
      JSON.stringify({ netReqs: (ctx.reqs || []).length, externalNet: extNet.slice(0, 5), perfN: perfReqs.n, externalPerf: extPerf.slice(0, 5), initiators: perfReqs.initiators }));

  } catch (e) {
    check('CATCH', '执行过程无异常', false, e.message);
  }

  const passed = results.filter(r => r.ok).length;
  console.log('\n' + passed + '/' + results.length + ' passed');
  fs.writeFileSync(path.join(SHOTS, 'qa-v8-report.json'), JSON.stringify(results, null, 2));

  try { main.ws.close(); } catch (e) {}
  chrome.kill();
  process.exit(passed === results.length ? 0 : 1);
})();

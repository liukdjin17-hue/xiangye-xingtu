/* qa-v6.js · QA 独立复验（走与 e2e-v6.js 不同的路径，专抓「工程自测覆盖不到的真实操作」）
 *
 * 用例名以验收表编号开头，便于逐条对照：
 *   32 交付 MD5 · 3 引导（9 步/第 2 步文案/?tour=0|1）· 5 年级 11 项 · 6 四学段+局部刷新
 *   7 老数据「高一」· 8 任务 3 组 14 项 · 9 dim 由 data.js 的 st 独立算出 · 10 打卡持久化与报告按学段取 4 项
 *   33 设置里「修改学科偏好」可改（补 K3）
 *   11—19 补答闸门 9 条（含第 60 题「先跳过」/「下一题」两条独立路径、键盘、跳走关闸、连点、中途刷新）
 *   4 备份 roundtrip + v4 遗留键 · 20 七个 tab/#teacher · 21—25 教师端（12 人/CSV/容错/隔离/交付页）
 *   26 DeepSeek 保留 Key · 27 KB = 58 且 6 个问法命中 · 28 act.page 不抛异常 · 29 无外部请求
 *   34 双职业对比问答（护理和幼师怎么选 → 对照 + 加入对比并跳对比页）
 *   30 390px 无横向溢出 · 31 无未捕获异常 · 2 file:// 与 http://127.0.0.1:8765 双协议
 *
 * 跑法：node tests/qa-v6.js
 * 前置：交付\乡野星图-桌面版\serve.ps1 -NoBrowser -Port 8765 已在跑
 *      （未起也能跑，2a/2b/2c 会报失败；QA_HTTP=0 可跳过 http 部分）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL: fileURL } = require('url');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9351);
const SRC = path.join(__dirname, '..', 'app');
const DEL = path.join(__dirname, '..', '..', '交付', '乡野星图-桌面版', 'App');
const SHOTS = path.join(__dirname, '..', '..', '测试截图');
const HTTP_BASE = process.env.QA_BASE || 'http://127.0.0.1:8765';
const RUN_HTTP = process.env.QA_HTTP !== '0';
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
let group = '';
const check = (id, name, ok, detail) => {
  results.push({ id, group, name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + id + ' | ' + name + (detail ? ' | ' + String(detail).slice(0, 380) : ''));
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

/* ---------- 交付一致性（不依赖浏览器，但结果以用例形式登记） ---------- */
function listFiles(dir, base = dir, out = []) {
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) listFiles(p, base, out);
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}
const md5 = p => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

/* ---------- 页面内工具（每次 reload 后重新注入） ---------- */
const HELP = `window.__qa = (function () {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const st = () => window.XYXT_APP.state();
  const gate = () => document.getElementById('qgate');
  const step = () => ((document.body.innerText.match(/第 (\\d+) \\/ 60 题/) || [])[1] || '');
  async function fresh() {
    /* v6.1：「重新测一次 / 重新开始」要点两次才清空，第一次只上膛 */
    const r = document.querySelector('[data-act="retest"]');
    if (r) {
      r.click(); await sleep(200);
      const r2 = document.querySelector('[data-act="retest"]');
      if (r2) { r2.click(); await sleep(380); } else { await sleep(180); }
      return 'retest';
    }
    const c = document.querySelector('[data-act="gate-cancel"]');
    if (c) { c.click(); await sleep(160); }
    const s0 = document.querySelector('[data-act="start-test"]');
    if (s0) {
      s0.click(); await sleep(200);
      const s1 = document.querySelector('[data-act="start-test"]');
      if (s1) { s1.click(); await sleep(380); }
      return 'start';
    }
    const s = st();
    s.testing = true; s.answers = {}; s.cursor = 0; s.result = null;
    window.XYXT_APP.save(); window.XYXT_APP.go('test'); await sleep(220);
    return 'state';
  }
  async function answer(v, wait) {
    const b = document.querySelectorAll('#scale button');
    if (b.length < 5) return false;
    b[(v || 3) - 1].click();
    await sleep(wait || 215);
    return true;
  }
  async function skip(wait) {
    const b = document.querySelector('[data-act="skip-q"]');
    if (!b) return false;
    b.click(); await sleep(wait || 215);
    return true;
  }
  /* 逐题作答：skipAt 里的小标号用「先跳过」，其余点指定分值 */
  async function run(opt) {
    opt = opt || {};
    const n = opt.n || 60, skipAt = opt.skipAt || [], value = opt.value || 3;
    let i = 0;
    for (; i < n; i++) {
      if (st().result) break;
      if (gate()) break;
      const ok = skipAt.indexOf(i) >= 0 ? await skip() : await answer(value);
      if (!ok) break;
    }
    return { answered: Object.keys(st().answers).length, cursor: st().cursor, result: !!st().result, gate: !!gate(), step: step(), testing: st().testing };
  }
  return { sleep, st, gate, step, fresh, answer, skip, run };
})();`;

/* ---------- CDP 会话 ---------- */
async function connect(wsUrl, sink) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (sink) sink(m);
  };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');
  const api = {
    ws, send,
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.text || '') + ' ' + ((d.exception && (d.exception.description || d.exception.value)) || ''));
      }
      return r.result.value;
    },
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
    },
    async reload(wait = 1700) { await send('Page.reload', { ignoreCache: true }); await sleep(wait); await api.eval(HELP); },
    async goto(url, wait = 1700) { await send('Page.navigate', { url }); await sleep(wait); await api.eval(HELP); },
    close() { try { ws.close(); } catch (e) { /* ignore */ } }
  };
  await api.eval(HELP);
  return api;
}

async function waitPages(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const t = await getJSON('http://127.0.0.1:' + port + '/json/list');
      const pages = t.filter(x => x.type === 'page');
      if (pages.length) return pages;
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('连不上 Chrome 调试端口 ' + port);
}

async function openTab(port, url, sink) {
  const tgt = await new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), { method: 'PUT' }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad target json')); } });
    });
    req.on('error', reject);
    req.end();
  });
  const tab = await connect(tgt.webSocketDebuggerUrl, sink);
  await sleep(1300);
  /* 新标签从 about:blank 导航过来会换掉 JS 上下文，加载完再注入一次页面内工具 */
  try { await tab.eval(HELP); } catch (e) { await sleep(900); await tab.eval(HELP); }
  tab.id = tgt.id;
  tab.kill = async () => { await getJSON('http://127.0.0.1:' + port + '/json/close/' + tgt.id).catch(() => {}); };
  return tab;
}

const consoleErrors = [];
const netReqs = [];
const sink = m => {
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleErrors.push('[exception] ' + (d.text || '') + ' ' + ((d.exception && (d.exception.description || d.exception.value)) || ''));
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push('[console] ' + m.params.args.map(a => a.value || a.description || '').join(' '));
  } else if (m.method === 'Network.requestWillBeSent') {
    netReqs.push(m.params.request.url);
  }
};

/* ==================================================================== */
(async () => {
  /* ================= 0. 静态：交付一致性 + 知识库条数 ================= */
  group = '静态';
  const srcFiles = listFiles(SRC);
  const delFiles = listFiles(DEL);
  const onlySrc = srcFiles.filter(f => delFiles.indexOf(f) < 0);
  const onlyDel = delFiles.filter(f => srcFiles.indexOf(f) < 0);
  const md5diff = srcFiles.filter(f => fs.existsSync(path.join(DEL, f)) && md5(path.join(SRC, f)) !== md5(path.join(DEL, f)));
  check('32', '交付一致性：源码 app 与 交付 App 逐文件 MD5 全等（无多余/缺失，16→14 个文件都算上）',
    onlySrc.length === 0 && onlyDel.length === 0 && md5diff.length === 0 && srcFiles.length === 14,
    JSON.stringify({ files: srcFiles.length, onlySrc, onlyDel, md5diff }));

  const starSrc = fs.readFileSync(path.join(SRC, 'assets', 'star.js'), 'utf8');
  const kbArr = starSrc.slice(starSrc.indexOf('[', starSrc.indexOf('const KB = ')), starSrc.indexOf('];', starSrc.indexOf('const KB = ')) + 1);
  const kbCount = (kbArr.match(/\n\s{4}\{\s*\n\s*id: '/g) || []).length;
  check('27a', '知识库条数 = 58（star.js 的 KB 数组，v5 的 29 条 → v6 的 56 条 → 补修后 58 条）', kbCount >= 58, 'KB=' + kbCount);

  /* ================= 启动 Chrome（file:// 全新 profile，强制引导） ================= */
  const profile = path.join(os.tmpdir(), 'xyxt-qa-v6-' + Date.now());
  const appUrl = fileURL(path.join(SRC, 'index.html')).href;
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1100,1200',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', appUrl + '?tour=1'
  ], { stdio: 'ignore' });

  const pages = await waitPages(PORT);
  const S = await connect(pages[0].webSocketDebuggerUrl, sink);
  await S.send('Network.enable');
  await sleep(1600);

  try {
    /* ================= A3 首次引导 ================= */
    group = 'A 引导与回归';
    const t3a = await S.eval(`(() => {
      const layer = document.getElementById('tourLayer');
      return {
        open: !!layer && layer.hidden === false,
        step: (document.getElementById('tourK') || {}).textContent.trim(),
        cards: document.querySelectorAll('#view .card').length
      };
    })()`);
    check('3a', '全新 profile 首次打开自动弹引导并停在第 1 步（首页已正常渲染）',
      t3a.open && /1\s*\/\s*9/.test(t3a.step) && t3a.cards >= 2, JSON.stringify(t3a));

    const t3b = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('#tourCard [data-tour="next"]').click();
      await s(420);
      return {
        step: (document.getElementById('tourK') || {}).textContent.trim(),
        title: (document.getElementById('tourTitle') || {}).textContent || '',
        text: (document.getElementById('tourText') || {}).textContent || ''
      };
    })()`);
    check('3b', '第 2 步文案是「七个入口」，并说明教师端是独立页 teacher.html',
      /2\s*\/\s*9/.test(t3b.step) && /七个入口/.test(t3b.title) && /teacher\.html/.test(t3b.text),
      JSON.stringify(t3b));

    const t3c = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const layer = document.getElementById('tourLayer');
      let clicks = 0;
      for (let i = 0; i < 12; i++) {
        if (!layer || layer.hidden === true) break;
        const b = document.querySelector('#tourCard [data-tour="next"]');
        if (!b) break;
        b.click(); clicks++;
        await s(240);
      }
      return { clicks, hidden: !layer || layer.hidden === true, tourDone: window.XYXT_APP.state().tourDone };
    })()`);
    check('3c', '引导 9 步能走完并记住（共 8 次「下一步」）',
      t3c.clicks === 8 && t3c.hidden && t3c.tourDone === true, JSON.stringify(t3c));

    await S.goto(appUrl + '?tour=0');
    const t3d = await S.eval(`(() => {
      const l = document.getElementById('tourLayer');
      return { open: !!l && l.hidden === false, cards: document.querySelectorAll('#view .card').length };
    })()`);
    check('3d', '?tour=0 不弹引导', !t3d.open && t3d.cards >= 2, JSON.stringify(t3d));

    await S.goto(appUrl + '?tour=1');
    const t3e = await S.eval(`(() => {
      const l = document.getElementById('tourLayer');
      return { open: !!l && l.hidden === false, step: (document.getElementById('tourK') || {}).textContent.trim() };
    })()`);
    check('3e', '?tour=1 强制弹引导（即使已完成过）', t3e.open && /1\s*\/\s*9/.test(t3e.step), JSON.stringify(t3e));

    await S.goto(appUrl + '?tour=0');

    /* ================= B5 年级 11 项 + 默认初一 ================= */
    group = 'B 年级与学段';
    const EXPECT_GRADES = ['小学五年级', '小学六年级', '初一', '初二', '初三', '高一', '高二', '高三', '中职一年级', '中职二年级', '中职三年级'];
    const b5 = await S.eval(`(() => {
      const sel = document.getElementById('pf-grade');
      return {
        count: sel ? sel.options.length : 0,
        opts: sel ? [...sel.options].map(o => o.value) : [],
        selected: sel ? sel.value : '',
        stored: window.XYXT_APP.state().profile.grade
      };
    })()`);
    check('5', '年级下拉正好 11 项、顺序与验收表一致、首次进入默认「初一」',
      b5.count === 11 && JSON.stringify(b5.opts) === JSON.stringify(EXPECT_GRADES) && b5.selected === '初一' && b5.stored === '初一',
      JSON.stringify({ count: b5.count, selected: b5.selected, opts: b5.opts.join(',') }));

    /* ================= B6 四学段文案 + 局部刷新不丢输入 ================= */
    const b6 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const sel = document.getElementById('pf-grade');
      const nick = document.getElementById('pf-nick');
      nick.value = '严过关';
      nick.dispatchEvent(new Event('input', { bubbles: true }));
      nick.focus();
      nick.selectionStart = nick.selectionEnd = 3;
      nick.__qaMark = 'keep-me';
      const focusBefore = document.activeElement === nick;
      const rows = [];
      for (const pair of [['小学六年级', 'p'], ['初二', 'j'], ['高一', 's'], ['中职二年级', 'v']]) {
        sel.value = pair[0];
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await s(230);
        const hint = document.querySelector('.stage-hint');
        const n2 = document.getElementById('pf-nick');
        rows.push({
          grade: pair[0], expect: pair[1],
          stage: hint ? hint.dataset.stage : '',
          text: hint ? hint.textContent : '',
          sameNode: n2.__qaMark === 'keep-me',
          value: n2.value,
          caret: n2.selectionStart,
          focused: document.activeElement === n2,
          stored: window.XYXT_APP.state().profile.grade,
          extra: !!document.querySelector('.stage-extra')
        });
      }
      return { focusBefore, rows };
    })()`);
    const distinct = new Set(b6.rows.map(r => r.text)).size;
    check('6a', '依次切 4 个学段：学段提示文案真的变了（4 段互不相同），data-stage 与年级匹配',
      b6.rows.every(r => r.stage === r.expect && r.stored === r.grade && r.text.length > 10) && distinct === 4,
      JSON.stringify(b6.rows.map(r => [r.grade, r.stage, r.text.slice(0, 22)])));
    check('6b', '切年级只局部刷新：昵称节点未重建、已输入内容/焦点/光标位置都不丢',
      b6.focusBefore === true && b6.rows.every(r => r.sameNode && r.value === '严过关' && r.focused && r.caret === 3),
      JSON.stringify({ focusBefore: b6.focusBefore, sameNode: b6.rows.map(r => r.sameNode), focus: b6.rows.map(r => r.focused), caret: b6.rows.map(r => r.caret), value: b6.rows.map(r => r.value) }));
    check('6c', '只有小学学段多出「60 题分两次做完」的提醒，其它学段没有',
      b6.rows.filter(r => r.expect === 'p').every(r => r.extra === true) &&
      b6.rows.filter(r => r.expect !== 'p').every(r => r.extra === false),
      JSON.stringify(b6.rows.map(r => [r.stage, r.extra])));
    await S.shot('qa-v6-grade-stage');

    /* ================= B7 老数据「高一」 ================= */
    await S.eval(`(() => {
      const raw = JSON.parse(localStorage.getItem('xyxt.v3'));
      raw.profile.grade = '高一';
      raw.profile.nick = '老用户';
      localStorage.setItem('xyxt.v3', JSON.stringify(raw));
      return true;
    })()`);
    await S.reload();
    const b7 = await S.eval(`(() => {
      const sel = document.getElementById('pf-grade');
      const hint = document.querySelector('.stage-hint');
      return {
        hasSelect: !!sel,
        selValue: sel ? sel.value : '(无下拉)',
        nickInput: !!document.getElementById('pf-nick'),
        stored: window.XYXT_APP.state().profile.grade,
        storedNick: window.XYXT_APP.state().profile.nick,
        stage: hint ? hint.dataset.stage : '',
        text: hint ? hint.textContent.slice(0, 24) : '',
        cards: document.querySelectorAll('#view .card').length
      };
    })()`);
    check('7', '老数据 grade 写成「高一」：不报错、下拉仍选中高一、按高中段给建议',
      b7.hasSelect && b7.selValue === '高一' && b7.stored === '高一' && b7.stage === 's' &&
      /高中/.test(b7.text) && b7.cards >= 2 && b7.storedNick === '老用户',
      JSON.stringify(b7));
    check('7b', '有称呼时首页仍保留年级下拉（昵称表单收起但年级不能跟着消失——否则填过称呼就再也改不了年级）',
      b7.hasSelect === true && b7.nickInput === false && b7.selValue === '高一',
      JSON.stringify({ hasSelect: b7.hasSelect, nickInput: b7.nickInput, selValue: b7.selValue }));

    /* 7c：有称呼时，首页精简下拉 + 设置里的「修改年级」都能真的改掉年级 */
    const b7c = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const sel = document.getElementById('pf-grade');
      sel.value = '小学六年级';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await s(260);
      const home = {
        stored: window.XYXT_APP.state().profile.grade,
        stage: (document.querySelector('.stage-hint') || { dataset: {} }).dataset.stage,
        extra: !!document.querySelector('.stage-extra')
      };
      document.getElementById('btnUser').click();
      await s(400);
      const row = document.querySelector('#sheet [data-set="grade"]');
      const rowLabel = row ? row.textContent.trim() : '';
      if (row) row.click();
      await s(400);
      const sel2 = document.getElementById('setGrade');
      const hasSel2 = !!sel2;
      if (sel2) {
        sel2.value = '初三';
        sel2.dispatchEvent(new Event('change', { bubbles: true }));
        await s(300);
      }
      const sheetStage = (document.getElementById('setGradeStage') || {}).textContent || '';
      const back = document.querySelector('#sheet [data-set="main"]');
      if (back) back.click();
      await s(350);
      const cl = document.querySelector('#sheet [data-act="close-sheet"]');
      if (cl) cl.click();
      await s(300);
      return {
        home, rowLabel, hasSel2, sheetStage,
        after: { stored: window.XYXT_APP.state().profile.grade, stage: (document.querySelector('.stage-hint') || { dataset: {} }).dataset.stage }
      };
    })()`);
    check('7c', '有称呼时：首页精简下拉与设置「修改年级」都能改年级，学段提示跟着变',
      b7c.home.stored === '小学六年级' && b7c.home.stage === 'p' && b7c.home.extra === true &&
      /修改年级/.test(b7c.rowLabel) && b7c.hasSel2 && b7c.after.stored === '初三' &&
      b7c.after.stage === 'j' && /初中/.test(b7c.sheetStage),
      JSON.stringify(b7c));

    /* 33：设置里能改学科偏好（recommend() 会用 profile.subjects 参与打分，不给入口等于选错就锁死） */
    const b33 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const st = window.XYXT_APP.state();
      st.profile.subjects = [];
      window.XYXT_APP.save();
      window.XYXT_APP.go('home');
      await s(340);
      document.getElementById('btnUser').click();
      await s(420);
      const row = document.querySelector('#sheet [data-set="subjects"]');
      const rowLabel = row ? row.textContent.trim() : '';
      if (row) row.click();
      await s(440);
      const sheet = document.getElementById('sheet');
      const chips = [...sheet.querySelectorAll('[data-sub]')];
      const inputs = sheet.querySelectorAll('input, select, textarea').length;
      const now0 = (document.getElementById('setSubNow') || {}).textContent || '';
      const pick = ['语文', '生物'];
      pick.forEach(n => { const b = chips.filter(c => c.dataset.sub === n)[0]; if (b) b.click(); });
      await s(280);
      const now1 = (document.getElementById('setSubNow') || {}).textContent || '';
      const openAfter = sheet.classList.contains('on') && sheet.getAttribute('aria-hidden') === 'false';
      const aria = pick.map(n => {
        const b = chips.filter(c => c.dataset.sub === n)[0];
        return b ? b.getAttribute('aria-pressed') + '/' + (b.classList.contains('teal') ? 'teal' : 'plain') : 'missing';
      });
      const stored = window.XYXT_APP.state().profile.subjects.slice();
      const back = document.querySelector('#sheet [data-set="main"]');
      if (back) back.click();
      await s(420);
      const rowVal = (document.querySelector('#sheet [data-set="subjects"]') || {}).textContent || '';
      document.querySelector('#sheet [data-set="subjects"]').click();
      await s(400);
      const b2 = [...document.querySelectorAll('#sheet [data-sub]')].filter(c => c.dataset.sub === '语文')[0];
      if (b2) b2.click();
      await s(260);
      const afterToggle = window.XYXT_APP.state().profile.subjects.slice();
      const cl = document.querySelector('#sheet [data-act="close-sheet"]');
      if (cl) cl.click();
      await s(280);
      return {
        rowLabel, chipN: chips.length, inputs, now0, now1, openAfter, aria, stored, rowVal, afterToggle,
        sheetOpen: document.getElementById('sheet').classList.contains('on'),
        saved: JSON.parse(localStorage.getItem('xyxt.v3') || '{}').profile.subjects
      };
    })()`);
    check('33', '设置→「修改学科偏好」：入口带当前值、13 个学科 chip、点选即存且面板不被重绘关掉、返回后值同步、再点一次能取消',
      /修改学科偏好/.test(b33.rowLabel) && b33.chipN === 13 && b33.inputs === 0 &&
      /还没选/.test(b33.now0) && JSON.stringify(b33.stored) === JSON.stringify(['语文', '生物']) &&
      JSON.stringify(b33.aria) === JSON.stringify(['true/teal', 'true/teal']) &&
      /已选/.test(b33.now1) && /语文/.test(b33.now1) && /生物/.test(b33.now1) && b33.openAfter === true &&
      /语文/.test(b33.rowVal) && /生物/.test(b33.rowVal) &&
      JSON.stringify(b33.afterToggle) === JSON.stringify(['生物']) &&
      JSON.stringify(b33.saved) === JSON.stringify(['生物']) && b33.sheetOpen === false,
      JSON.stringify(b33));

    /* ================= C8 任务 3 组 14 项 ================= */
    group = 'C 任务阶梯';
    const c8 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="task"]').click();
      await s(420);
      const idx = [...document.querySelectorAll('.task .idx')].map(x => x.textContent);
      return {
        groups: document.querySelectorAll('.lv-head').length,
        heads: [...document.querySelectorAll('.lv-head b')].map(b => b.textContent.trim()),
        lvN: [...document.querySelectorAll('.lv-n')].map(x => x.textContent.trim()),
        tasks: document.querySelectorAll('[data-task]').length,
        idx, unique: new Set(idx).size
      };
    })()`);
    const wantIdx = Array.from({ length: 14 }, (_, i) => String(i + 1).padStart(2, '0')).join(',');
    check('8', '任务页 3 个分组、14 项、序号 01—14 连续不缺号、分组顺序是按 1→3 阶',
      c8.groups === 3 && c8.tasks === 14 && c8.idx.join(',') === wantIdx && c8.unique === 14 &&
      /第 1 阶 · 轻松上手/.test(c8.heads[0]) && /第 2 阶 · 需要开口/.test(c8.heads[1]) && /第 3 阶 · 要花点功夫/.test(c8.heads[2]),
      JSON.stringify({ heads: c8.heads, tasks: c8.tasks, first: c8.idx[0], last: c8.idx[13], lvN: c8.lvN }));

    /* ================= C9 dim：预期值由 data.js 的 st 独立算出 ================= */
    const c9 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const TASKS = window.XYXT.TASKS;
      const stageOf = g => /小学/.test(g) ? 'p' : /^初/.test(g) ? 'j' : /中职/.test(g) ? 'v' : 's';
      const out = {};
      for (const g of ['小学五年级', '初二', '高三']) {
        const st = window.XYXT_APP.state();
        st.profile.grade = g;
        window.XYXT_APP.save();
        window.XYXT_APP.go('home');
        await s(200);
        document.querySelector('.tab[data-view="task"]').click();
        await s(280);
        const stage = stageOf(g);
        const expectIds = TASKS.filter(t => t.st.indexOf(stage) < 0).map(t => t.id).sort();
        const dimmed = [...document.querySelectorAll('.task.dim')];
        out[g] = {
          stage,
          expectIds, expectCount: expectIds.length,
          domCount: dimmed.length,
          domIds: dimmed.map(l => l.querySelector('[data-task]').dataset.task).sort(),
          stagTexts: [...new Set(dimmed.map(l => (l.querySelector('.stag') || {}).textContent || ''))],
          total: document.querySelectorAll('.task').length,
          fit: document.querySelectorAll('.task:not(.dim)').length
        };
      }
      return out;
    })()`);
    const p = c9['小学五年级'], j = c9['初二'], sg = c9['高三'];
    check('9a', '小学五年级 dim = 9，且与 data.js 的 st 独立算出的清单完全一致（不是抄工程的 9）',
      p.expectCount === 9 && p.domCount === 9 && JSON.stringify(p.domIds) === JSON.stringify(p.expectIds) &&
      p.stagTexts.every(t => /^适用：/.test(t)) && p.fit === 5 && p.total === 14,
      JSON.stringify({ expect: p.expectIds, dom: p.domIds, stag: p.stagTexts }));
    check('9b', '初二 dim = 3，正好是 t13/t3/t4（招聘简章/选科/算账，均 s/v），标签「适用：高中/中职」',
      j.expectCount === 3 && j.domCount === 3 && JSON.stringify(j.domIds) === JSON.stringify(j.expectIds) &&
      JSON.stringify(j.expectIds) === JSON.stringify(['t13', 't3', 't4']) && j.stagTexts.join('|') === '适用：高中/中职',
      JSON.stringify(j));
    check('9c', '高三 0 项 dim（14 项全适配）', sg.expectCount === 0 && sg.domCount === 0 && sg.stagTexts.length === 0 && sg.fit === 14,
      JSON.stringify(sg));
    await S.shot('qa-v6-tasks-dim');

    /* ================= C10 打卡持久化与进度同步 ================= */
    const c10 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const st = window.XYXT_APP.state();
      st.profile.grade = '初一';
      st.tasksDone = [];
      window.XYXT_APP.save();
      window.XYXT_APP.go('home');
      await s(200);
      document.querySelector('.tab[data-view="task"]').click();
      await s(320);
      const firstId = document.querySelector('[data-task]').dataset.task;
      document.querySelector('[data-task]').click();
      await s(420);
      return {
        firstId,
        checked: document.querySelectorAll('[data-task]:checked').length,
        progressNow: document.querySelector('.card .progress').getAttribute('aria-valuenow'),
        lv1: document.querySelector('.lv-n').textContent.trim(),
        doneClass: document.querySelectorAll('.task.done').length,
        stored: window.XYXT_APP.state().tasksDone.slice()
      };
    })()`);
    await S.reload();
    const c10b = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="task"]').click();
      await s(380);
      const text = document.getElementById('view').innerText;
      return {
        checked: document.querySelectorAll('[data-task]:checked').length,
        progressNow: document.querySelector('.card .progress').getAttribute('aria-valuenow'),
        doneLine: (text.split('\\n').filter(l => /完成 \\d+ \\/ 14 项/.test(l))[0] || '').trim(),
        pctLine: (text.split('\\n').filter(l => /% 完成/.test(l))[0] || '').trim(),
        lv1: document.querySelector('.lv-n').textContent.trim(),
        doneClass: document.querySelectorAll('.task.done').length,
        barWidth: document.querySelector('.card .progress > i').style.width
      };
    })()`);
    check('10a', '勾选第 1 项 → 刷新 → 仍勾选；完成数/进度条宽度/组内计数同步',
      c10.checked === 1 && c10.progressNow === '1' && c10.lv1 === '1/4' && c10.doneClass === 1 &&
      c10b.checked === 1 && c10b.progressNow === '1' && /完成 1 \/ 14 项/.test(c10b.doneLine) &&
      /7% 完成/.test(c10b.pctLine) && c10b.lv1 === '1/4' && c10b.doneClass === 1 && /^7/.test(c10b.barWidth),
      JSON.stringify({ onPage: c10, afterReload: c10b }));

    /* ================= D 补答闸门 ================= */
    group = 'D 补答闸门';
    /* D11 全程答完：v6.1 起不再自动交卷，停在提交卡，按了才出结果 */
    const d11 = await S.eval(`(async () => {
      document.querySelector('.tab[data-view="test"]').click();
      await window.__qa.sleep(320);
      await window.__qa.fresh();
      const r = await window.__qa.run({ n: 60, value: 2 });
      await window.__qa.sleep(450);
      const st = window.XYXT_APP.state();
      const before = {
        result: !!st.result,
        card: !!document.getElementById('qsubmit'),
        btn: !!document.querySelector('[data-act="submit-test"]'),
        reviewBtn: !!document.querySelector('[data-act="review-all"]'),
        gate: !!document.getElementById('qgate'),
        answered: Object.keys(st.answers).length,
        step: (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/')
      };
      const btn = document.querySelector('[data-act="submit-test"]');
      if (btn) { btn.click(); await window.__qa.sleep(650); }
      const st2 = window.XYXT_APP.state();
      return Object.assign(r, {
        before,
        resultAfter: !!st2.result,
        answered: st2.result ? st2.result.answered : -1,
        code: st2.result ? st2.result.code : '',
        warn: !!document.querySelector('.warn-note'),
        afterCard: !!document.getElementById('qsubmit'),
        testingAfter: st2.testing
      });
    })()`);
    check('11a', '全程答完 60 题：不弹闸门、停在「都答完了」提交卡、未自动交卷',
      !d11.before.result && d11.before.card && d11.before.btn && d11.before.reviewBtn &&
      !d11.before.gate && d11.before.answered === 60 && d11.before.step === '60/60',
      JSON.stringify(d11.before));
    check('11b', '按「提交并生成我的星图」后出结果，60 题全计分、无「未作答」提示',
      d11.resultAfter && d11.answered === 60 && !d11.before.gate && !d11.warn &&
      d11.testingAfter === false && !d11.afterCard && /^[RIASEC]{3}$/.test(d11.code),
      JSON.stringify(d11));

    const d10b = await S.eval(`(async () => {
      window.XYXT_APP.go('home');
      await window.__qa.sleep(400);
      const box = document.getElementById('report');
      if (!box) return { none: true, cards: document.querySelectorAll('#view .card').length };
      const items = [...box.querySelectorAll('ol.list-num li')].map(li => li.textContent.split('——')[0].trim());
      /* 预期顺序不抄工程实现：拿 data.js 的 st + 当前年级独立算一遍
         （先本学段能做的任务，不够再用其余任务补满），再截前 4 项 */
      const cur = window.XYXT_APP.state();
      const stageOf = g => /小学/.test(g) ? 'p' : /^初/.test(g) ? 'j' : /中职/.test(g) ? 'v' : 's';
      const stage = stageOf(cur.profile.grade);
      const T = window.XYXT.TASKS;
      const fit = T.filter(t => t.st.indexOf(stage) >= 0);
      const rest = T.filter(t => t.st.indexOf(stage) < 0);
      const order = fit.concat(rest);
      return {
        grade: cur.profile.grade, stage,
        items,
        expect: order.slice(0, 4).map(t => t.title),
        expectLv: order.slice(0, 4).map(t => t.lv),
        fitN: fit.length, totalN: T.length,
        onlyFit: order.slice(0, 4).every(t => fit.indexOf(t) >= 0),
        allFit: order.slice(0, 4).every(t => t.st.indexOf(stage) >= 0),
        /* t13「读一份真实的招聘简章」只适配 s/v，初中生不该在「接下来 30 天」里看到它 */
        hasSoloTask: order.slice(0, 4).some(t => t.st.length <= 2)
      };
    })()`);
    check('10b', '报告页「接下来 30 天」按学段取 4 项：初一只拿适配的（不含「适用：高中/中职」的 t13），第 4 项自动顺延到 t11',
      !d10b.none && d10b.expect.length === 4 && d10b.items.length === 4 &&
      JSON.stringify(d10b.items) === JSON.stringify(d10b.expect) &&
      d10b.fitN >= 4 && d10b.onlyFit === true && d10b.allFit === true &&
      d10b.hasSoloTask === false && d10b.expectLv[0] === 1,
      JSON.stringify(d10b));

    /* D12 跳 2 题 → 闸门 */
    const d12 = await S.eval(`(async () => {
      await window.__qa.fresh();
      const r = await window.__qa.run({ n: 60, skipAt: [0, 58], value: 3 });
      await window.__qa.sleep(500);
      const g = document.getElementById('qgate');
      return Object.assign(r, {
        gateText: g ? g.innerText.replace(/\\s+/g, ' ').slice(0, 70) : '',
        chips: g ? [...g.querySelectorAll('.gate-jump [data-jump]')].map(b => b.textContent.trim()) : [],
        btns: g ? [...g.querySelectorAll('.btn-row [data-act]')].map(b => b.textContent.trim()) : []
      });
    })()`);
    check('12', '跳过第 1、第 59 题后答第 60 题：弹 #qgate、文案含「2」、state().result 仍为 null',
      d12.gate === true && /2/.test(d12.gateText) && d12.answered === 58 && d12.result === false &&
      d12.testing === true && JSON.stringify(d12.chips) === JSON.stringify(['第 1 题', '第 59 题']) && d12.btns.length === 3,
      JSON.stringify(d12));
    await S.shot('qa-v6-gate');

    /* D13 闸门补答 → 推进 → 出结果 */
    const d13 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="gate-fill"]').click();
      await s(460);
      const atFirst = { cursor: window.XYXT_APP.state().cursor, step: window.__qa.step(), gate: !!document.getElementById('qgate') };
      document.querySelectorAll('#scale button')[3].click();
      await s(420);
      const afterFirst = { cursor: window.XYXT_APP.state().cursor, step: window.__qa.step(), gate: !!document.getElementById('qgate') };
      document.querySelector('[data-jump="58"]').click();
      await s(360);
      const at59 = window.__qa.step();
      document.querySelectorAll('#scale button')[3].click();
      await s(460);
      document.querySelectorAll('#scale button')[0].click();
      await s(750);
      /* 补答完不再自动交卷：先停在提交卡，按了才出结果 */
      const stopCard = !!document.getElementById('qsubmit');
      const sub = document.querySelector('[data-act="submit-test"]');
      if (sub) { sub.click(); await s(650); }
      const st = window.XYXT_APP.state();
      return {
        atFirst, afterFirst, at59,
        stopCard,
        result: !!st.result,
        answered: st.result ? st.result.answered : -1,
        warn: !!document.querySelector('.warn-note'),
        gate: !!document.getElementById('qgate'),
        testing: st.testing
      };
    })()`);
    check('13', '闸门「补答这 2 题」→ 跳到第 1 题；答完自动推进；补完停在提交卡、提交后出结果且无未答提示',
      d13.atFirst.cursor === 0 && d13.atFirst.step === '1' && !d13.atFirst.gate &&
      d13.afterFirst.cursor === 1 && d13.afterFirst.step === '2' && !d13.afterFirst.gate && d13.at59 === '59' &&
      d13.stopCard && d13.result && d13.answered === 60 && !d13.warn && !d13.gate && d13.testing === false,
      JSON.stringify(d13));

    /* D14 就这样生成结果 + 去补答 */
    const d14 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      await window.__qa.fresh();
      await window.__qa.run({ n: 60, skipAt: [0, 58], value: 2 });
      await s(500);
      const hadGate = !!document.getElementById('qgate');
      document.querySelector('[data-act="gate-submit"]').click();
      await s(700);
      const st = window.XYXT_APP.state();
      const warn = document.querySelector('.warn-note');
      const fix = document.querySelector('[data-act="fix-blank"]');
      const out = {
        hadGate,
        result: !!st.result,
        answered: st.result ? st.result.answered : -1,
        warnText: warn ? warn.textContent.replace(/\\s+/g, ' ').trim() : '',
        fixBtn: !!fix,
        gate: !!document.getElementById('qgate')
      };
      if (fix) fix.click();
      await s(520);
      const st2 = window.XYXT_APP.state();
      out.afterFix = { testing: st2.testing, cursor: st2.cursor, step: window.__qa.step(), gate: !!document.getElementById('qgate') };
      return out;
    })()`);
    check('14', '闸门「就这样生成结果」→ 出结果 + 「有 2 题未作答」+「去补答」可点，点后回到未答题且 testing===true',
      d14.hadGate && d14.result && d14.answered === 58 && /2 道题没有作答/.test(d14.warnText) && d14.fixBtn && !d14.gate &&
      d14.afterFix.testing === true && d14.afterFix.cursor === 0 && d14.afterFix.step === '1' && !d14.afterFix.gate,
      JSON.stringify(d14));
    await S.shot('qa-v6-result-warn');

    /* D15 第 60 题「先跳过」（前面有未答）→ 闸门 */
    const d15 = await S.eval(`(async () => {
      await window.__qa.fresh();
      await window.__qa.run({ n: 59, skipAt: [29], value: 3 });
      const at = { cursor: window.XYXT_APP.state().cursor, step: window.__qa.step() };
      const btn = document.querySelector('[data-act="skip-q"]');
      const clicked = !!btn;
      if (btn) btn.click();
      await window.__qa.sleep(650);
      const st = window.XYXT_APP.state();
      const g = document.getElementById('qgate');
      return {
        at, clicked,
        gate: !!g,
        gateText: g ? g.innerText.replace(/\\s+/g, ' ').slice(0, 40) : '',
        result: st.result,
        testing: st.testing
      };
    })()`);
    check('15', '第 60 题点「先跳过」（前面有未答）→ 也走闸门，不是直接交卷',
      d15.at.cursor === 59 && d15.at.step === '60' && d15.clicked && d15.gate && d15.result === null &&
      d15.testing === true && /没答/.test(d15.gateText),
      JSON.stringify(d15));

    /* D16 第 60 题「下一题」（已答）→ 闸门 */
    const d16 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelectorAll('#scale button')[4].click();
      await s(620);
      const afterAnswer = { gate: !!document.getElementById('qgate'), result: !!window.XYXT_APP.state().result };
      document.querySelector('[data-act="gate-cancel"]').click();
      await s(420);
      const cur = window.XYXT_APP.state().cursor;
      const nb = document.querySelector('[data-act="next-q"]');
      const enabled = !!nb && !nb.disabled;
      if (nb) nb.click();
      await s(640);
      const st = window.XYXT_APP.state();
      return { afterAnswer, cur, enabled, gate: !!document.getElementById('qgate'), result: st.result, testing: st.testing };
    })()`);
    check('16', '第 60 题点「下一题」（已答状态）→ 同样走闸门，不直接交卷',
      d16.enabled === true && d16.cur === 59 && d16.gate && d16.result === null && d16.testing === true,
      JSON.stringify(d16));

    /* D17 闸门中键盘 1—5 / 点进度跳走关闸 */
    const d17 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const gateOpen = !!document.getElementById('qgate');
      let err = '';
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true })); }
      catch (e) { err = String(e && e.message); }
      await s(430);
      const b5 = document.querySelector('#scale button[data-v="5"]');
      const b3 = document.querySelector('#scale button[data-v="3"]');
      const scored = {
        err,
        sel5: !!b5 && b5.classList.contains('sel'),
        sel3: !!b3 && b3.classList.contains('sel'),
        answer60: window.XYXT_APP.state().answers[60],
        cursor: window.XYXT_APP.state().cursor,
        gateStill: !!document.getElementById('qgate'),
        alive: document.querySelectorAll('#scale button').length === 5
      };
      document.querySelector('[data-jump="12"]').click();
      await s(520);
      return {
        gateOpen, scored,
        after: { gate: !!document.getElementById('qgate'), cursor: window.XYXT_APP.state().cursor, step: window.__qa.step() }
      };
    })()`);
    check('17a', '闸门出现时用键盘按 5 → 正常打分（第 5 档选中、写进答案）且不崩',
      d17.gateOpen && !d17.scored.err && d17.scored.sel5 === true && d17.scored.sel3 === false &&
      d17.scored.answer60 === 5 && d17.scored.cursor === 59 && d17.scored.alive,
      JSON.stringify(d17.scored));
    check('17b', '闸门出现时点「查看答题进度」里的题号跳走 → 闸门关闭不残留',
      d17.after.gate === false && d17.after.cursor === 12 && d17.after.step === '13',
      JSON.stringify(d17.after));

    /* D18 连点 */
    const d18 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      await window.__qa.fresh();
      document.querySelector('[data-jump="9"]').click();
      await s(380);
      const startCursor = window.XYXT_APP.state().cursor;
      const b = document.querySelectorAll('#scale button');
      const t0 = performance.now();
      b[2].click(); b[2].click(); b[2].click();
      const dt = Math.round(performance.now() - t0);
      await s(760);
      const afterSame = { cursor: window.XYXT_APP.state().cursor, step: window.__qa.step(), gate: !!document.getElementById('qgate') };
      const b2 = document.querySelectorAll('#scale button');
      const t2 = performance.now();
      b2[0].click(); b2[4].click();
      const dt2 = Math.round(performance.now() - t2);
      await s(760);
      const afterMix = { cursor: window.XYXT_APP.state().cursor, step: window.__qa.step(), gate: !!document.getElementById('qgate') };
      return { startCursor, dt, afterSame, dt2, afterMix, answered: Object.keys(window.XYXT_APP.state().answers).length };
    })()`);
    check('18', '第 10 题 <170ms 连点同一分值 3 次：游标只前进 1 题（第 11 题），不会跳过 2 题',
      d18.startCursor === 9 && d18.dt < 170 && d18.afterSame.cursor === 10 && d18.afterSame.step === '11' && !d18.afterSame.gate,
      JSON.stringify(d18));
    check('18b', '连点两个不同分值（2→5）也只前进 1 题（第 12 题）',
      d18.dt2 < 170 && d18.afterMix.cursor === 11 && d18.afterMix.step === '12' && !d18.afterMix.gate,
      JSON.stringify({ dt2: d18.dt2, afterMix: d18.afterMix }));

    /* D19 中途刷新续做 */
    const d19 = await S.eval(`(async () => {
      await window.__qa.fresh();
      await window.__qa.run({ n: 30, value: 4 });
      const st = window.XYXT_APP.state();
      return { cursor: st.cursor, answered: Object.keys(st.answers).length, testing: st.testing, step: window.__qa.step() };
    })()`);
    await S.reload();
    const d19b = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      /* 刷新后 URL 里还留着 #test，直接落回题目流——这也是可接受的续做方式，先记下来 */
      const directStep = window.__qa.step();
      const directCursor = window.XYXT_APP.state().cursor;
      window.XYXT_APP.go('home');
      await s(420);
      const card = document.querySelector('.resume-card');
      const btn = document.querySelector('[data-act="resume-test"]');
      const out = {
        directStep, directCursor,
        card: !!card,
        text: card ? card.innerText.replace(/\\s+/g, ' ').trim() : '',
        btnLabel: btn ? btn.textContent.trim() : ''
      };
      if (btn) btn.click();
      await s(520);
      const st = window.XYXT_APP.state();
      out.after = { cursor: st.cursor, testing: st.testing, step: window.__qa.step(), hash: location.hash };
      return out;
    })()`);
    check('19', '答 30 题后刷新：首页「已答 30/60 · 继续第 31 题」，点按钮真的进到第 31 题（带 #test 时直接停在第 31 题）',
      d19.cursor === 30 && d19.answered === 30 && d19b.card && /已答 30 \/ 60 题/.test(d19b.text) &&
      /继续第 31 题/.test(d19b.btnLabel) && d19b.after.cursor === 30 && d19b.after.step === '31' &&
      d19b.after.testing === true && d19b.after.hash === '#test' && d19b.directStep === '31' && d19b.directCursor === 30,
      JSON.stringify({ before: d19, afterReload: d19b }));

    /* ================= A4 备份导出 → 导入 + v4 遗留键 ================= */
    group = 'A 引导与回归';
    const a4exp = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const st = window.XYXT_APP.state();
      st.profile.nick = '备份甲';
      st.profile.grade = '中职二年级';
      st.fav = ['nurse', 'teacher'];
      st.tasksDone = ['t2', 't9'];
      window.XYXT_APP.save();
      window.XYXT_APP.go('home');
      await s(250);
      document.getElementById('btnUser').click();
      await s(380);
      let captured = null;
      const oc = URL.createObjectURL, oclick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = b => { captured = b; return 'blob:qa'; };
      HTMLAnchorElement.prototype.click = function () {};
      const btn = document.querySelector('#sheet [data-act="export-backup"]');
      const hasBtn = !!btn;
      if (btn) btn.click();
      await s(450);
      URL.createObjectURL = oc;
      HTMLAnchorElement.prototype.click = oclick;
      const text = captured ? await captured.text() : '';
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      const cl = document.querySelector('#sheet [data-act="close-sheet"]');
      if (cl) cl.click();
      await s(250);
      return {
        hasBtn, isJson: !!json, bytes: text.length,
        nick: json ? json.profile.nick : '', grade: json ? json.profile.grade : '',
        fav: json ? json.fav.length : 0, tasks: json ? json.tasksDone.length : 0, text
      };
    })()`);
    const a4imp = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const st = window.XYXT_APP.state();
      st.profile.nick = '被改坏了';
      st.profile.grade = '初一';
      st.fav = [];
      st.tasksDone = [];
      window.XYXT_APP.save();
      await s(220);
      const text = ${JSON.stringify(a4exp.text || '')};
      const file = new File([text], 'backup.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const inp = document.getElementById('backupFile');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      await s(820);
      const now = window.XYXT_APP.state();
      return {
        nick: now.profile.nick, grade: now.profile.grade,
        fav: now.fav.length, tasks: now.tasksDone.length,
        chip: document.getElementById('userName').textContent,
        toast: (document.getElementById('toast') || {}).textContent || ''
      };
    })()`);
    check('4a', '备份导出 → 导入 → 数据整份恢复（昵称/年级/收藏/打卡全回来）',
      a4exp.hasBtn && a4exp.isJson && a4exp.bytes > 200 &&
      a4imp.nick === '备份甲' && a4imp.grade === '中职二年级' && a4imp.fav === 2 && a4imp.tasks === 2 &&
      a4imp.chip === '备份甲' && /已恢复/.test(a4imp.toast),
      JSON.stringify({ exported: { bytes: a4exp.bytes, nick: a4exp.nick, grade: a4exp.grade }, restored: a4imp }));

    await S.eval(`(() => {
      localStorage.clear();
      localStorage.setItem('xyxt.v3.u.legacy', JSON.stringify({
        v: 4, profile: { nick: 'v4 老用户', grade: '高三', county: '', subjects: [] },
        answers: {}, fav: ['nurse'], tasksDone: [], chat: [], starChat: [], tourDone: true,
        createdAt: 1710000000000
      }));
      return Object.keys(localStorage);
    })()`);
    await S.reload();
    const a4b = await S.eval(`(() => ({
      nick: window.XYXT_APP.state().profile.nick,
      grade: window.XYXT_APP.state().profile.grade,
      fav: window.XYXT_APP.state().fav.length,
      hasV3: !!localStorage.getItem('xyxt.v3'),
      chip: document.getElementById('userName').textContent,
      cards: document.querySelectorAll('#view .card').length
    }))()`);
    check('4b', 'v4 遗留键 xyxt.v3.u.* 仍能被接管（v6 没弄坏 v5 的兼容逻辑）',
      a4b.nick === 'v4 老用户' && a4b.grade === '高三' && a4b.fav === 1 && a4b.hasV3 &&
      a4b.chip === 'v4 老用户' && a4b.cards >= 2,
      JSON.stringify(a4b));

    /* ================= F26 DeepSeek 一键填入 ================= */
    group = 'F DeepSeek 与知识库';
    const f26 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      window.XYXT_STAR.saveConfig({ baseUrl: '', apiKey: 'sk-qa-user-key', model: '' });
      document.getElementById('btnUser').click();
      await s(380);
      document.querySelector('#sheet [data-set="star"]').click();
      await s(380);
      const sheet = document.getElementById('sheet');
      const docs = sheet.innerText;
      const btn = document.querySelector('#sheet [data-act="set-star-deepseek"]');
      const hasBtn = !!btn;
      if (btn) btn.click();
      await s(480);
      const cfg = window.XYXT_STAR.config();
      const out = {
        hasBtn,
        docsUrl: /api\\.deepseek\\.com\\/v1/.test(docs),
        docsModel: /deepseek-chat/.test(docs),
        docsKey: /platform\\.deepseek\\.com|API Key/i.test(docs),
        baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey,
        baseInput: (document.getElementById('starBase') || {}).value || '',
        modelInput: (document.getElementById('starModel') || {}).value || '',
        keyInput: (document.getElementById('starKey') || {}).value || ''
      };
      const cl = document.querySelector('#sheet [data-act="close-sheet"]');
      if (cl) cl.click();
      await s(250);
      return out;
    })()`);
    check('26', '设置→小星星→「一键填入 DeepSeek」：baseUrl/模型写对，且保留用户已填的 apiKey',
      f26.hasBtn && f26.baseUrl === 'https://api.deepseek.com/v1' && f26.model === 'deepseek-chat' &&
      f26.apiKey === 'sk-qa-user-key' && f26.keyInput === 'sk-qa-user-key' &&
      f26.baseInput === 'https://api.deepseek.com/v1' && f26.modelInput === 'deepseek-chat' &&
      f26.docsUrl && f26.docsModel && f26.docsKey,
      JSON.stringify(f26));
    await S.eval(`window.XYXT_STAR.saveConfig({ baseUrl: '', apiKey: '', model: '' })`);

    /* ================= F27 6 个高频问法 ================= */
    const f27 = await S.eval(`(() => {
      const qs = ['教师端在哪', '怎么接 deepseek', '跳过的题还能补吗', '小学能做吗', '任务做不完怎么办', '报告怎么发给家长'];
      return qs.map(q => {
        const r = window.XYXT_STAR.__localReply(q) || {};
        const text = String(r.text || '');
        return { q, fallback: /这个我暂时答不准/.test(text), head: text.slice(0, 26), act: r.act ? Object.keys(r.act).join('+') : '' };
      });
    })()`);
    check('27b', '6 个高频问法全部命中非兜底回答（判据：不是「这个我暂时答不准」）',
      f27.every(x => !x.fallback) && f27.length === 6,
      JSON.stringify(f27.map(x => [x.q, x.fallback ? '兜底' : '命中', x.head])));
    check('27c', '知识库条数 = 58（v5 的 29 条 → v6 的 56 条 → 补修后的 58 条）且问答引擎可用', kbCount >= 58, 'KB=' + kbCount);

    /* ================= F34 双职业对比问答 ================= */
    const f34 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const lastAI = () => [...document.querySelectorAll('#starLog .star-msg.ai')].filter(m => !m.classList.contains('typing')).pop();
      const readAct = m => {
        const b = m ? m.querySelector('.star-act') : null;
        return b ? JSON.parse(b.dataset.starAct) : null;
      };

      /* 1) 单职业不能被对比逻辑抢走 */
      window.XYXT_STAR.reset();
      await window.XYXT_STAR.ask('护理怎么样');
      await s(520);
      const one = lastAI();
      const oneAct = readAct(one);
      const oneText = one ? one.textContent : '';

      window.XYXT_STAR.reset();
      await window.XYXT_STAR.ask('无人机飞手累不累');
      await s(520);
      const two = lastAI();
      const twoAct = readAct(two);

      /* 2) 先塞一个不相干的职业，验证「整体替换成这两个」 */
      const st = window.XYXT_APP.state();
      st.compare = ['dev'];
      window.XYXT_APP.save();

      /* 3) 最后再问对比题，按钮要用当下的 DOM 节点（reset 会重建列表，旧节点点不动） */
      window.XYXT_STAR.reset();
      await window.XYXT_STAR.ask('护理和幼师怎么选');
      await s(560);
      const cmpMsg = lastAI();
      const cmpText = cmpMsg ? cmpMsg.textContent : '';
      const cmpAct = readAct(cmpMsg);

      /* 独立算一遍「哪几条两边一样」，不抄 compareReply 的实现 */
      const C = window.XYXT.CAREERS;
      const byId = id => C.filter(c => c.id === id)[0];
      const ca = byId('nurse'), cb = byId('preschool');
      const fc = x => String(x || '').split(/[；;。]/)[0].trim();
      const rows = [
        ['学历门槛', String(ca.edu), String(cb.edu)],
        ['本地机会', String(ca.local), String(cb.local)],
        ['最难的地方', fc(ca.hint), fc(cb.hint)]
      ];
      const expectSame = rows.filter(r => r[1] === r[2]).length;
      const expectDiff = rows.filter(r => r[1] !== r[2]).map(r => r[0]);

      /* 另外两支也要验：一同一异、三异 */
      window.XYXT_STAR.reset();
      await window.XYXT_STAR.ask('城乡规划和测绘怎么选');
      await s(520);
      const oneSame = lastAI() ? lastAI().textContent : '';
      window.XYXT_STAR.reset();
      await window.XYXT_STAR.ask('城乡规划和乡村规划怎么选');
      await s(520);
      const noneSame = lastAI() ? lastAI().textContent : '';

      window.XYXT_STAR.reset();
      await window.XYXT_STAR.ask('护理和幼师怎么选');
      await s(560);
      const btnMsg = lastAI();
      const btn = btnMsg ? btnMsg.querySelector('.star-act') : null;
      const btnLabel = btn ? btn.textContent.trim() : '';
      if (btn) btn.click();
      await s(760);

      const th = [...document.querySelectorAll('table.compare thead th')].map(x => x.textContent.trim());
      const panel = document.getElementById('starPanel');

      const out = {
        btnLabel, cmpText, expectSame, expectDiff,
        oneSame, noneSame,
        hasEdu: /学历/.test(cmpText), hasLocal: /本地机会/.test(cmpText), hasHard: /最难的地方/.test(cmpText),
        cmpAct,
        oneCareer: oneAct && oneAct.career, oneHasDay: /一天大概是这样的/.test(oneText),
        twoCareer: twoAct && twoAct.career,
        hash: location.hash,
        compare: window.XYXT_APP.state().compare.slice(),
        th, hasTable: !!document.querySelector('table.compare'),
        panelClosed: !panel || panel.hidden === true,
        stored: (JSON.parse(localStorage.getItem('xyxt.v3') || '{}').compare) || null
      };

      /* 收尾：这条会把页面带到对比页，回首页，别影响后面「#teacher 不白屏」那条 */
      location.hash = '#home';
      await s(420);
      return out;
    })()`);
    check('34', '双职业对比问答：「护理和幼师怎么选」出学历/本地机会/最难处三条对照，并自动点明「上面 2 条两边一样，真正把人分开的是最难的地方」；act.compare 两项，点按钮后整体替换对比条并跳到对比页（表头三列）',
      f34.hasEdu && f34.hasLocal && f34.hasHard &&
      /* 哪几条一样是拿 data.js 独立算的，不是抄工程实现 */
      f34.expectSame === 2 && f34.expectDiff.length === 1 && f34.expectDiff[0] === '最难的地方' &&
      /两边一样/.test(f34.cmpText) &&
      f34.cmpText.indexOf('上面 2 条两边一样，真正把人分开的是「最难的地方」') >= 0 &&
      f34.cmpText.indexOf('**') < 0 &&
      /* 一同一异、三异两支也要走对 */
      /有一项两边一样（本地机会）/.test(f34.oneSame) &&
      !/两边一样/.test(f34.noneSame) &&
      !!f34.cmpAct && f34.cmpAct.label === '加入对比并查看' &&
      Array.isArray(f34.cmpAct.compare) && f34.cmpAct.compare.length === 2 &&
      f34.cmpAct.compare[0] === 'nurse' && f34.cmpAct.compare[1] === 'preschool' &&
      f34.oneCareer === 'nurse' && f34.oneHasDay === true && f34.twoCareer === 'uav' &&
      f34.hash === '#compare' && f34.hasTable === true &&
      JSON.stringify(f34.compare) === JSON.stringify(['nurse', 'preschool']) &&
      JSON.stringify(f34.stored) === JSON.stringify(['nurse', 'preschool']) &&
      f34.th.length === 3 && /护理师/.test(f34.th[1]) && /幼儿教师/.test(f34.th[2]) &&
      f34.panelClosed === true,
      JSON.stringify({ expectSame: f34.expectSame, expectDiff: f34.expectDiff, btnLabel: f34.btnLabel, hash: f34.hash, compare: f34.compare, th: f34.th, oneCareer: f34.oneCareer, twoCareer: f34.twoCareer }));

    /* ================= F28 act.page 动作 ================= */
    const f28 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.getElementById('starFab').click();
      await s(400);
      window.XYXT_STAR.ask('教师端在哪');
      await s(760);
      const btns = [...document.querySelectorAll('#starLog [data-star-act]')];
      const btn = btns[btns.length - 1];
      const orig = window.open;
      let opened = '', err = '';
      window.open = u => { opened = String(u || ''); return {}; };
      try { if (btn) btn.click(); } catch (e) { err = String(e && e.message); }
      await s(380);
      window.open = orig;
      const panel = document.getElementById('starPanel');
      return { label: btn ? btn.textContent.trim() : '', opened, err, closed: !panel || panel.hidden === true, hash: location.hash };
    })()`);
    check('28', '小星星「打开教师端」这类 act.page 动作点击不抛异常（headless 拦 window.open 也不崩）',
      /teacher\.html/.test(f28.opened) && !f28.err && f28.closed === true && f28.hash !== '#teacher',
      JSON.stringify(f28));

    /* ================= E20 七个 tab / #teacher ================= */
    group = 'E 教师端独立';
    const e20 = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const tabs = [...document.querySelectorAll('.tab')].map(t => t.dataset.view);
      const homeBtn = document.querySelector('[data-act="open-teacher"]');
      let opened = '', err = '';
      const orig = window.open;
      window.open = u => { opened = String(u || ''); return {}; };
      try { if (homeBtn) homeBtn.click(); } catch (e) { err = String(e && e.message); }
      await s(300);
      window.open = orig;
      location.hash = '#teacher';
      await s(520);
      const out = {
        tabs: tabs.length, views: tabs,
        teacherTab: !!document.querySelector('.tab[data-view="teacher"]'),
        opened, err,
        cards: document.querySelectorAll('#view .card').length,
        active: (document.querySelector('.tab.active') || { dataset: {} }).dataset.view
      };
      location.hash = '#home';
      await s(320);
      return out;
    })()`);
    check('20', '学生端 tab = 7 且无 teacher；首页「打开教师端」是相对路径 teacher.html；#teacher 不白屏回首页',
      e20.tabs === 7 && !e20.teacherTab && e20.views.indexOf('teacher') < 0 &&
      e20.opened === 'teacher.html' && !e20.err && e20.cards >= 2 && e20.active === 'home',
      JSON.stringify(e20));

    /* ================= G30 390px：任务页 + 闸门 ================= */
    group = 'G 体验与兼容';
    await S.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(450);
    const g30a = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="task"]').click();
      await s(420);
      const task = { scrollW: document.documentElement.scrollWidth, vw: window.innerWidth, tasks: document.querySelectorAll('.task').length };
      document.querySelector('.tab[data-view="test"]').click();
      await s(350);
      await window.__qa.fresh();
      document.querySelector('[data-jump="59"]').click();
      await s(320);
      document.querySelector('[data-act="skip-q"]').click();
      await s(320);
      document.querySelector('[data-jump="59"]').click();
      await s(320);
      document.querySelectorAll('#scale button')[2].click();
      await s(680);
      const g = document.getElementById('qgate');
      const box = g ? g.getBoundingClientRect() : null;
      return {
        task,
        gate: !!g,
        gateRight: box ? Math.round(box.right) : 0,
        scrollW: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        gateScroll: g ? g.scrollWidth <= g.clientWidth + 1 : false
      };
    })()`);
    await S.shot('qa-v6-mobile-gate');
    check('30a', '390×844：任务页与闸门卡片都无横向溢出（scrollWidth ≤ innerWidth）',
      g30a.task.scrollW <= g30a.task.vw + 1 && g30a.task.tasks === 14 && g30a.gate &&
      g30a.gateRight <= g30a.vw + 1 && g30a.scrollW <= g30a.vw + 1 && g30a.gateScroll,
      JSON.stringify(g30a));
    /* 已填过称呼时的首页（年级精简行 + 学段提示）在 390px 下也不能溢出 */
    const g30c = await S.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      window.XYXT_APP.go('home');
      await s(450);
      const sel = document.getElementById('pf-grade');
      const hint = document.querySelector('.stage-hint');
      return {
        scrollW: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        hasSelect: !!sel,
        selRight: sel ? Math.round(sel.getBoundingClientRect().right) : 0,
        hintRight: hint ? Math.round(hint.getBoundingClientRect().right) : 0,
        nick: window.XYXT_APP.state().profile.nick
      };
    })()`);
    await S.shot('qa-v6-home-mobile');
    check('30c', '390×844：首页（已有称呼，只有年级精简行 + 学段提示）也不横向溢出',
      g30c.hasSelect && g30c.scrollW <= g30c.vw + 1 && g30c.selRight <= g30c.vw + 1 && g30c.hintRight <= g30c.vw + 1,
      JSON.stringify(g30c));
    await S.send('Emulation.clearDeviceMetricsOverride');
    await sleep(320);

    /* ================= E21—E25 教师端（交付目录的 teacher.html，file:// 直接打开） ================= */
    const v3Before = await S.eval(`localStorage.getItem('xyxt.v3') || 'NONE'`);
    const T = await openTab(PORT, fileURL(path.join(DEL, 'teacher.html')).href, sink);
    const e21 = await T.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const meta = {
        title: document.title,
        tabs: document.querySelectorAll('.tab').length,
        noStudentApi: !window.XYXT_APP && !window.XYXT_STAR,
        demoLabel: (document.querySelector('[data-tact="demo"]') || {}).textContent.trim() || ''
      };
      document.querySelector('[data-tact="demo"]').click();
      await s(750);
      return meta;
    })()`);
    const e21b = await T.eval(`(() => {
      const txt = document.body.innerText;
      const csv = document.querySelector('[data-tact="csv"]');
      return {
        students: (txt.match(/共 (\\d+) 名学生/) || [])[1] || '',
        radar: !!document.querySelector('.report-radar svg'),
        adviceTitle: /给班主任的三条建议/.test(txt),
        adviceCount: document.querySelectorAll('#tBoard .note-box p.small').length,
        csvEnabled: !!csv && !csv.disabled,
        rows: document.querySelectorAll('#tBoard table.simple tbody tr').length,
        lines: (document.getElementById('aggIn').value || '').split('\\n').filter(Boolean).length
      };
    })()`);
    check('21', '教师端「载入示例班级（12 人）」→ 学生数 12、雷达 SVG、≥3 条建议、CSV 按钮可点',
      /教师端/.test(e21.title) && e21.tabs === 0 && e21.noStudentApi && /12 人/.test(e21.demoLabel) &&
      e21b.students === '12' && e21b.radar && e21b.adviceTitle && e21b.adviceCount >= 3 &&
      e21b.csvEnabled && e21b.lines === 12,
      JSON.stringify({ meta: e21, board: e21b }));
    await T.shot('qa-v6-teacher-board');

    const e21c = await T.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const oc = HTMLAnchorElement.prototype.click, occ = URL.createObjectURL;
      let name = '', err = '';
      HTMLAnchorElement.prototype.click = function () { name = this.download || ''; };
      URL.createObjectURL = b => { window.__qaCsv = b; return 'blob:qa-csv'; };
      try { document.querySelector('[data-tact="csv"]').click(); } catch (e) { err = String(e && e.message); }
      await s(420);
      HTMLAnchorElement.prototype.click = oc;
      URL.createObjectURL = occ;
      let head = '', rows = 0;
      if (window.__qaCsv) { const t = await window.__qaCsv.text(); head = t.slice(0, 30); rows = t.split('\\r\\n').length; }
      return { name, err, head, rows };
    })()`);
    check('21b', 'CSV 点击真的触发了下载（.csv 文件名 + BOM 表头 + 13 行含表头）',
      /\.csv$/.test(e21c.name) && !e21c.err && /姓名/.test(e21c.head) && e21c.rows === 13,
      JSON.stringify(e21c));

    /* E24 解析容错 3 有效 + 2 垃圾 */
    const e24 = await T.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const codes = (document.getElementById('aggIn').value || '').split('\\n').filter(Boolean).slice(0, 3);
      const ta = document.getElementById('aggIn');
      ta.value = codes.concat(['这不是结果码', 'XYXT1-@@@@@@']).join('\\n');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await s(280);
      document.querySelector('[data-tact="aggregate"]').click();
      await s(650);
      const bad = document.getElementById('tBad');
      return {
        codes: codes.length,
        students: (document.body.innerText.match(/共 (\\d+) 名学生/) || [])[1] || '',
        badHidden: bad.hidden,
        badText: bad.textContent.trim(),
        rows: document.querySelectorAll('#tBoard table.simple tbody tr').length
      };
    })()`);
    check('24', '粘贴 3 个有效码 + 2 段垃圾：看板 3 人，并提示「无法识别」2 段',
      e24.codes === 3 && e24.students === '3' && e24.badHidden === false && /无法识别/.test(e24.badText) && /2/.test(e24.badText),
      JSON.stringify(e24));

    /* E22 刷新保留 + 清空 */
    await T.reload(1700);
    const e22 = await T.eval(`(() => ({
      value: (document.getElementById('aggIn') || {}).value || '',
      students: (document.body.innerText.match(/共 (\\d+) 名学生/) || [])[1] || '',
      radar: !!document.querySelector('.report-radar svg'),
      stored: localStorage.getItem('xyxt.teacher.v1') || ''
    }))()`);
    const e22b = await T.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-tact="clear"]').click();
      await s(520);
      const raw = localStorage.getItem('xyxt.teacher.v1');
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) {}
      return {
        rawIsEmpty: parsed ? parsed.raw === '' : raw === null,
        textarea: (document.getElementById('aggIn') || {}).value || '',
        board: !!document.querySelector('#tBoard .report-radar svg'),
        csvDisabled: (document.querySelector('[data-tact="csv"]') || {}).disabled
      };
    })()`);
    check('22', '教师端刷新：粘贴框 raw 保留 + 看板重建；清空后 xyxt.teacher.v1 的 raw 为空、CSV 置灰',
      /XYXT1-/.test(e22.value) && e22.students === '3' && e22.radar && /XYXT1-/.test(e22.stored) &&
      e22b.rawIsEmpty && e22b.textarea === '' && e22b.csvDisabled === true,
      JSON.stringify({ reload: { students: e22.students, radar: e22.radar, hasRaw: /XYXT1-/.test(e22.value) }, clear: e22b }));

    /* E23 存储隔离（逐字节） */
    const v3After = await T.eval(`localStorage.getItem('xyxt.v3') || 'NONE'`);
    const e23 = await T.eval(`(() => ({ keys: Object.keys(localStorage).sort(), coach: !!localStorage.getItem('xyxt.teacher.v1') }))()`);
    check('23', '教师端全部操作后 xyxt.v3 逐字节未变（学生数据完全隔离）',
      v3Before !== 'NONE' && v3Before === v3After && e23.coach && e23.keys.indexOf('xyxt.v3') >= 0,
      JSON.stringify({ same: v3Before === v3After, v3Bytes: v3Before.length, keys: e23.keys }));

    /* E25 交付 teacher.html 独立打开 */
    const e25 = await T.eval(`(() => {
      const links = [...document.querySelectorAll('script[src], link[rel=stylesheet]')].map(e => e.getAttribute('src') || e.getAttribute('href'));
      const abs = links.filter(u => /^[a-zA-Z]:[\\\\/]|^file:|^\\//.test(u));
      const failed = (performance.getEntriesByType('resource') || []).filter(r => typeof r.responseStatus === 'number' && r.responseStatus >= 400).map(r => r.name);
      return { links, abs, failed, url: location.href, svg: !!document.querySelector('svg'), students: (document.body.innerText.match(/共 (\\d+) 名学生/) || [])[1] || '' };
    })()`);
    check('25', '交付目录 App\\teacher.html 用 file URL 直接打开即可用（全部相对路径，无 404）',
      /App\/teacher\.html$/.test(decodeURI(e25.url)) && e25.links.length >= 2 && e25.abs.length === 0 && e25.failed.length === 0,
      JSON.stringify({ url: decodeURI(e25.url).split('/App/')[1], links: e25.links, abs: e25.abs, failed: e25.failed.length }));

    /* 教师端 390px */
    await T.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(520);
    const g30b = await T.eval(`(() => {
      const ta = document.getElementById('aggIn');
      const box = ta ? ta.getBoundingClientRect() : null;
      const row = document.querySelector('.btn-row');
      return {
        scrollW: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        taRight: box ? Math.round(box.right) : 0,
        rowRight: row ? Math.round(row.getBoundingClientRect().right) : 0
      };
    })()`);
    await T.shot('qa-v6-teacher-mobile');
    check('30b', '390×844：教师端粘贴区与按钮行都不横向溢出',
      g30b.scrollW <= g30b.vw + 1 && g30b.taRight <= g30b.vw + 1 && g30b.rowRight <= g30b.vw + 1,
      JSON.stringify(g30b));
    await T.send('Emulation.clearDeviceMetricsOverride');
    await T.kill();

    /* ================= G29 断网：无外部请求 ================= */
    group = 'G 体验与兼容';
    const external = netReqs.filter(u =>
      !/^(file:|data:|blob:|about:|devtools:)/.test(u) &&
      !/^http:\/\/127\.0\.0\.1[:/]/.test(u) &&
      !/^https?:\/\/localhost[:/]/.test(u));
    check('29', '整轮无外部网络请求（只有 file:// 与 127.0.0.1 本地服务；大模型接口未被触发）',
      external.length === 0, 'requests=' + netReqs.length + ' external=' + JSON.stringify([...new Set(external)].slice(0, 5)));

    /* ================= A2 http://127.0.0.1:8765 ================= */
    group = 'A 双协议';
    if (RUN_HTTP) {
      const H = await openTab(PORT, HTTP_BASE + '/index.html?tour=0', sink);
      try {
        const h1 = await H.eval(`(() => ({
          origin: location.origin,
          proto: location.protocol,
          tabs: document.querySelectorAll('.tab').length,
          grades: document.getElementById('pf-grade') ? document.getElementById('pf-grade').options.length : 0,
          cards: document.querySelectorAll('#view .card').length,
          star: !!window.XYXT_STAR,
          tour: document.getElementById('tourLayer') ? document.getElementById('tourLayer').hidden === false : false
        }))()`);
        const h2 = await H.eval(`(async () => {
          const s = ms => new Promise(r => setTimeout(r, ms));
          document.querySelector('.tab[data-view="test"]').click();
          await s(380);
          document.querySelector('[data-act="start-test"]').click();
          await s(420);
          for (let i = 0; i < 3; i++) {
            const b = document.querySelectorAll('#scale button');
            if (b.length < 5) break;
            b[2].click();
            await s(280);
          }
          const step = window.__qa.step();
          document.querySelector('.tab[data-view="task"]').click();
          await s(420);
          const tasks = document.querySelectorAll('[data-task]').length;
          window.XYXT_APP.go('home');
          await s(380);
          const link = document.querySelector('[data-act="open-teacher"]');
          let opened = '', err = '';
          const orig = window.open;
          window.open = u => { opened = String(u || ''); return {}; };
          try { if (link) link.click(); } catch (e) { err = String(e && e.message); }
          await s(300);
          window.open = orig;
          return { step, tasks, hasLink: !!link, opened, err, answered: Object.keys(window.XYXT_APP.state().answers).length };
        })()`);
        check('2a', 'http://127.0.0.1:8765 模式：首页/测评/任务/教师端入口都可用',
          h1.proto === 'http:' && /:8765$/.test(h1.origin) && h1.tabs === 7 && h1.grades === 11 && h1.cards >= 2 &&
          h1.star && !h1.tour && h2.answered === 3 && h2.step === '4' && h2.tasks === 14 &&
          h2.hasLink && h2.opened === 'teacher.html' && !h2.err,
          JSON.stringify({ page: h1, flow: h2 }));

        const h3 = await H.eval(`(() => {
          const res = performance.getEntriesByType('resource') || [];
          return {
            failed: res.filter(r => typeof r.responseStatus === 'number' && r.responseStatus >= 400).map(r => r.name),
            total: res.length,
            sw: !!navigator.serviceWorker
          };
        })()`);
        check('2b', 'http 模式资源全部 200（无 404），属于安全上下文（语音/剪贴板/SW 可用）',
          h3.failed.length === 0 && h3.total > 0 && h3.sw === true, JSON.stringify(h3));

        const HT = await openTab(PORT, HTTP_BASE + '/teacher.html', sink);
        const h4 = await HT.eval(`(async () => {
          const s = ms => new Promise(r => setTimeout(r, ms));
          document.querySelector('[data-tact="demo"]').click();
          await s(750);
          return {
            url: location.href,
            students: (document.body.innerText.match(/共 (\\d+) 名学生/) || [])[1] || '',
            radar: !!document.querySelector('.report-radar svg')
          };
        })()`);
        check('2c', 'http 模式教师端链接可用：示例班级出看板（12 人 + 雷达）',
          /\/teacher\.html$/.test(h4.url) && h4.students === '12' && h4.radar, JSON.stringify(h4));
        await HT.kill();
        await H.kill();
      } catch (e) {
        check('2a', 'http://127.0.0.1:8765 模式：首页/测评/任务/教师端入口都可用', false, '打开 http 页面失败：' + (e && e.message));
      }
    } else {
      check('2a', 'http://127.0.0.1:8765 模式（QA_HTTP=0 跳过）', false, 'skipped');
    }

    /* ================= G31 控制台异常 ================= */
    group = 'G 体验与兼容';
    check('31', '整轮（file:// 学生端 + 教师端 + http 模式）无未捕获异常',
      consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));

  } catch (e) {
    check('RUN', '复验脚本本身无异常中断', false, e && e.message);
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n== QA 复验：' + (results.length - failed.length) + '/' + results.length + ' 通过 ==');
  if (failed.length) console.log('未通过：' + failed.map(f => f.id).join(', '));
  fs.writeFileSync(path.join(SHOTS, 'qa-v6-report.json'), JSON.stringify(results, null, 2));

  try { S.close(); } catch (e) { /* ignore */ }
  try { chrome.kill(); } catch (e) { /* ignore */ }
  process.exit(failed.length ? 1 : 0);
})();

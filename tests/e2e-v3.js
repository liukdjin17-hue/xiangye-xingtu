/* v3 新增能力专项测试：推荐、收藏、对比、断点续做、键盘、语音命令、多意图问答、报告导出、打印、无障碍 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL: fileURL } = require('url');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9334);
// 路径相对本脚本推导，整套目录搬走后仍可直接运行
// 测试入口带上 tour=0（不弹新手引导，免得遮住被测元素）
function withTestParams(u) {
  if (!u || /[?&]tour=0/.test(u)) return u;
  const parts = u.split('#');
  const base = parts[0];
  const hash = parts[1] ? '#' + parts[1] : '';
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'tour=0' + hash;
}
const APP = withTestParams(process.env.APP_URL || fileURL(path.join(__dirname, '..', 'app', 'index.html')).href);
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
  // 每次跑用一个新的临时 profile，避免删除目录
  const profile = path.join(os.tmpdir(), 'xyxt-e2e-v3-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=900,1500',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    APP + '#home'
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
  const errors = [];

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
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map(a => a.value || a.description).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception || {}).description);
    }
  };

  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(700);

  const results = [];
  const evalIn = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  };

  /* v6 起教师端是独立页面：必须真的另开一个标签页去验证，不能靠学生端路由 */
  const TEACHER_URL = fileURL(path.join(__dirname, '..', 'app', 'teacher.html')).href;
  const openPage = async url => {
    const tgt = await new Promise((resolve, reject) => {
      const req = http.request('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad target json')); } });
      });
      req.on('error', reject);
      req.end();
    });
    const tws = new WebSocket(tgt.webSocketDebuggerUrl);
    let cid = 0;
    const cpend = new Map();
    const tsend = (m, p = {}) => new Promise((resolve, reject) => {
      const i = ++cid;
      cpend.set(i, { resolve, reject });
      tws.send(JSON.stringify({ id: i, method: m, params: p }));
    });
    tws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && cpend.has(m.id)) {
        const p = cpend.get(m.id);
        cpend.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    };
    await new Promise(r => { tws.onopen = r; });
    await tsend('Runtime.enable');
    await sleep(900);
    return {
      targetId: tgt.id,
      eval: async expr => {
        const r = await tsend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
        return r.result.value;
      },
      shot: async name => {
        try { await tsend('Page.bringToFront'); } catch (e) { /* 无头下可能不支持 */ }
        const r = await tsend('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
      },
      close: async () => { await getJSON('http://127.0.0.1:' + PORT + '/json/close/' + tgt.id).catch(() => {}); }
    };
  };

  try {
    // 0. 环境与无障碍基线
    const a11y = await evalIn(`(() => ({
      skip: !!document.querySelector('.skip'),
      tabs: document.querySelectorAll('.tab[role=tab]').length,
      selected: document.querySelectorAll('.tab[aria-selected=true]').length,
      lang: document.documentElement.lang
    }))()`);
    check('无障碍基线（跳转链接/7 个 tab/唯一选中）', a11y.skip && a11y.tabs === 7 && a11y.selected === 1 && a11y.lang === 'zh-CN', JSON.stringify(a11y));

    // 1. 样例学生 → 推荐 5 条
    const rec = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="demo-student"]').click();
      await s(400);
      const h = document.body.innerText;
      return {
        cards: document.querySelectorAll('.career').length,
        hasRec: /先看这 5 条路/.test(h),
        hasCode: /你的兴趣代码是/.test(h),
        why: [...document.querySelectorAll('.career .why')].map(e => e.textContent.slice(0, 8))
      };
    })()`);
    check('样例学生 + 个性化推荐 5 条', rec.cards === 5 && rec.hasRec && rec.hasCode, JSON.stringify(rec));
    await shot('v3-home');

    // 2. 收藏
    const fav = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const b = document.querySelector('.career [data-fav]');
      const id = b.dataset.fav;
      b.click();
      await s(150);
      const st = window.XYXT_APP.state();
      document.querySelector('.tab[data-view="map"]').click();
      await s(250);
      const chip = document.querySelector('[data-ffav]');
      chip.click();
      await s(250);
      return { saved: st.fav.indexOf(id) >= 0, favCount: st.fav.length,
               filtered: document.querySelectorAll('.career').length, chipText: chip.textContent };
    })()`);
    check('收藏并可筛选', fav.saved && fav.filtered === 1, JSON.stringify(fav));

    // 3. 对比
    const cmp = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-ffav]').click();
      await s(200);
      const btns = [...document.querySelectorAll('.career [data-cmp]')].slice(0, 2);
      btns.forEach(b => b.click());
      await s(200);
      const bar = document.getElementById('cmpbar');
      const barText = bar ? bar.innerText : '';
      const goBtn = bar && bar.querySelector('[data-act="go-compare"]');
      if (goBtn) goBtn.click();
      await s(300);
      const table = document.querySelector('table.compare');
      const heads = table ? table.querySelectorAll('thead th').length : 0;
      const rows = table ? table.querySelectorAll('tbody tr').length : 0;
      return { barText: barText.slice(0, 40), heads, rows };
    })()`);
    await shot('v3-compare');
    const cleared = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="clear-compare"]').click();
      await s(250);
      return !document.getElementById('cmpbar');
    })()`);
    check('职业对比（2 个 → 9 行对比表，可清空）', cmp.heads === 3 && cmp.rows === 9 && cleared, JSON.stringify(Object.assign({ cleared }, cmp)));

    // 4. 断点续做（真刷新）+ 键盘打分
    const partial = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="test"]').click();
      await s(200);
      /* v6.1：「重新测一次」要点两次才清空，第一次只是上膛 */
      const rt1 = document.querySelector('[data-act="retest"]');
      if (rt1) { rt1.click(); await s(150); }
      const rt2 = document.querySelector('[data-act="retest"]');
      if (rt2) rt2.click();
      await s(300);
      for (let i = 0; i < 3; i++) {
        document.querySelectorAll('#scale button')[3].click();
        await s(220);
      }
      const st = window.XYXT_APP.state();
      return { answered: Object.keys(st.answers).length, cursor: st.cursor };
    })()`);
    await send('Page.reload');
    await sleep(1200);
    const afterReload = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="home"]').click();
      await s(250);
      const homeHint = /没做完的测评/.test(document.body.innerText);
      document.querySelector('.tab[data-view="test"]').click();
      await s(300);
      const q = (document.querySelector('.qtext') || {}).textContent || '';
      const step = (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/');
      const prog = document.querySelector('.progress');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true }));
      await s(320);
      const st = window.XYXT_APP.state();
      return {
        homeHint, q: q.slice(0, 8), step,
        progNow: prog ? prog.getAttribute('aria-valuenow') : null,
        answered: Object.keys(st.answers).length
      };
    })()`);
    check('测评断点续做（刷新后停在第 4 题）', partial.answered === 3 && afterReload.homeHint && afterReload.step === '4/60', JSON.stringify(afterReload));
    check('键盘 1—5 打分', afterReload.answered === 4, JSON.stringify(afterReload));

    // 回到结果态
    const back = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="home"]').click();
      await s(200);
      document.querySelector('[data-act="demo-student"]').click();
      await s(400);
      return !!document.querySelector('.report-card');
    })()`);
    check('样例数据可反复载入', back === true, String(back));

    // 5. 文本/语音命令导航
    const nav = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="ask"]').click();
      await s(200);
      const inp = document.getElementById('chatIn');
      inp.value = '做测评';
      document.querySelector('[data-act="send"]').click();
      await s(400);
      return { hash: location.hash };
    })()`);
    check('命令式导航（“做测评” → 测评页）', nav.hash === '#test', JSON.stringify(nav));

    // 6. 多意图 + 上下文追问 + 对比问答
    const talk = await evalIn(`(() => {
      const A = window.XYXT_APP;
      const r1 = A.answer('护理和幼师哪个好');
      const r2 = A.answer('无人机飞手要考什么证');
      A.state().lastCareer = 'uav';
      const r3 = A.answer('那工资多少');
      const r4 = A.answer('我适合什么');
      return {
        compare: /【/.test(r1.text) && r1.text.length > 80,
        cert: /无人机|执照|CAAC/.test(r2.text),
        follow: /收入|万/.test(r3.text) && r3.careerId === 'uav',
        personal: /三个方向/.test(r4.text)
      };
    })()`);
    check('问答：对比 / 单职业 / 追问继承 / 个性化推荐',
      talk.compare && talk.cert && talk.follow && talk.personal, JSON.stringify(talk));

    // 7. 报告导出（拦截 blob 取回内容）
    const exportReport = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="home"]').click();
      await s(300);
      let captured = null;
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = b => { captured = b; return 'blob:mock'; };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      const btn = document.querySelector('[data-act="export-report"]');
      if (!btn) return { ok: false, reason: 'no button' };
      btn.click();
      await s(300);
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
      if (!captured) return { ok: false, reason: 'no blob' };
      const text = await captured.text();
      return { ok: true, size: text.length, hasTitle: /职业探索报告/.test(text), hasSvg: /<svg/.test(text), hasTable: /建议优先了解的方向/.test(text) };
    })()`);
    check('导出独立报告 HTML（含 SVG/表格）', exportReport.ok && exportReport.hasTitle && exportReport.hasSvg && exportReport.hasTable, JSON.stringify(exportReport));

    // 8. 打印样式：只保留报告
    await evalIn(`document.querySelector('[data-act="toggle-report"]').click()`);
    await sleep(200);
    await send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(300);
    const print = await evalIn(`(() => {
      const vis = el => el && getComputedStyle(el).display !== 'none';
      return {
        report: vis(document.querySelector('.report-card')),
        tabs: vis(document.querySelector('.tabs')),
        hero: vis(document.querySelector('.card.ink')),
        demo: vis(document.querySelector('.demo-card'))
      };
    })()`);
    await send('Emulation.setEmulatedMedia', { media: 'screen' });
    check('打印时只输出报告', print.report && !print.tabs && !print.hero && !print.demo, JSON.stringify(print));

    // 9. 教师端（独立页面 teacher.html）：示例班级 + 逗号分隔 + 班级雷达 + 建议
    const tp = await openPage(TEACHER_URL);
    await tp.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-tact="demo"]').click();
      await s(500);
      return true;
    })()`);
    await tp.shot('v3-teacher');
    const teacher = await tp.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const saved = JSON.parse(localStorage.getItem('xyxt.teacher.v1') || '{}');
      const raw = String(saved.raw || '').split('\\n').slice(0, 3).join(',') + ',这不是结果码';
      document.getElementById('aggIn').value = raw;
      document.querySelector('[data-tact="aggregate"]').click();
      await s(500);
      const txt = document.body.innerText;
      return {
        students: /共 3 名学生/.test(txt),
        advice: /给班主任的三条建议/.test(txt),
        adviceCount: document.querySelectorAll('.note-box p.small').length,
        radar: !!document.querySelector('.report-radar svg'),
        hotTable: /班级热门方向/.test(txt),
        badHint: /无法识别/.test(txt),
        pageTitle: document.title
      };
    })()`);
    await tp.close();
    check('教师端独立页面（逗号分隔解析 / 班级雷达 / 三条建议）',
      teacher.students && teacher.advice && teacher.radar && teacher.hotTable && teacher.adviceCount >= 3 && teacher.badHint,
      JSON.stringify(teacher));

    // 10. 数据备份可往返
    const backup = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="home"]').click();
      await s(250);
      let blob = null;
      const oc = URL.createObjectURL;
      URL.createObjectURL = b => { blob = b; return 'blob:mock'; };
      const acl = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      document.querySelector('[data-act="export-backup"]').click();
      await s(250);
      URL.createObjectURL = oc;
      HTMLAnchorElement.prototype.click = acl;
      const o = JSON.parse(await blob.text());
      return { keys: Object.keys(o).length, hasResult: !!o.result, hasFav: Array.isArray(o.fav) };
    })()`);
    check('本机数据备份 JSON 可解析', backup.hasResult && backup.hasFav && backup.keys > 10, JSON.stringify(backup));

    // 11. 移动端 + 对比表不溢出
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const mobile = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="map"]').click();
      await s(250);
      [...document.querySelectorAll('.career [data-cmp]')].slice(0, 2).forEach(x => x.click());
      await s(200);
      document.querySelector('#cmpbar [data-act="go-compare"]').click();
      await s(320);
      return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
    })()`);
    await shot('v3-mobile-compare');
    check('移动端对比页无横向溢出', mobile.scrollW <= mobile.innerW + 1, JSON.stringify(mobile));

    check('无未捕获脚本错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  } catch (e) {
    check('执行异常', false, e.message);
  }

  fs.writeFileSync(path.join(SHOTS, 'e2e-v3-report.json'), JSON.stringify({ results, errors }, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log('\n== ' + (failed.length ? failed.length + ' 项失败' : '全部通过') + ' / ' + results.length + ' 项 ==');
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
})();

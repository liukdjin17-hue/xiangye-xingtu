/* CDP 驱动的端到端冒烟测试：真实浏览器里点完整个流程 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL: fileURL } = require('url');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333);
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
  const profile = path.join(os.tmpdir(), 'xyxt-e2e-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=820,1400',
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
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map(a => a.value || a.description).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception || {}).description);
    }
  };

  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(600);

  const results = [];
  const evalIn = async (expr, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
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

  /* v6 起教师端是独立页面 teacher.html：另开一个标签页验证 */
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
    // 0. 首屏
    const first = await evalIn(`document.querySelectorAll('.card').length + '|' + document.title`);
    check('首屏渲染', first.split('|')[0] >= 2, first);

    // 1. 建档信息
    await evalIn(`(() => {
      const n = document.getElementById('pf-nick'); n.value = '小满';
      n.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('[data-sub="生物"]').click();
      document.querySelector('[data-sub="语文"]').click();
      return document.getElementById('pf-nick').value;
    })()`);

    // 2. 完整测评（60 题）
    const flow = await evalIn(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="go-test"]').click();
      await sleep(120);
      document.querySelector('[data-act="start-test"]').click();
      await sleep(120);
      const total = window.XYXT.ITEMS.length;
      const pattern = [1,2,3,4,5,2,3,4,5,1,3,4,5,1,2,4,5,1,2,3,5,1,2,4];
      for (let i = 0; i < total; i++) {
        const btns = [...document.querySelectorAll('#scale button')];
        if (!btns.length) return { err: 'no scale at ' + i, n: i };
        btns[(pattern[i % pattern.length] - 1)].click();
        await sleep(220);
      }
      await sleep(400);
      /* v6.1 起答完不再自动交卷：先出现「60 道题都答完了」的提交卡，按了才出结果 */
      const stopCard = !!document.getElementById('qsubmit');
      const sub = document.querySelector('[data-act="submit-test"]');
      if (sub) { sub.click(); await sleep(450); }
      const txt = document.body.innerText;
      const m = txt.match(/兴趣代码[：:]\\s*([RIASEC]{3})/);
      return {
        total,
        stopCard,
        submitted: !!sub,
        code: m ? m[1] : null,
        testing: /第 \\d+ \\/ \\d+ 题/.test(txt),
        diff: (txt.match(/分化度\\s*(\\d+)/) || [])[1],
        cons: (txt.match(/一致性\\s*([高中低])/) || [])[1]
      };
    })()`);
    check('60 题答完先停在提交卡，按提交才生成三码', !!flow.code && flow.total === 60 && flow.stopCard && flow.submitted, JSON.stringify(flow));
    check('输出分化度与一致性', !!flow.diff && !!flow.cons, 'diff=' + flow.diff + ' cons=' + flow.cons);
    await shot('e2e-result');

    // 3. 职业星图
    const map = await evalIn(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="map"]').click();
      await sleep(200);
      return { cards: document.querySelectorAll('.career').length, first: (document.querySelector('.career .name')||{}).textContent };
    })()`);
    check('职业星图 29 条', map.cards === 29, JSON.stringify(map));

    // 4. 筛选
    const filtered = await evalIn(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('[data-fl]')].find(b => b.dataset.fl === '可远程').click();
      await sleep(200);
      const c = document.querySelectorAll('.career').length;
      [...document.querySelectorAll('[data-fl]')].find(b => b.dataset.fl === 'all').click();
      await sleep(150);
      return c;
    })()`);
    check('筛选“可远程”有结果', filtered > 0 && filtered < 29, 'count=' + filtered);

    // 5. 打开职业详情
    const sheet = await evalIn(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.career').click();
      await sleep(350);
      const s = document.getElementById('sheet');
      return { on: s.classList.contains('on'), text: s.innerText.slice(0, 60), items: s.querySelectorAll('.item').length };
    })()`);
    check('职业详情抽屉', sheet.on && sheet.items === 7, JSON.stringify(sheet));
    await shot('e2e-sheet');

    // 6. 从详情进入问答
    const asked = await evalIn(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="ask-about"]').click();
      await sleep(700);
      const msgs = [...document.querySelectorAll('.msg')];
      return { count: msgs.length, last: msgs[msgs.length-1].innerText.slice(0, 50) };
    })()`);
    check('详情→问答自动提问', asked.count >= 2 && asked.last.length > 20, JSON.stringify(asked));

    // 7. 自由问答
    const chat = await evalIn(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const inp = document.getElementById('chatIn');
      inp.value = '护理在县城好找工作吗';
      document.querySelector('[data-act="send"]').click();
      await sleep(400);
      const msgs = [...document.querySelectorAll('.msg')];
      return { count: msgs.length, last: msgs[msgs.length-1].innerText.slice(0, 80) };
    })()`);
    check('问答返回本地知识库答案', chat.count >= 4 && /县/.test(chat.last), JSON.stringify(chat));
    await shot('e2e-chat');

    // 7.5 科学性页与语音入口
    const science = await evalIn(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="science"]').click();
      await sleep(200);
      const t = document.body.innerText;
      return {
        hasOrigin: /Holland|霍兰德/.test(t),
        hasRef: /参考文献/.test(t),
        hasReliability: /信度/.test(t),
        hasScoring: /标准分/.test(t)
      };
    })()`);
    check('科学性页（理论/计分/信效度/文献）',
      science.hasOrigin && science.hasRef && science.hasReliability && science.hasScoring, JSON.stringify(science));
    await shot('e2e-science');

    const voice = await evalIn(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="ask"]').click();
      await sleep(250);
      const mic = document.getElementById('micBtn');
      const hint = document.getElementById('micHint');
      return { mic: !!mic, hint: hint ? hint.textContent.slice(0, 24) : null };
    })()`);
    check('问答页有语音入口', voice.mic, JSON.stringify(voice));

    // 8. 结果码 → 教师端（独立页面）汇总
    const tp = await openPage(TEACHER_URL);
    const teacher = await tp.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-tact="demo"]').click();
      await s(500);
      const rows = document.querySelectorAll('table.simple tbody tr').length;
      const students = document.body.innerText.match(/共 (\\d+) 名学生/);
      return { rows, students: students ? Number(students[1]) : 0, tabs: document.querySelectorAll('.tab').length };
    })()`);
    await tp.shot('e2e-teacher');
    await tp.close();
    check('教师端班级看板（独立页面）', teacher.students >= 10 && teacher.rows >= 10 && teacher.tabs === 0, JSON.stringify(teacher));

    // 9. 结果码往返（教师端解析器）
    const tp2 = await openPage(TEACHER_URL);
    const round = await tp2.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-tact="demo"]').click();
      await s(500);
      const ta = document.getElementById('aggIn');
      const lines = ta.value.split('\\n').filter(Boolean);
      ta.value = lines.slice(0, 5).join('\\n');
      document.querySelector('[data-tact="aggregate"]').click();
      await s(400);
      const m = document.body.innerText.match(/共 (\\d+) 名学生/);
      return { parsed: m ? Number(m[1]) : 0, lineLen: lines[0].length };
    })()`);
    await tp2.close();
    check('结果码解析（取 5 条）', round.parsed === 5, JSON.stringify(round));

    // 10. 任务打卡（14 件，分三阶）
    const task = await evalIn(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="task"]').click();
      await sleep(200);
      const cb = document.querySelector('[data-task]');
      cb.click();
      await sleep(250);
      return {
        checked: document.querySelectorAll('[data-task]:checked').length,
        total: document.querySelectorAll('[data-task]').length,
        groups: document.querySelectorAll('.lv-head').length,
        text: (document.body.innerText.match(/完成 \\d+ \\/ \\d+ 项/) || [''])[0]
      };
    })()`);
    check('任务打卡（14 件 / 3 阶）', task.checked >= 1 && task.total === 14 && task.groups === 3, JSON.stringify(task));

    // 11. 移动端
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await evalIn(`document.querySelector('.tab[data-view="home"]').click()`);
    await sleep(400);
    const mobile = await evalIn(`(() => {
      const w = document.documentElement.scrollWidth;
      return { scrollW: w, innerW: window.innerWidth, overflow: w > window.innerWidth + 1 };
    })()`);
    check('移动端无横向溢出', !mobile.overflow, JSON.stringify(mobile));
    await shot('e2e-mobile');

    // 12. 离线能力（仅 http/https 下有意义：Service Worker）
    const sw = await evalIn(`(async () => {
      if (location.protocol === 'file:') return { skipped: true };
      if (!('serviceWorker' in navigator)) return { supported: false };
      const ready = await Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise(res => setTimeout(() => res(false), 4000))
      ]);
      const keys = window.caches ? await caches.keys() : [];
      return { ready, caches: keys, secure: window.isSecureContext };
    })()`);
    check('Service Worker 可离线（安全上下文）',
      sw.skipped || (sw.ready && sw.secure && sw.caches.length > 0), JSON.stringify(sw));

    // 13. 无 JS 错误
    check('无未捕获脚本错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
  } catch (e) {
    check('执行异常', false, e.message);
  }

  fs.writeFileSync('D:\\work\\new project\\shots\\e2e-report.json', JSON.stringify({ results, consoleErrors }, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log('\n== ' + (failed.length ? failed.length + ' 项失败' : '全部通过') + ' / ' + results.length + ' 项 ==');
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
})();

/* v6 专项：11 个年级与学段提示 → 14 件三阶任务 → 补答闸门 → 7 个入口 → 教师端独立页面 → DeepSeek → 手机尺寸 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL: fileURL } = require('url');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9347);
// tour=0：新手引导会遮住首页表单，本文件专测年级/任务/闸门/教师端，不要引导
const APP = process.env.APP_URL || (fileURL(path.join(__dirname, '..', 'app', 'index.html')).href + '?tour=0');
const TEACHER_URL = fileURL(path.join(__dirname, '..', 'app', 'teacher.html')).href;
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
  const profile = path.join(os.tmpdir(), 'xyxt-e2e-v6-' + Date.now());
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
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  };

  /* 另开一个标签页（教师端是独立页面，必须真的单独打开来验） */
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
    await tsend('Page.enable');
    await sleep(900);
    return {
      targetId: tgt.id,
      send: tsend,
      eval: async expr => {
        const r = await tsend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
        return r.result.value;
      },
      shot: async name => {
        try { await tsend('Page.bringToFront'); } catch (e) { /* 无头环境可能不支持 */ }
        const r = await tsend('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
      },
      close: async () => { await getJSON('http://127.0.0.1:' + PORT + '/json/close/' + tgt.id).catch(() => {}); }
    };
  };

  try {
    /* ---------- 1. 七个入口，没有教师端标签 ---------- */
    const tabs = await evalIn(`(() => ({
      count: document.querySelectorAll('.tab').length,
      views: [...document.querySelectorAll('.tab')].map(t => t.dataset.view),
      hasTeacher: !!document.querySelector('.tab[data-view="teacher"]')
    }))()`);
    check('学生端 7 个 tab，且没有教师端标签',
      tabs.count === 7 && !tabs.hasTeacher && tabs.views.indexOf('teacher') < 0, JSON.stringify(tabs));

    /* ---------- 2. 年级下拉：11 个，含初一与小学五年级 ---------- */
    const grades = await evalIn(`(() => {
      const sel = document.getElementById('pf-grade');
      const opts = sel ? [...sel.options].map(o => o.value) : [];
      return { count: opts.length, opts, def: window.XYXT_APP.state().profile.grade };
    })()`);
    check('年级下拉 11 项，含「初一」「小学五年级」，默认初一',
      grades.count === 11 && grades.opts.indexOf('初一') >= 0 && grades.opts.indexOf('小学五年级') >= 0 &&
      grades.opts[0] === '小学五年级' && grades.def === '初一', JSON.stringify(grades));

    /* ---------- 3. 切到小学五年级 → 小学学段文案 ---------- */
    const primary = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const sel = document.getElementById('pf-grade');
      sel.value = '小学五年级';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await s(200);
      const hint = document.querySelector('.stage-hint');
      return {
        stage: hint ? hint.dataset.stage : '',
        text: hint ? hint.textContent : '',
        extra: !!document.querySelector('.stage-extra'),
        stored: window.XYXT_APP.state().profile.grade
      };
    })()`);
    check('切到「小学五年级」出现小学学段提示（含分两次做完的提醒）',
      primary.stage === 'p' && /小学阶段/.test(primary.text) && primary.extra && primary.stored === '小学五年级',
      JSON.stringify(primary));
    await shot('v6-grade-primary');

    /* ---------- 4. 切到高三 → 高中学段文案 ---------- */
    const senior = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const sel = document.getElementById('pf-grade');
      sel.value = '高三';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await s(200);
      const hint = document.querySelector('.stage-hint');
      return {
        stage: hint ? hint.dataset.stage : '',
        text: hint ? hint.textContent : '',
        extra: !!document.querySelector('.stage-extra'),
        stored: window.XYXT_APP.state().profile.grade
      };
    })()`);
    check('切到「高三」出现高中学段提示（选科/招聘简章优先）',
      senior.stage === 's' && /高中阶段/.test(senior.text) && !senior.extra && senior.stored === '高三',
      JSON.stringify(senior));

    /* ---------- 5. 刷新后年级保持 ---------- */
    await send('Page.reload', { ignoreCache: true });
    await sleep(1400);
    const kept = await evalIn(`(() => {
      const sel = document.getElementById('pf-grade');
      return { value: sel ? sel.value : '', stored: window.XYXT_APP.state().profile.grade };
    })()`);
    check('刷新后年级保持（高三）', kept.value === '高三' && kept.stored === '高三', JSON.stringify(kept));

    /* ---------- 6. 任务页：3 个难度分组 / 14 项 / 序号 01—14 ---------- */
    const taskView = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="task"]').click();
      await s(350);
      const heads = [...document.querySelectorAll('.lv-head b')].map(b => b.textContent);
      const idx = [...document.querySelectorAll('.task .idx')].map(x => x.textContent);
      return {
        groups: document.querySelectorAll('.lv-head').length,
        heads,
        tasks: document.querySelectorAll('[data-task]').length,
        idxCount: idx.length,
        first: idx[0],
        last: idx[idx.length - 1],
        unique: new Set(idx).size
      };
    })()`);
    check('任务页 3 个难度分组、14 项、序号 01—14',
      taskView.groups === 3 && taskView.tasks === 14 && taskView.idxCount === 14 &&
      taskView.first === '01' && taskView.last === '14' && taskView.unique === 14 &&
      /第 1 阶/.test(taskView.heads[0]) && /第 3 阶/.test(taskView.heads[2]),
      JSON.stringify(taskView));
    await shot('v6-tasks');

    /* ---------- 7. 初中学段：不适配的项被压暗并标出适用学段 ---------- */
    const dimJunior = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const st = window.XYXT_APP.state();
      st.profile.grade = '初二';
      window.XYXT_APP.save();
      document.querySelector('.tab[data-view="home"]').click();
      await s(200);
      document.querySelector('.tab[data-view="task"]').click();
      await s(250);
      return {
        dim: document.querySelectorAll('.task.dim').length,
        stag: document.querySelectorAll('.task .stag').length,
        total: document.querySelectorAll('.task').length,
        stagText: (document.querySelector('.task .stag') || {}).textContent || ''
      };
    })()`);
    check('初中学段下 3 项标「适用：高中/中职」并压暗',
      dimJunior.dim === 3 && dimJunior.stag === 3 && dimJunior.total === 14 && /适用：/.test(dimJunior.stagText),
      JSON.stringify(dimJunior));

    /* ---------- 8. 小学学段：dim 数量 = 9（14 − 5） ---------- */
    const dimPrimary = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const st = window.XYXT_APP.state();
      st.profile.grade = '小学五年级';
      window.XYXT_APP.save();
      document.querySelector('.tab[data-view="home"]').click();
      await s(200);
      document.querySelector('.tab[data-view="task"]').click();
      await s(250);
      return {
        dim: document.querySelectorAll('.task.dim').length,
        fit: document.querySelectorAll('.task:not(.dim)').length,
        total: document.querySelectorAll('.task').length
      };
    })()`);
    check('小学学段下只有 5 项适配（dim 9 项）',
      dimPrimary.dim >= 8 && dimPrimary.dim === 9 && dimPrimary.fit === 5, JSON.stringify(dimPrimary));

    /* ---------- 9. 闸门：全程答完但跳过第 1 题与第 59 题 → 答完第 60 题出现 #qgate ---------- */
    const gate1 = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="test"]').click();
      await s(250);
      document.querySelector('[data-act="start-test"]').click();
      await s(300);
      for (let i = 0; i < 60; i++) {
        if (i === 0 || i === 58) {
          document.querySelector('[data-act="skip-q"]').click();
        } else {
          const btns = [...document.querySelectorAll('#scale button')];
          if (!btns.length) break;
          btns[2].click();
        }
        await s(250);
      }
      await s(600);
      const gate = document.getElementById('qgate');
      const st = window.XYXT_APP.state();
      return {
        answered: Object.keys(st.answers).length,
        gate: !!gate,
        gateText: gate ? gate.innerText.replace(/\\n+/g, ' ').slice(0, 40) : '',
        chips: gate ? gate.querySelectorAll('.gate-jump [data-jump]').length : 0,
        chipText: gate ? [...gate.querySelectorAll('.gate-jump [data-jump]')].map(b => b.textContent.trim()).join('|') : '',
        result: !!st.result,
        testing: st.testing
      };
    })()`);
    check('答完第 60 题但还有 2 道跳过的题 → 出现闸门，不自动交卷',
      gate1.answered === 58 && gate1.gate && /还有 2 道题没答/.test(gate1.gateText) &&
      gate1.chips === 2 && /第 1 题/.test(gate1.chipText) && !gate1.result && gate1.testing,
      JSON.stringify(gate1));
    await shot('v6-gate');

    /* ---------- 10. 闸门「补答这 N 题」跳到第一道未答的题 ---------- */
    const gateFill = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const btn = document.querySelector('[data-act="gate-fill"]');
      const label = btn ? btn.textContent.trim() : '';
      if (btn) btn.click();
      await s(450);
      const st = window.XYXT_APP.state();
      return {
        label,
        cursor: st.cursor,
        gate: !!document.getElementById('qgate'),
        step: (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/')
      };
    })()`);
    check('闸门「补答这 N 题」跳到第一道未答的题',
      /补答这 2 题/.test(gateFill.label) && gateFill.cursor === 0 && !gateFill.gate && gateFill.step === '1/60',
      JSON.stringify(gateFill));

    /* ---------- 11. 全部答完：不自动交卷，停在提交卡；按提交才出结果 ---------- */
    const allDone = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      let clicks = 0;
      for (let i = 0; i < 62; i++) {
        const btns = [...document.querySelectorAll('#scale button')];
        if (!btns.length) break;
        btns[(i % 5)].click();
        clicks++;
        await s(250);
        if (!document.querySelector('#scale button')) break;
      }
      await s(500);
      const st = window.XYXT_APP.state();
      const card = document.getElementById('qsubmit');
      const btn = document.querySelector('[data-act="submit-test"]');
      return {
        clicks,
        result: !!st.result,
        answered: Object.keys(st.answers).length,
        stopCard: !!card,
        cardText: card ? card.innerText.replace(/\\n+/g, ' ').slice(0, 30) : '',
        submitBtn: btn ? btn.textContent.trim() : '',
        reviewBtn: !!document.querySelector('[data-act="review-all"]'),
        gate: !!document.getElementById('qgate'),
        warn: !!document.querySelector('.warn-note'),
        step: (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/')
      };
    })()`);
    check('全部答完停在「都答完了」提交卡，未自动交卷',
      !allDone.result && allDone.stopCard && !!allDone.submitBtn && allDone.reviewBtn &&
      !allDone.gate && !allDone.warn && allDone.step === '60/60',
      JSON.stringify(allDone));
    await shot('v6-submit-card');

    const afterSubmit = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="submit-test"]').click();
      await s(600);
      const st = window.XYXT_APP.state();
      return {
        result: !!st.result,
        answered: st.result ? st.result.answered : 0,
        code: st.result ? st.result.code : '',
        warn: !!document.querySelector('.warn-note'),
        card: !!document.getElementById('qsubmit'),
        testing: st.testing
      };
    })()`);
    check('按「提交并生成我的星图」后出结果，60 题全计分、无未答提示',
      afterSubmit.result && afterSubmit.answered === 60 && !afterSubmit.warn &&
      !afterSubmit.card && !afterSubmit.testing && /^[RIASEC]{3}$/.test(afterSubmit.code),
      JSON.stringify(afterSubmit));
    await shot('v6-result');

    /* ---------- 12. 「就这样生成结果」→ 结果页带未答提示 + 「去补答」 ---------- */
    const submitted = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      /* v6.1：「重新测一次」要点两次，第一次只上膛 */
      const rt1 = document.querySelector('[data-act="retest"]');
      if (rt1) { rt1.click(); await s(150); }
      const rt2 = document.querySelector('[data-act="retest"]');
      if (rt2) rt2.click();
      await s(350);
      for (let i = 0; i < 60; i++) {
        if (i === 0 || i === 58) {
          document.querySelector('[data-act="skip-q"]').click();
        } else {
          const btns = [...document.querySelectorAll('#scale button')];
          if (!btns.length) break;
          btns[1].click();
        }
        await s(250);
      }
      await s(600);
      const hadGate = !!document.getElementById('qgate');
      document.querySelector('[data-act="gate-submit"]').click();
      await s(600);
      const st = window.XYXT_APP.state();
      return {
        hadGate,
        result: !!st.result,
        answered: st.result ? st.result.answered : 0,
        warn: !!document.querySelector('.warn-note'),
        warnText: (document.querySelector('.warn-note') || {}).textContent || '',
        fixBtn: !!document.querySelector('[data-act="fix-blank"]'),
        gate: !!document.getElementById('qgate')
      };
    })()`);
    check('闸门「就这样生成结果」能出结果，并给未答提示与「去补答」入口',
      submitted.hadGate && submitted.result && submitted.answered === 58 &&
      submitted.warn && /2 道题/.test(submitted.warnText) && submitted.fixBtn && !submitted.gate,
      JSON.stringify(submitted));

    /* ---------- 13. 结果页「去补答」回到第 1 题 ---------- */
    const fixed = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="fix-blank"]').click();
      await s(450);
      const st = window.XYXT_APP.state();
      return {
        testing: st.testing,
        cursor: st.cursor,
        gate: !!document.getElementById('qgate'),
        step: (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/')
      };
    })()`);
    check('结果页「去补答」跳回第一道未答的题',
      fixed.testing && fixed.cursor === 0 && !fixed.gate && fixed.step === '1/60', JSON.stringify(fixed));

    /* ---------- 14. ?v=8 资源都加载成功、没有 404 ---------- */
    const assets = await evalIn(`(() => {
      const urls = [...document.querySelectorAll('script[src],link[rel=stylesheet]')].map(e => e.src || e.href);
      const notV8 = urls.filter(u => !/\\?v=8/.test(u));
      const res = performance.getEntriesByType('resource') || [];
      const failed = res.filter(r => typeof r.responseStatus === 'number' && r.responseStatus >= 400).map(r => r.name);
      return {
        notV8,
        failed,
        globals: [typeof window.XYXT, typeof window.XYXT_APP, typeof window.XYXT_STAR, typeof window.XYXT_TOUR].join(','),
        sheets: document.styleSheets.length
      };
    })()`);
    check('?v=8 资源全部加载，无 404（应用脚本与样式都在）',
      assets.notV8.length === 0 && assets.failed.length === 0 &&
      assets.globals === 'object,object,object,object' && assets.sheets >= 1, JSON.stringify(assets));

    /* ---------- 15. 小星星：教师端在哪 → 命中新条目并带跳转动作 ---------- */
    const starTeacher = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.getElementById('starFab').click();
      await s(400);
      window.XYXT_STAR.ask('教师端在哪');
      await s(800);
      const msgs = [...document.querySelectorAll('#starLog .star-msg')];
      const last = msgs[msgs.length - 1];
      const btn = last ? last.querySelector('[data-star-act]') : null;
      return {
        text: last ? last.innerText.slice(0, 60) : '',
        hit: last ? /teacher\\.html|独立页面/.test(last.innerText) : false,
        label: btn ? btn.textContent.trim() : ''
      };
    })()`);
    check('小星星答「教师端在哪」命中新条目并给出「打开教师端」动作',
      starTeacher.hit && /教师端/.test(starTeacher.label), JSON.stringify(starTeacher));

    const starTeacherClick = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const btns = [...document.querySelectorAll('#starLog [data-star-act]')];
      const btn = btns[btns.length - 1];
      const orig = window.open;
      let opened = '';
      window.open = function (u) { opened = String(u || ''); return {}; };
      let err = '';
      try { if (btn) btn.click(); } catch (e) { err = String(e && e.message); }
      await s(400);
      window.open = orig;
      return {
        opened,
        err,
        closed: document.getElementById('starPanel').hidden,
        hash: location.hash
      };
    })()`);
    check('点「打开教师端」动作会去 teacher.html 且不报错',
      /teacher\.html/.test(starTeacherClick.opened) && !starTeacherClick.err && starTeacherClick.closed &&
      starTeacherClick.hash !== '#teacher', JSON.stringify(starTeacherClick));

    /* ---------- 16. 小星星：怎么接 deepseek → 命中 DeepSeek 条目 ---------- */
    const starDeepseek = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.getElementById('starFab').click();
      await s(300);
      window.XYXT_STAR.ask('怎么接 deepseek');
      await s(800);
      const msgs = [...document.querySelectorAll('#starLog .star-msg')];
      const last = msgs[msgs.length - 1];
      const btn = last ? last.querySelector('[data-star-act]') : null;
      return {
        text: last ? last.innerText.slice(0, 120) : '',
        hasUrl: last ? /api\\.deepseek\\.com/.test(last.innerText) : false,
        hasModel: last ? /deepseek-chat/.test(last.innerText) : false,
        label: btn ? btn.textContent.trim() : ''
      };
    })()`);
    check('小星星答「怎么接 deepseek」命中 DeepSeek 条目（地址 + 模型 + 设置入口）',
      starDeepseek.hasUrl && starDeepseek.hasModel && /设置/.test(starDeepseek.label), JSON.stringify(starDeepseek));

    /* ---------- 17. 设置里「一键填入 DeepSeek」 ---------- */
    const deepseekBtn = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      if (!document.getElementById('starPanel').hidden) document.querySelector('[data-star="close"]').click();
      await s(250);
      document.getElementById('btnUser').click();
      await s(320);
      document.querySelector('#sheet [data-set="star"]').click();
      await s(320);
      const hasBtn = !!document.querySelector('#sheet [data-act="set-star-deepseek"]');
      const docs = /platform\\.deepseek\\.com/.test(document.getElementById('sheet').innerText);
      document.querySelector('#sheet [data-act="set-star-deepseek"]').click();
      await s(350);
      const cfg = window.XYXT_STAR.config();
      const out = {
        hasBtn,
        docs,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        baseInput: (document.getElementById('starBase') || {}).value || '',
        modelInput: (document.getElementById('starModel') || {}).value || ''
      };
      const closeBtn = document.querySelector('#sheet [data-act="close-sheet"]');
      if (closeBtn) closeBtn.click();
      await s(200);
      return out;
    })()`);
    check('「一键填入 DeepSeek」写入 baseUrl / model，并说明去哪申请 Key',
      deepseekBtn.hasBtn && deepseekBtn.docs &&
      deepseekBtn.baseUrl === 'https://api.deepseek.com/v1' && deepseekBtn.model === 'deepseek-chat' &&
      deepseekBtn.baseInput === 'https://api.deepseek.com/v1', JSON.stringify(deepseekBtn));

    /* ---------- 18. 教师端独立页面：示例班级 / 雷达 / 三条建议 / CSV ---------- */
    const beforeV3 = await evalIn(`localStorage.getItem('xyxt.v3') || ''`);
    const tp = await openPage(TEACHER_URL);
    const teacher = await tp.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const doc = document.title;
      const noTabs = document.querySelectorAll('.tab').length;
      const noStar = !window.XYXT_STAR && !window.XYXT_APP;
      document.querySelector('[data-tact="demo"]').click();
      await s(600);
      const txt = document.body.innerText;
      const csv = document.querySelector('[data-tact="csv"]');
      return {
        doc,
        noTabs,
        noStar,
        students: (txt.match(/共 (\\d+) 名学生/) || [])[1],
        radar: !!document.querySelector('.report-radar svg'),
        advice: /给班主任的三条建议/.test(txt),
        adviceCount: document.querySelectorAll('.note-box > p.small').length,
        csvEnabled: !!csv && !csv.disabled,
        privacy: /不含学号、手机号/.test(txt),
        textarea: (document.getElementById('aggIn') || {}).value ? document.getElementById('aggIn').value.split('\\n').length : 0
      };
    })()`);
    await tp.shot('v6-teacher');
    check('教师端独立页面：示例班级看板 / 雷达 / 三条建议 / CSV 可用',
      /教师端/.test(teacher.doc) && teacher.noTabs === 0 && teacher.noStar &&
      Number(teacher.students) >= 10 && teacher.radar && teacher.advice &&
      teacher.adviceCount >= 3 && teacher.csvEnabled && teacher.privacy && teacher.textarea >= 10,
      JSON.stringify(teacher));

    /* ---------- 19. 教师端只写自己的键，且不碰 xyxt.v3 ---------- */
    const keys = await tp.eval(`(() => ({
      keys: Object.keys(localStorage).sort(),
      v3: localStorage.getItem('xyxt.v3'),
      coach: !!localStorage.getItem('xyxt.teacher.v1')
    }))()`);
    // file:// 下各页面共享同一份 localStorage：教师端绝不能新建或改写 xyxt.v3
    const v3Untouched = keys.v3 === null || keys.v3 === beforeV3;
    check('教师端只写 xyxt.teacher.v1，不新建也不改写学生数据 xyxt.v3',
      keys.coach && keys.keys.indexOf('xyxt.teacher.v1') >= 0 && v3Untouched,
      JSON.stringify({ keys: keys.keys, v3Untouched }));

    /* ---------- 20. 教师端刷新后粘贴框内容还在（只靠 xyxt.teacher.v1） ---------- */
    await tp.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const ta = document.getElementById('aggIn');
      ta.value = 'XYXT1-abc,这不是结果码';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await s(250);
      return true;
    })()`);
    await tp.send('Page.reload', { ignoreCache: true });
    await sleep(1500);
    const reloadT = await tp.eval(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      await s(300);
      return {
        value: (document.getElementById('aggIn') || {}).value || '',
        bad: (document.getElementById('tBad') || {}).hidden === false
      };
    })()`);
    await tp.close();
    check('教师端刷新后粘贴框内容还在（只靠 xyxt.teacher.v1）',
      /这不是结果码/.test(reloadT.value) && reloadT.bad, JSON.stringify(reloadT));

    /* ---------- 21. 390px：任务页与闸门卡片不横向溢出 ---------- */
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(500);
    const mTask = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="task"]').click();
      await s(400);
      return { scrollW: document.documentElement.scrollWidth, vw: window.innerWidth, tasks: document.querySelectorAll('.task').length };
    })()`);
    await shot('v6-mobile-task');
    const mGate = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="test"]').click();
      await s(300);
      if (document.getElementById('sheet') && document.getElementById('sheet').classList.contains('on')) {
        document.querySelector('#sheet [data-act="close-sheet"]').click();
        await s(250);
      }
      document.querySelector('[data-jump="59"]').click();
      await s(300);
      document.querySelectorAll('#scale button')[2].click();
      await s(600);
      const g = document.getElementById('qgate');
      const box = g ? g.getBoundingClientRect() : null;
      return {
        gate: !!g,
        right: box ? Math.round(box.right) : 0,
        scrollW: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        gateScroll: g ? g.scrollWidth <= g.clientWidth + 1 : false
      };
    })()`);
    await shot('v6-mobile-gate');
    check('390px：任务页与闸门卡片都无横向溢出',
      mTask.scrollW <= mTask.vw + 1 && mTask.tasks === 14 &&
      mGate.gate && mGate.right <= mGate.vw + 1 && mGate.scrollW <= mGate.vw + 1 && mGate.gateScroll,
      JSON.stringify({ mTask, mGate }));
    await send('Emulation.clearDeviceMetricsOverride');

    /* ---------- 22. 隐藏路由 #teacher 不白屏 ---------- */
    await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      location.hash = '#teacher';
      await s(400);
      return true;
    })()`);
    const badHash = await evalIn(`({
      cards: document.querySelectorAll('#view .card').length,
      tab: document.querySelector('.tab.active') ? document.querySelector('.tab.active').dataset.view : '',
      hash: location.hash
    })`);
    check('地址栏残留 #teacher 时落到首页而不是白屏',
      badHash.cards > 0 && badHash.tab === 'home', JSON.stringify(badHash));

    /* ---------- 23. 无未捕获脚本错误 ---------- */
    check('无未捕获脚本错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

  } catch (e) {
    check('执行过程无异常', false, e.message);
  }

  const passed = results.filter(r => r.ok).length;
  console.log('\n' + passed + '/' + results.length + ' passed');
  fs.writeFileSync(path.join(SHOTS, 'e2e-v6-report.json'), JSON.stringify(results, null, 2));

  ws.close();
  chrome.kill();
  process.exit(passed === results.length ? 0 : 1);
})();

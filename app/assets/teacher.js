/* 乡野星图 · 教师端 v6
 * ─────────────────────────────────────────────────────────────
 * 为什么单独一页：教师端本来就只需要「粘贴结果码 → 看班级画像」，放在学生端里
 * 既占顶部标签、又容易让学生误点。拆成 teacher.html 后，学生端只有七个入口，
 * 教师端可以单独发给老师（也可以单独部署），两边数据完全不互通。
 *
 * 数据：只读写 localStorage['xyxt.teacher.v1'] = { raw }。
 *      绝不读 xyxt.v3（学生数据），教师端写不进学生任何东西。
 * 不依赖 app.js / star.js / tour.js，只依赖 assets/data.js（六维与职业库）。
 */
(function () {
  'use strict';

  const DATA = window.XYXT || {};
  const DIMS = DATA.DIMS || [];
  const CAREERS = DATA.CAREERS || [];
  const CAREER_MAP = {};
  CAREERS.forEach(c => { CAREER_MAP[c.id] = c; });

  const KEY = 'xyxt.teacher.v1';
  const DEMO_N = 12;

  /* ---------------- 状态 ---------------- */
  let raw = '';
  let students = [];
  let badCount = 0;
  let hasAgg = false;

  function loadState() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
      raw = typeof o.raw === 'string' ? o.raw : '';
    } catch (e) {
      raw = '';
    }
  }

  function saveState() {
    try { localStorage.setItem(KEY, JSON.stringify({ raw })); return true; } catch (e) { return false; }
  }

  /* ---------------- 工具 ---------------- */
  const $ = sel => document.querySelector(sel);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2800);
  }

  function b64enc(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/=+$/, '');
  }

  function b64dec(str) {
    let s = String(str).trim().replace(/[^A-Za-z0-9+/=]/g, '');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------------- 结果码解析（与 v5 学生端算法一致，未改动） ---------------- */
  function unpack(o) {
    const pct = {};
    const p = String(o.p || '');
    DIMS.forEach((d, i) => {
      const v = parseInt(p.substr(i * 2, 2), 10);
      pct[d.key] = isNaN(v) ? 0 : v;
    });
    const top = (o.t || []).map(id => (CAREER_MAP[id] || {}).name).filter(Boolean);
    return { n: o.n || '—', g: o.g || '—', code: o.c || '', pct, top, d: o.d || 0 };
  }

  function parseCodes(text) {
    const list = [];
    let bad = 0;
    String(text).split(/[\s,;，；]+/).forEach(tok => {
      const t = tok.trim().replace(/^XYXT1-/, '');
      if (!t) return;
      try {
        const o = b64dec(t);
        if (o && o.c) list.push(unpack(o)); else bad += 1;
      } catch (e) { bad += 1; }
    });
    return { students: list, bad };
  }

  function demoStudents(n) {
    const names = ['小满', '阿禾', '石头', '春生', '佳佳', '阿泽', '小雨', '冬梅', '阿凯', '婷婷', '楠楠', '腊梅', '大山', '阿依'];
    const codes = ['SIE', 'RIC', 'ASE', 'IRC', 'ECS', 'SAC', 'RAE', 'CSR', 'IEA', 'SER', 'CRA', 'EIS'];
    const out = [];
    for (let i = 0; i < n; i++) {
      const code = codes[i % codes.length];
      const pct = {};
      DIMS.forEach(d => { pct[d.key] = 28 + Math.floor(Math.random() * 42); });
      code.split('').forEach((L, k) => { pct[L] = 74 + (2 - k) * 7; });
      const pool = CAREERS.filter(c => c.code.indexOf(code[0]) >= 0);
      const topIds = (pool.length ? pool : CAREERS).slice(0, 3).map(c => c.id);
      const packed = {
        n: names[i % names.length],
        g: '高一',
        c: code,
        p: DIMS.map(d => String(pct[d.key]).padStart(2, '0')).join(''),
        t: topIds,
        d: Math.floor(Math.random() * 7)
      };
      const st = unpack(packed);
      st._code = 'XYXT1-' + b64enc(packed);
      out.push(st);
    }
    return out;
  }

  function exportCsv(list) {
    const rows = [['姓名', '年级', '兴趣代码', '建议方向', '已完成任务数']];
    list.forEach(s => rows.push([s.n, s.g, s.code, (s.top || []).join(' / '), s.d || 0]));
    const csv = '\ufeff' + rows.map(r => r.map(x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    download('乡野星图-班级汇总-' + new Date().toISOString().slice(0, 10) + '.csv', csv, 'text/csv;charset=utf-8');
    toast('CSV 已导出');
  }

  /* ---------------- 雷达图（SVG，与 v5 学生端同一份实现） ---------------- */
  function radarSVG(pct, size) {
    const s0 = size || 260;
    const cx = s0 / 2, cy = s0 / 2, R = s0 * 0.33;
    const n = DIMS.length;
    const ang = i => -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const pt = (i, k) => [cx + Math.cos(ang(i)) * R * k, cy + Math.sin(ang(i)) * R * k];

    let s = `<svg class="radar-svg" viewBox="0 0 ${s0} ${s0}" width="${s0}" height="${s0}" role="img" aria-label="六维兴趣雷达图">`;
    [0.25, 0.5, 0.75, 1].forEach(k => {
      const pts = DIMS.map((d, i) => pt(i, k).join(',')).join(' ');
      s += `<polygon points="${pts}" fill="none" stroke="${k === 1 ? '#ded3c0' : '#f0e9dc'}" stroke-width="1"/>`;
    });
    DIMS.forEach((d, i) => {
      const p = pt(i, 1);
      s += `<line x1="${cx}" y1="${cy}" x2="${p[0]}" y2="${p[1]}" stroke="#f0e9dc"/>`;
    });
    const area = DIMS.map((d, i) => pt(i, Math.max(0.02, (pct[d.key] || 0) / 100)).join(',')).join(' ');
    s += `<polygon points="${area}" fill="rgba(194,103,15,.22)" stroke="#c2670f" stroke-width="1.8"/>`;
    DIMS.forEach((d, i) => {
      const p = pt(i, Math.max(0.02, (pct[d.key] || 0) / 100));
      s += `<circle cx="${p[0]}" cy="${p[1]}" r="2.8" fill="#10312f"/>`;
    });
    DIMS.forEach((d, i) => {
      const p = pt(i, 1.2);
      s += `<text x="${p[0]}" y="${p[1]}" text-anchor="middle" dominant-baseline="middle" font-size="11.5" fill="#4d5a68">${esc(d.short)}</text>`;
    });
    return s + '</svg>';
  }

  /* ---------------- 班级解读 ---------------- */
  const SUG = {
    R: '动手类活动（参观车间、农机、无人机作业）',
    I: '研究与实验类活动（数据小课题、理化生实验）',
    A: '创作类活动（短视频、海报、校园刊物）',
    S: '助人类体验（志愿服务、心理互助、护老）',
    E: '组织与经营类活动（校园市集、社团带领）',
    C: '条理类训练（表格与账目、资料归档）'
  };

  /* 固定给三条：第一条看集中，第二条看盲区（或均衡），第三条给家长会用法 */
  function classInsight(dimCount, total) {
    const tips = [];
    const sorted = DIMS.slice().sort((a, b) => dimCount[b.key] - dimCount[a.key]);
    const top = sorted[0];
    const low = sorted[sorted.length - 1];
    const share = k => Math.round((dimCount[k] / Math.max(1, total)) * 100);

    if (top) {
      tips.push('班里 <b>' + top.name + '</b> 最集中（' + share(top.key) + '% 的学生以它为首选），建议优先安排：' + SUG[top.key] + '。');
    } else {
      tips.push('这批结果里没有明显的集中维度，说明班级兴趣比较分散，适合按小组分别安排活动。');
    }

    if (low && dimCount[low.key] <= Math.max(1, Math.round(total * 0.1))) {
      tips.push('<b>' + low.name + '</b> 明显偏少（' + share(low.key) + '%），这是班级的认知盲区，值得补一次：' + SUG[low.key] + '。');
    } else if (low) {
      tips.push('六个维度分布比较均衡（最低的 <b>' + low.name + '</b> 也有 ' + share(low.key) + '%），不用刻意补短板，可以按兴趣分组做项目，让不同倾向的学生各自有活干。');
    }

    tips.push('家长会可以直接用本页的兴趣结构图说明“孩子适合什么”，避免只谈分数。');
    return tips;
  }

  function aggView(list) {
    const dimCount = {}, careerCount = {}, avg = {};
    DIMS.forEach(d => { dimCount[d.key] = 0; avg[d.key] = 0; });
    list.forEach(s => {
      if (s.code) s.code.split('').forEach(L => { if (dimCount[L] != null) dimCount[L] += 1; });
      (s.top || []).forEach(n => { careerCount[n] = (careerCount[n] || 0) + 1; });
      DIMS.forEach(d => { avg[d.key] += (s.pct && s.pct[d.key]) || 0; });
    });
    const total = list.length || 1;
    DIMS.forEach(d => { avg[d.key] = Math.round(avg[d.key] / total); });

    const maxDim = Math.max(1, ...DIMS.map(d => dimCount[d.key]));
    const hot = Object.keys(careerCount).sort((a, b) => careerCount[b] - careerCount[a]).slice(0, 5);
    const insights = classInsight(dimCount, total);

    return `
      <div class="card">
        <div class="eyebrow">班级看板</div>
        <h2>共 ${list.length} 名学生</h2>
        <div class="stat-row" style="margin:12px 0 16px">
          ${DIMS.slice(0, 4).map(d => `<div class="stat"><div class="n">${dimCount[d.key]}</div><div class="l">${d.name}为首选</div></div>`).join('')}
        </div>
        <div class="report-top">
          <div class="report-radar">${radarSVG(avg, 220)}</div>
          <div>
            <h4>兴趣结构（三码命中次数）</h4>
            <p class="small muted" style="margin:0 0 6px">每人有 3 个兴趣代码，因此合计会大于人数；上方数字是“以它为首选”的人数。</p>
            <div class="bars" style="margin:10px 0 16px">
              ${DIMS.map(d => `<div class="bar"><span class="t">${d.name}</span><span class="track"><i style="width:${(dimCount[d.key] / maxDim) * 100}%;background:${d.color}"></i></span><span class="v">${dimCount[d.key]}</span></div>`).join('')}
            </div>
          </div>
        </div>
        <h4>班级热门方向</h4>
        <table class="simple">
          <thead><tr><th>职业</th><th>关注人数</th></tr></thead>
          <tbody>${hot.map(n => `<tr><td>${esc(n)}</td><td>${careerCount[n]}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">暂无</td></tr>'}</tbody>
        </table>
        <h4 style="margin-top:16px">学生名单</h4>
        <div class="table-scroll">
          <table class="simple">
            <thead><tr><th>姓名</th><th>年级</th><th>兴趣代码</th><th>首选方向</th></tr></thead>
            <tbody>${list.map(s => `<tr><td>${esc(s.n || '—')}</td><td>${esc(s.g || '—')}</td><td>${esc(s.code || '—')}</td><td>${esc((s.top || []).slice(0, 2).join('、') || '—')}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="note-box" style="margin-top:16px">
          <h4>给班主任的三条建议</h4>
          ${insights.map(t => `<p class="small">· ${t}</p>`).join('')}
        </div>
        <p class="muted" style="margin-top:12px">说明：结果码只包含昵称、年级、兴趣代码与建议方向，不含学号、手机号等个人信息；解码与统计全部在本机完成。</p>
      </div>`;
  }

  /* ---------------- 渲染 ---------------- */
  function paint() {
    const ta = $('#aggIn');
    if (ta && ta.value !== raw) ta.value = raw;

    const bad = $('#tBad');
    if (bad) {
      if (badCount > 0) {
        bad.hidden = false;
        bad.textContent = '有 ' + badCount + ' 段内容无法识别，已跳过（请确认是学生点“复制结果码”得到的完整字符串）。';
      } else {
        bad.hidden = true;
        bad.textContent = '';
      }
    }

    const csvBtn = document.querySelector('[data-tact="csv"]');
    if (csvBtn) csvBtn.disabled = !hasAgg;

    const board = $('#tBoard');
    if (board) {
      board.innerHTML = hasAgg
        ? aggView(students)
        : `<div class="card tight">
            <h4>这个看板能帮老师做什么</h4>
            <p class="muted">· 一节课后就知道班里学生兴趣集中在哪、缺哪；<br>· 家长会上能用数据说明“孩子适合什么”，而不是凭印象；<br>· 排生涯课、请行业讲师、组织参观时，有依据。</p>
            <p class="small muted">没有学生结果码？点「载入示例班级（12 人）」可以先看效果。</p>
          </div>`;
    }
  }

  function applyRaw(text) {
    raw = text;
    const parsed = parseCodes(raw);
    students = parsed.students;
    badCount = parsed.bad;
    hasAgg = students.length > 0;
    saveState();
    paint();
    return parsed;
  }

  function build() {
    const view = $('#tview');
    if (!view) return;
    view.innerHTML = `
      <div class="card">
        <div class="eyebrow">教师端 · 无服务器汇总</div>
        <h2>一个班，一张生涯画像</h2>
        <p class="lead">学生做完测评，点“复制结果码”把一串字符发给你；你把全班的结果码粘到下面，就能看到班级兴趣分布、雷达图和三条教学建议。不需要注册、不需要联网、不需要学生填表。</p>
        <div class="field" style="margin-top:14px">
          <label for="aggIn">粘贴学生结果码（每行一个，也支持整段粘贴或导入 txt / csv 文件）</label>
          <textarea class="code-area" id="aggIn" placeholder="XYXT1-xxxxxx&#10;XYXT1-yyyyyy">${esc(raw)}</textarea>
        </div>
        <p class="small muted" id="tBad" hidden></p>
        <div class="btn-row">
          <button class="btn primary" data-tact="aggregate">生成班级看板</button>
          <button class="btn" data-tact="demo">载入示例班级（${DEMO_N} 人）</button>
          <button class="btn" data-tact="import">导入文件</button>
          <button class="btn" data-tact="csv" disabled>导出 CSV</button>
          <button class="btn danger" data-tact="clear">清空</button>
        </div>
        <input type="file" id="tCodesFile" accept=".txt,.csv,text/plain" hidden>
      </div>
      <div id="tBoard"></div>
      <div class="card tight">
        <h4>隐私说明</h4>
        <p class="muted">· 结果码里只有昵称、年级、兴趣代码与建议方向，<b>不含学号、手机号</b>；<br>· 粘贴与解码全部在这台电脑上完成，没有任何上传；<br>· 未经学生同意，请不要把学生姓名连同结果一起外传（导出 CSV 前先确认用途）。</p>
        <p class="small muted">教师端只存自己这一份粘贴记录（本机 localStorage 的 <code>xyxt.teacher.v1</code>），读不到学生端的任何数据。</p>
      </div>`;

    const ta = $('#aggIn');
    if (ta) ta.addEventListener('input', () => { raw = ta.value; saveState(); });

    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-tact]');
      if (!btn) return;
      const act = btn.dataset.tact;
      if (act === 'aggregate') {
        const ta2 = $('#aggIn');
        const parsed = applyRaw(ta2 ? ta2.value : raw);
        if (!parsed.students.length) { toast('没有识别到有效的结果码'); return; }
        toast('已汇总 ' + parsed.students.length + ' 名学生' + (parsed.bad ? '，另有 ' + parsed.bad + ' 段无法识别' : ''));
      } else if (act === 'demo') {
        const demo = demoStudents(DEMO_N);
        applyRaw(demo.map(s => s._code).join('\n'));
        toast('已载入示例班级（演示数据）');
      } else if (act === 'import') {
        const inp = $('#tCodesFile');
        if (inp) inp.click();
      } else if (act === 'csv' || act === 'export') {
        if (!hasAgg) { toast('先生成班级看板再导出'); return; }
        exportCsv(students);
      } else if (act === 'clear') {
        applyRaw('');
        toast('已清空教师端的粘贴记录');
      }
    });

    document.addEventListener('change', e => {
      if (e.target.id !== 'tCodesFile') return;
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const fr = new FileReader();
      fr.onload = () => {
        const text = String(fr.result || '');
        raw = text;
        const ta2 = $('#aggIn');
        if (ta2) ta2.value = text;
        saveState();
        paint();
        toast('已读入文件，点“生成班级看板”');
      };
      fr.onerror = () => toast('文件读取失败');
      fr.readAsText(file, 'utf-8');
    });
  }

  function boot() {
    loadState();
    build();
    if (raw) {
      /* 刷新后不只是把文字放回去，看板也一起重建，老师不会以为数据丢了 */
      const parsed = parseCodes(raw);
      students = parsed.students;
      badCount = parsed.bad;
      hasAgg = students.length > 0;
    }
    paint();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

/* 乡野星图 · AI 助手「小星星」v6
 * ─────────────────────────────────────────────────────────────
 * 两种回答来源，都在这一个对话框里：
 *   1. 内置知识库（离线可用）—— 回答"这个程序怎么用"：测评怎么做、结果怎么看、
 *      报告在哪导出、按钮是干什么的……共 58 条意图，命中后给出文字 + 可点动作。
 *   2. 职业问答引擎 —— 复用「问问学长」的本地知识库，问某个职业时直接答；
 *      一次问两个职业（「护理和幼师怎么选」）时走对照回答，并给一个加入对比的按钮。
 *   3. 可选的大模型 —— 在设置里填接口地址与 Key（OpenAI 兼容格式），
 *      未命中以上两类时交给大模型；调用失败自动退回本地回答，不会卡住对话。
 *
 * 设计原则：先说结论、再给一步能做的事；不知道就直说不知道，不编。
 */
(function () {
  'use strict';

  const K_CFG = 'xyxt.star.cfg.v1';
  const MAX_LOG = 80;

  let panel = null;
  let fab = null;
  let open = false;
  let busy = false;
  let listening = false;

  const NICK = () => {
    const s = window.XYXT_APP && window.XYXT_APP.state();
    const n = s && s.profile && s.profile.nick;
    return n || '';
  };

  const hasResult = () => {
    const s = window.XYXT_APP && window.XYXT_APP.state();
    return !!(s && s.result);
  };

  /* ================= 知识库 =================
   * 每条：k 关键词数组（命中越多分越高）、a 回答、act 可点的下一步
   */
  const KB = [
    {
      id: 'who',
      k: ['你是谁', '你叫什么', '小星星是', '介绍你', '你会什么', '你能做什么'],
      a: '我是小星星，这个程序里的向导。\n\n我能做三件事：① 告诉你每个按钮、每一页是干什么的；② 带你直接跳过去；③ 你问某个职业的实际情况，我也能答。\n\n不知道的直接问，说人话就行。',
      act: { label: '带我看一遍界面', tour: true }
    },
    {
      id: 'grade-11',
      k: ['学段', '11 个年级', '十一个年级', '年级怎么选', '年级为什么', '这么多年级'],
      a: '因为县乡学校的学制不止一种：小学五、六年级，初一、初二、初三，高一、高二、高三，再加上中职一、二、三年级，一共 11 个。\n\n选对年级有用：程序会把 11 个年级归成小学 / 初中 / 高中 / 中职四个学段，首页给的建议、探索任务里标「适用」的提示，都跟着学段变。\n\n改年级在首页的「建档」卡片里，选完立刻生效。',
      act: { label: '回首页改年级', go: 'home' }
    },
    {
      id: 'primary',
      k: ['小学阶段', '小学生能', '小学生要', '五年级的', '六年级的', '小学五年级', '小学六年级', '小学能不能', '小学能做', '小学能', '小学生能做', '小学可以'],
      a: '能，但用法不一样。小学阶段最该干的是"多见几种工作"，不是"定职业"。\n\n· 先去「探索任务」，做第 1 阶里标「轻松」的那几件（查一个没听过的职业、给自己的兴趣打分复盘、走一遍村里的街区）；\n· 60 道题对小学生偏长，可以分两次做，做到最后一题会弹出「补答闸门」，不会偷偷交卷；\n· 测评结果当参考就好，六年级再做一次会更准。',
      act: { label: '看探索任务', go: 'task' }
    },
    {
      id: 'junior-tasks',
      k: ['初中阶段', '初中生做', '初中生该', '初中生要', '初中做哪', '初中该做', '初中做什么',
          '初一', '初二', '初三', '初一该做', '初二该做', '初三该做'],
      a: '初中最该补的是"见过什么工作"。\n\n优先做这几件：查一个你没听过的职业、采访一位身边的职业人、看一场真实的工作现场、走一遍你家附近的村庄或街区。\n\n「对照一个专业的选科要求」「读一份真实的招聘简章」这两件会标「适用：高中/中职」——不是不能做，是等上高中再看不迟。',
      act: { label: '打开探索任务', go: 'task' }
    },
    {
      id: 'senior-tasks',
      k: ['高中该做', '高中做什么', '高中生能', '高一该做', '高二该做', '高三该做', '选科怎么'],
      a: '高中三年重点不一样：\n\n高一：把选科定下来——先看 3 个想了解的职业对应专业要哪些科，再看你哪科稳定；\n高二：盯住目标专业的门槛（有没有选科限制、要不要面试/体检）；\n高三：把分数和志愿口径对齐，别到填志愿才发现报不了。\n\n最省力的一步：去「职业星图」随便点开两个职业，看「对应专业」和「选科建议」两栏。',
      act: { label: '去职业星图看专业要求', go: 'map' }
    },
    {
      id: 'grade-poor',
      k: ['成绩不好', '分数低', '考不上高中', '学不进去', '成绩差', '垫底', '成绩', '分数'],
      a: '成绩不好，影响的是「你能走哪条通道」，不是「你能不能有出路」。\n\n三条现实通道：① 职教贯通与对口升学——中职一样能考大专、本科；② 技能大赛——省赛拿奖在很多省份能免试升学；③ 先就业再提升——护理、数控、新能源维修、无人机、养老照护这些方向看的是手上功夫和证书。\n\n但有一件事别做：因为成绩不好就把选择权交出去，随便报一个专业。先去「职业星图」按学历门槛筛「大专/中职可入」，看清有哪些具体的路。',
      act: { label: '按学历门槛筛职业', go: 'map' }
    },
    {
      id: 'deepseek',
      k: ['deepseek', 'DeepSeek', 'DEEPSEEK', '一键填入', '接口地址填', '怎么接大模型', 'deepseek-chat', 'deepseek-reasoner', 'api.deepseek.com'],
      a: '两条路，看你想要哪种。\n\n【一键填】「我的设置 → 小星星 · AI 设置」→ 点「一键填入 DeepSeek」，地址和模型自动写好，你只要补自己的 API Key，再点保存。\n\n【手动填】接口地址：https://api.deepseek.com/v1　模型：deepseek-chat（日常对话）或 deepseek-reasoner（要它慢想一会儿再答）。Key 在 platform.deepseek.com 申请，形如 sk- 开头。\n\n填完可以直接问一句试试。它只在知识库答不上来时才出手，失败会自动退回本地回答，不会把对话卡住。',
      act: { label: '打开小星星设置', settings: true }
    },
    {
      id: 'llm',
      k: ['大模型', 'gpt', '有接ai', '是真人', '智能', '接了个模型'],
      a: '默认状态下，我靠内置知识库回答，断网也能用，不联网、不上传你的任何话。\n\n如果你在「设置 → 小星星」里填了大模型接口，遇到知识库答不了的问题，我会转给大模型；接口失败会自动退回本地回答。',
      act: { label: '打开设置', settings: true }
    },
    {
      id: 'llm-cost',
      k: ['要不要钱', '要花钱', '收费吗', '免费吗', '贵不贵', '用起来贵'],
      a: '程序本身不要钱，装到电脑上就能一直用。\n\n只有你自己接的大模型要花钱，而且花的是你自己的账户：DeepSeek 的价格按用量算，几十道题、几百句对话的量级通常只要几毛到几块钱；新注册一般还有赠送额度，够试用很久。\n\n不接就一分钱不花，本地知识库照样能用。',
      act: { label: '去设置里看看', settings: true }
    },
    {
      id: 'llm-key',
      k: ['key 安全', 'key安全', 'key 会不会', 'key泄露', '密钥安全', 'apikey 安全', 'api key 安全'],
      a: 'Key 只写在这台设备的浏览器本地存储里，程序没有服务器，也不会把它发给别的任何地方——除了你自己填的那个接口。\n\n但要说实话：填在网页里的 Key，理论上同机器上能打开开发者工具的人都看得到。所以：① 别用公司或学校的公共 Key；② 演示机、公用电脑上填完就清掉（设置里有「改回本地知识库」）；③ 真要公开部署，让懂后端的人做一个代理，Key 放服务端。',
      act: { label: '打开小星星设置', settings: true }
    },
    {
      id: 'llm-offline',
      k: ['断网能用', '没网能用', '不联网能用', '离线能用', '不接大模型'],
      a: '能。不填接口时，我完全靠内置知识库回答，测评、星图、对比、问答、任务、报告全都离线可用。\n\n反过来，接了大模型也要联网：断网时我会自动退回本地回答，不会卡在"正在想"。',
      act: null
    },
    {
      id: 'start',
      k: ['怎么开始', '从哪开始', '第一步', '先做什么', '怎么用', '新手'],
      a: hasResult()
        ? '你已经做过测评了，接下来这样走最省力：\n\n① 去「职业星图」看看推荐给你的那几个方向；\n② 挑 2 个点 ⊕ 加入对比，看清差别；\n③ 去「探索任务」领一件本周能做的小事。'
        : '三步就能跑起来：\n\n① 点「兴趣测评」，60 道题，凭第一感觉选，大约 8 分钟；\n② 做完看「职业星图」，系统会按你的兴趣代码排好顺序；\n③ 想细问某个职业，直接问我或去「问问学长」。',
      act: { label: hasResult() ? '打开职业星图' : '现在去做测评', go: hasResult() ? 'map' : 'test' }
    },
    {
      id: 'login',
      k: ['登录', '注册', '账号', '密码', '手机号', '要不要登录'],
      a: '不用登录，打开就能用——省掉注册这一步，县乡网络不好、拿不到验证码的时候也不卡人。\n\n你的测评、收藏、打卡、对话都直接存在这台设备上，关掉再打开还在。\n\n想换个称呼，点右上角「我的设置 → 修改称呼」。',
      act: { label: '打开我的设置', settings: true }
    },
    {
      id: 'data-where',
      k: ['数据在哪', '存在哪', '会不会上传', '隐私', '安全', '会不会丢'],
      a: '你的数据保存在这台设备的浏览器本地存储里，程序没有服务器，一个字节也不上传（除非你自己在「小星星 · AI 设置」里填了大模型接口）。\n\n风险只有一个：清理浏览器数据、换电脑、重装系统会丢。所以重要记录请在「设置 → 数据」里导出备份，那是一个 JSON 文件，随时能导回来。',
      act: { label: '去导出备份', settings: true }
    },
    {
      id: 'data-back',
      k: ['换设备', '换电脑', '恢复', '找回', '以前记录', '记录没了', '备份'],
      a: '同一台设备上，记录会一直在，不需要登录。\n\n换设备只有一条路：在旧设备「我的设置 → 导出备份」，把 JSON 拷到新设备（U 盘、微信传文件都行），再「导入备份」，测评、收藏、打卡、对话就都接上了。',
      act: { label: '打开数据设置', settings: true }
    },
    {
      id: 'test-how',
      k: ['测评怎么', '怎么测', '多少题', '多久', '几分钟', '题目'],
      a: '60 道题，分活动、能力、职业三类，各 20 题。凭第一感觉选，别想"应该选哪个"，那样测出来的是你希望的样子，不是你的样子。\n\n可以按 🔊 听题，键盘 1—5 也能打分，手机端同样可用。',
      act: { label: '现在开始测评', go: 'test' }
    },
    {
      id: 'test-break',
      k: ['中断', '做到一半', '退出', '下次继续', '没做完', '断点'],
      a: '随时可以退出。下次进来首页会出现「继续上次的测评」，会停在你没答的那一题，已答的不会丢。\n\n如果某一题实在不想答，点「跳过」就行——跳过的题不参与计分，比乱选更准。',
      act: { label: '回去继续', go: 'test' }
    },
    {
      id: 'test-blank',
      k: ['没答完', '跳过题', '少答', '未作答'],
      a: '没答完也能出结果，但结果页会标注「有 N 题未作答」，可靠性会打折。\n\n我的建议：至少把每个维度的题都过一遍，跳个三五题没关系，整段跳过会明显影响判断。',
      act: { label: '去补完剩下的题', go: 'test' }
    },
    {
      id: 'test-retest',
      k: ['重测', '重新测', '再做一次', '测了两次'],
      a: '「设置」外的首页有「重新测一次」，会清掉当前结果重做，历史结果码会保留在记录里。\n\n两次结果差很多是正常的：兴趣本来会变。建议隔三个月以上再测，短时间反复测没意义。',
      act: { label: '打开首页', go: 'home' }
    },
    {
      id: 'result-code',
      k: ['三码', '兴趣代码', 'csr', '代码是什么意思', '字母'],
      a: '三码是霍兰德兴趣代码，取你得分最高的三个维度，比如 CSR = 常规型 + 社会型 + 研究型。\n\n第一码最重要，说明你最容易投入的那类事；后两码是补充。星图里的职业也都标了三码，重合越多，通常越对味。',
      act: { label: '看我的结果', go: 'home' }
    },
    {
      id: 'result-diff',
      k: ['分化度', '一致性', '分数差', '为什么低'],
      a: '· 分化度 = 最高分减最低分的差距。越大说明你的兴趣越集中，越容易选；太小说明你对什么都差不多，那就更需要靠"试"来找答案。\n· 一致性 = 前两码在霍兰德六边形上的位置关系。相邻是"高"，相对是"低"——低不是缺点，说明你两类工作都能适应。',
      act: { label: '看结果页的说明', go: 'home' }
    },
    {
      id: 'result-match',
      k: ['匹配度', '匹配分', '怎么算', '分数高'],
      a: '匹配度是按你的六维得分和职业的三码做加权算出来的，满分 100。\n\n它只做排序用，不是录取概率。60 分以上就值得了解，80 分以上说明高度契合；分数低也不代表不能做，只代表"需要更多刻意练习"。',
      act: { label: '按匹配度看职业', go: 'map' }
    },
    {
      id: 'map-use',
      k: ['星图怎么', '筛选', '搜索', '找不到职业', '29'],
      a: '职业星图里有 29 个职业，四类筛选可以叠着用：本地机会（县城有岗 / 可远程）、学历门槛（中职 / 大专 / 本科）、只看收藏、关键词搜索。\n\n点卡片看详情：真实的一天、怎么入行、对应专业、收入量级、要提前知道的事。',
      act: { label: '去职业星图', go: 'map' }
    },
    {
      id: 'fav',
      k: ['收藏', '星标', '我的收藏'],
      a: '卡片上的 ☆ 是收藏，点亮就进「我的收藏」。\n\n收藏不会因为换页丢失，它记在本机。想集中看，就在星图页点「只看收藏」。',
      act: { label: '打开我的收藏', go: 'map' }
    },
    {
      id: 'cmp',
      k: ['对比', '比较', '哪个好', '并排'],
      a: '最多同时对比 3 个职业。在卡片或详情里点 ⊕ 加入对比，底部会出现对比条，点「开始对比」并排看 9 项差别。\n\n对比的意义不是选"更好的"，而是看清每条路的代价，再决定先从哪条开始试。',
      act: { label: '去对比页', go: 'compare' }
    },
    {
      id: 'ask-vs-me',
      k: ['问问学长和你', '你和学长', '有什么区别', '两个助手'],
      a: '「问问学长」是一整页的职业问答，适合坐下来细聊一个职业；我是随叫随到的小助手，更擅长回答"这个程序怎么用"。\n\n职业问题你问我一样能答，只是我回答得短一些。',
      act: { label: '去看看学长', go: 'ask' }
    },
    {
      id: 'task-levels',
      k: ['三阶', '为什么要分', '难度分组', '由易到难', '分阶', '第 1 阶'],
      a: '14 件任务按"要不要开口、要不要出门"分成三阶：\n\n第 1 阶 · 轻松上手：10—15 分钟，一个人就能做完；\n第 2 阶 · 需要开口：要找人聊，需要一点勇气；\n第 3 阶 · 要花点功夫：出门、动手，或者写出一个结论。\n\n为什么这么排：县乡学生最缺的是"第一次开口"的经验，先把低门槛的做掉，才敢做要麻烦别人的那几件。不用按顺序打勾，但按难度往下走最容易坚持。',
      act: { label: '看这 14 件事', go: 'task' }
    },
    {
      id: 'task-notfinish',
      k: ['做不完', '任务做不', '没时间做', '任务太多', '做任务好难'],
      a: '做不完是常态，别当成作业。\n\n一个学期能认真做完 3—5 件就很好了：一件查资料（查一个没听过的职业）、一件开口（问家长一个问题）、一件出门（看一场真实的工作现场）。这三件做完，你对职业的了解会比同龄人具体得多。\n\n打卡记录只在本机，没人检查，也没人比较。',
      act: { label: '挑一件今天的', go: 'task' }
    },
    {
      id: 'task-repeat',
      k: ['能不能重复做', '重复做', '做过的任务', '任务能再做', '任务可以重'],
      a: '可以，而且建议重复。\n\n比如「给自己的兴趣打分复盘」，理论上每学期都该做一次，把两次结果放一起看，比只看一次有用；「采访一位身边的职业人」也可以换个人再问一遍，你会问出不一样的东西。\n\n打勾只是记一下做过，不影响能不能再做。',
      act: { label: '打开探索任务', go: 'task' }
    },
    {
      id: 'gate-how',
      k: ['补答', '闸门', '最后一题', '还有几道题没答', '没答的题怎么补', '跳过的题', '还能补吗', '跳过能补'],
      a: '你答完第 60 题时，程序不会直接交卷，分两种情况：\n\n· 前面还有跳过的题：先弹出一张「还有 N 道题没答」的卡片，这就是补答闸门。点「补答这 N 题」跳到第一道没答的题；点卡片上「第 3 题」这类小标签直接跳过去；点「就这样生成结果」不补了直接出。\n· 60 题都答完了：停在一张绿色的「60 道题都答完了」卡片上，这时还没提交，你可以翻回去改，确认没问题再按「提交并生成我的星图」。\n\n结果页上如果出现「有 N 题未作答」，那里也有一个「去补答」按钮，随时能补。',
      act: { label: '现在去做测评', go: 'test' }
    },
    {
      id: 'gate-skip',
      k: ['不补会怎样', '不补答', '直接生成结果', '有题没答', '未答的影响'],
      a: '不补也能出结果，但要知道代价：\n\n· 未答的题不参与计分，那六个维度的标准分会按已答的题折算，所以分数会有偏差；\n· 结果页会明确写「有 N 道题没有作答」，判断会打折扣；\n· 如果某个维度整段没答，那一维可能被评为 0，推荐就会偏。\n\n跳三五题问题不大，整段跳过就值得补回来。补一次也就一两分钟。',
      act: { label: '去补答', go: 'test' }
    },
    {
      id: 'task',
      k: ['任务', '打卡', '每周', '行动'],
      a: '「探索任务」是 14 件几分钟到半小时能做完的小事，按由易到难分成三阶：轻松上手 / 需要开口 / 要花点功夫。\n\n想不清楚的时候别硬想，先做一件具体的。打卡记录一直留在本机。',
      act: { label: '领一件小事', go: 'task' }
    },
    {
      id: 'print-pdf',
      k: ['存 pdf', '存成pdf', '另存为', '打印成', '怎么打印', '打印不出来', '导出pdf'],
      a: '两种都行，看你要什么：\n\n【A4 报告】做完测评后回首页，点「预览报告」确认内容，再点「打印 / 存为 PDF」，在打印对话框里把"目标打印机"选成「另存为 PDF」，点保存。表格和雷达图都是矢量，放大不糊。\n\n【独立文件】点「导出报告文件」，会下载一个 HTML 文件，双击能用浏览器打开，换台电脑也能看；要 PDF 就再按 Ctrl+P 存一次。\n\n发给家长：PDF 直接微信发；HTML 文件建议先截图或者转成 PDF 再发，免得对方点不开。',
      act: { label: '回首页看报告', go: 'home' }
    },
    {
      id: 'report',
      k: ['报告', '导出', '打印', 'pdf', '发给家长', '发给老师'],
      a: '做完测评后，首页底部有「查看完整报告」和「导出报告」。\n\n导出的是一份独立 HTML 文件，双击就能用浏览器打开，按 Ctrl+P 选「另存为 PDF」就能交作业或发给家长。报告里带雷达图、六维表、8 个建议方向和 30 天清单。',
      act: { label: '回首页看报告', go: 'home' }
    },
    {
      id: 'code-contain',
      k: ['结果码里', '结果码有', '结果码包含', '结果码是什么', '结果码含'],
      a: '结果码是一串以 XYXT1- 开头的字符，里面只有四样东西：昵称、年级、三码兴趣代码与六维分数、建议方向（职业 id）以及已完成任务数。\n\n没有学号、没有手机号、没有身份证，也没有你的答题原文——别人拿到也没法反推出你哪道题选了几。\n\n所以发给老师是安全的；但昵称建议用小名，别用真名。',
      act: { label: '复制我的结果码', go: 'home' }
    },
    {
      id: 'code-revoke',
      k: ['撤回', '能不能收回', '结果码作废', '删掉结果码', '取消分享'],
      a: '严格说"撤回"做不到——已经发出去的文字，发给了谁就控制不了谁。\n\n但你可以：① 重新生成一个新的结果码（每次点「复制结果码」都会按当前数据重新打包，旧码本身不会失效，但内容会不一样）；② 改昵称（设置里改个别的称呼），以后生成的码就带上新昵称；③ 「清空本机数据」后，本机不再保留任何作答和结果。\n\n真正的建议：发之前想一下对方是谁，用昵称而不是真名。',
      act: { label: '打开我的设置', settings: true }
    },
    {
      id: 'code-name',
      k: ['看到姓名', '会不会看到名字', '真名', '匿名', '名字会不会'],
      a: '老师看到的，是你在结果码里写的那个昵称——你写"小满"就显示"小满"，你写真名就显示真名。\n\n所以匿不匿名由你决定：不想被认出来，就在「我的设置 → 修改称呼」里改成小名或者学号末两位（别用完整学号）。\n\n另外，班级看板是老师手动粘贴生成的，程序不会自动把谁的名字传上去；导出 CSV 之前，老师那边也该先确认用途。',
      act: { label: '改个称呼', settings: true }
    },
    {
      id: 'code',
      k: ['结果码', '汇总码', '发给老师', 'xyxt1'],
      a: '结果码是一串以 XYXT1- 开头的字符，把你的兴趣结构压进一小段文本。\n\n发给老师，老师粘到教师端就能汇总班级情况，不用你把姓名年级再报一遍。',
      act: { label: '复制我的结果码', go: 'home' }
    },
    {
      id: 'teacher-page',
      k: ['教师端在哪', '教师端在', '教师端入口', '独立页面', 'teacher.html', '老师从哪进', '学生端没有教师端'],
      a: '教师端已经改成独立页面了：同一个文件夹里的 teacher.html。学生端顶部只有七个入口，不再放「教师端」这个标签。\n\n老师怎么打开：\n① 直接双击 teacher.html；\n② 或者在学生端首页「给评委／老师的 60 秒」里点「打开教师端（新页面）」；\n③ 也可以「我的设置 → 关于 → 教师端入口（独立页面）」。\n\n两边数据完全分开：教师端读不到你的测评，只认学生发给老师的结果码。',
      act: { label: '打开教师端（新页面）', page: 'teacher.html' }
    },
    {
      id: 'teacher',
      k: ['教师端', '老师', '班级', '汇总'],
      a: '教师端是给班主任 / 心理老师用的独立页面（teacher.html）：把学生发来的结果码粘贴或导入文件，就能看到班级兴趣分布、雷达图和三条教学建议，还能导出 CSV。\n\n注意：汇总里不要外传学生姓名，只有已同意的结果码才该导入。',
      act: { label: '打开教师端（新页面）', page: 'teacher.html' }
    },
    {
      id: 'subject-choice',
      k: ['选科', '怎么选科', '选科怎么选', '物理还是历史', '选科要求', '3+1+2', '选科怎么定', '高一选什么科'],
      a: '选科别从"哪科容易得分"开始，从"哪些专业必须有它"倒推。\n\n三步：① 在「职业星图」里挑 2—3 个你真正想了解的职业，看它们的「建议选科」；② 去查这几个专业在你所在省份的选科要求（高校招生网或省考试院，一年一版）；③ 看自己的成绩，把"必须选"和"能学好"求交集。\n\n一个常见坑：想学医、想学工科，多半绕不开物理；想读汉语言、法学这类，历史更顺。不确定就先保住物理，它能开的门更多。',
      act: { label: '去职业星图看选科', go: 'map' }
    },
    {
      id: 'vocational',
      k: ['对口升学', '单招', '对口高考', '中职升学', '职教高考', '中职升本', '中职三年级',
          '中职生', '中职该做', '中职做什么', '中职能做什么'],
      a: '中职不是终点，升学的路至少有四条：\n\n· 对口升学（职教高考）：考"文化课 + 专业技能"，能上本省的高职和应用型本科，是最主流的通道；\n· 高职单招：高三（中职三年级）上学期报名，学校自主命题，录取了就不用再参加对口考试；\n· 3+2 / 五年一贯制：入学就定了专科，省一次考试；\n· 技能大赛获奖免试：省级以上奖项有机会直接升学，这条路最吃专业老师的资源。\n\n共同点：专业课别丢，技能证书要考，语文数学不能太差。具体政策每年会调，找班主任或教务处要当年的文件。',
      act: null
    },
    {
      id: 'zhuanshengben',
      k: ['专升本', '专插本', '专科升本科', '专科考研'],
      a: '专升本一般在大三（专科最后一年）考，考上是再到本科读两年，拿全日制本科毕业证。\n\n要注意三件事：① 只能是应届那一年考，多数省份只有一次机会；② 只能报本省有招生计划的院校和专业，专业对口限制比较紧；③ 想考就早准备，大二下开始不算早。\n\n如果目标是考编或考公，本科确实能开的门更多；但如果是护理、数控、汽修这类看证书和手上功夫的方向，先就业再自考本科也走得通。',
      act: null
    },
    {
      id: 'army',
      k: ['参军', '当兵', '入伍', '征兵', '退伍'],
      a: '参军是一条很实在的路，尤其是县乡家庭的孩子：\n\n· 在校生和毕业生都能报，年龄一般 18—24 岁，具体看当年征兵公告；\n· 服役期间有津贴，退役时有一笔退役金，学费能申请补偿代偿；\n· 退役后升学有专项：专科生可免试读成人本科或参加专升本专项计划，本科生考研有加分和专项名额；\n· 考公有面向退役士兵的定向岗位。\n\n代价也要看清：两年时间、体能纪律要求高、分配到哪不一定能选。真想去，先找当过兵的亲戚或学校武装部聊一次。',
      act: null
    },
    {
      id: 'repeat-year',
      k: ['复读', '再读一年', '高四', '要不要复读'],
      a: '复读不是"再来一次"这么简单，先看三个条件：\n\n① 分差：如果是失常（比平时低 40 分以上），复读的收益最大；如果是稳定水平，提升通常有限；\n② 心态：复读一年最大的消耗是心理，不是知识；\n③ 钱和名额：公办高中多已不招复读生，民办复读班一年学费加生活费对县乡家庭不是小数。\n\n另一种更划算的选择：先上能上的学校，再靠专升本、考研、考证往上走。路不只一条，别把一年当成唯一解。',
      act: null
    },
    {
      id: 'migrate',
      k: ['外出打工', '出去打工', '打工还是读书', '返乡', '回家乡工作', '回乡就业', '留在县城'],
      a: '不用把"出去"和"回来"当成人生的两个对立选项，很多人是"出去学本事、回来用本事"。\n\n· 想出去：先想清楚去学什么。进厂流水线和进一个有师傅带的技术岗，三年后的差距非常大；\n· 想回来：县城的现实是岗位少、要考试，但生活成本低、离家人近。护理、教师、会计、电网、农技、电商运营这些在县里都还有位置；\n· 折中：设计、开发、数据分析、跨境电商这类可以远程接单，"人在县城，客户在城里"。前提是作品和能力要过硬。\n\n判断标准很简单：这条路三年后能不能让你"更值钱"。',
      act: { label: '看本地有岗的职业', go: 'map' }
    },
    {
      id: 'family-explain',
      k: ['跟爸妈说', '跟家长说', '怎么跟家里', '父母不支持', '爸妈不理解', '家里不同意'],
      a: '跟家里解释测评结果，别从"测评说我适合什么"开始，那样容易被当成算命。\n\n换个说法：① 先说做了什么（60 道题，问的是我喜欢做什么，不是我能考多少分）；② 再说结论（我可能更适合跟人打交道 / 更适合动手的活）；③ 最后落到一件具体的事（我想这个周末去舅舅的店里看半天）。\n\n家长反对，多半不是反对你的兴趣，是怕你"没饭吃"。所以把话说到"这条路怎么赚钱、要读几年、家里要出多少"上，比讲兴趣更有效。',
      act: { label: '看工资与门槛', go: 'map' }
    },
    {
      id: 'family-work',
      k: ['早点打工', '不读了', '家里让', '让我辍学', '读不起', '供不起'],
      a: '这是最难的一类问题，我不劝你"一定要读书"，但有几个事实值得和家里一起看：\n\n· 16 岁出去的和 19 岁带着证书出去的，起薪和上升空间都不一样，后者三年就能追平甚至超过；\n· 现在有免学费的中职、国家助学金、雨露计划、生源地助学贷款，很多家庭其实不用全额掏钱；\n· 半工半读也有一条：读中职的订单班、企业冠名班，边学边有补贴。\n\n具体能不能申请，去问班主任或县教育局资助中心，这是他们的本职工作，问不丢人。',
      act: null
    },
    {
      id: 'science',
      k: ['科学性', '靠谱吗', '依据', '霍兰德', '信效度', '量表'],
      a: '「科学性」页写了完整依据：霍兰德 RIASEC 理论、题目来源与改编方式、计分规则、信度效度参考和文献。\n\n一句话：这是课堂改编量表，用来缩小探索范围，不是给你下结论，也不能替代专业测评与升学指导。',
      act: { label: '看科学依据', go: 'science' }
    },
    {
      id: 'pwa',
      k: ['装到桌面', '添加到主屏', '安装到手机', '装到手机', 'pwa', '像 app 一样', '离线安装'],
      a: '能，但方式不太一样。\n\n【电脑】用 Edge / Chrome 打开后，地址栏右侧有个"安装"图标（或菜单里「应用 → 安装此站点」），装完就是一个独立窗口，任务栏有图标。\n\n【安卓手机】Chrome 菜单 →「添加到主屏幕」，之后像 App 一样点开；用 https 地址打开时才会真正离线缓存。\n\n【iPhone】Safari → 分享 → 「添加到主屏幕」；iOS 上必须用 Safari，微信里打开是不行的。\n\n注意：桌面版双击 exe 是 file:// 方式，这种模式下不注册离线缓存，但功能一样能用。',
      act: null
    },
    {
      id: 'ios-android',
      k: ['苹果手机', '安卓手机', '安卓和苹果', 'iphone', 'ipad', '手机上能', '手机能用'],
      a: '都能用，差别在三处：\n\n· 语音识别：安卓 Chrome / 微信内置浏览器支持得更好；iPhone 的 Safari 支持，但要在设置里允许听写。\n· 安装到桌面：安卓用 Chrome 菜单「添加到主屏幕」；iPhone 只能 Safari → 分享 → 添加到主屏幕。\n· 本地存储：iPhone 的 Safari 清理缓存比较积极，长期不用可能被清掉，重要记录记得导出备份。\n\n用 file:// 打开时手机端读不到本地文件，把整个文件夹传上去用浏览器打开更稳妥。',
      act: null
    },
    {
      id: 'voice',
      k: ['语音', '麦克风', '录音', '说话没反应', '识别不了', '朗读', '女声', '声音太机械'],
      a: '语音用不了，九成是打开方式的问题：直接双击 index.html 时，浏览器禁止网页调用麦克风。\n\n解决办法：用「打开.bat」启动（它会在本机起一个小服务，地址是 127.0.0.1，属于安全上下文，麦克风才被允许）。另外语音识别本身需要联网。\n\n顺带说一句朗读：朗读默认用系统里的中文女声，语速偏慢；在「我的设置 → 使用 → 试听朗读声音」里可以先听一句。',
      act: { label: '看使用说明', settings: true }
    },
    {
      id: 'offline',
      k: ['离线', '断网', '没网', '联网'],
      a: '核心功能全部离线可用：测评、星图、对比、问答、任务、报告都在本地。\n\n只有两件事需要网络：语音识别（浏览器自带的识别服务）、以及你自己配置的大模型接口。',
      act: null
    },
    {
      id: 'blank',
      k: ['白屏', '打不开', '没反应', '报错', '卡住'],
      a: '先按这三步试：\n\n① 关掉页面重新打开；② 换 Edge 或 Chrome；③ 用「打开.bat」启动，而不是直接双击 html。\n\n如果还是白屏，可能是浏览器禁用了本地存储——换一个浏览器或退出无痕模式再试。',
      act: null
    },
    {
      id: 'reset',
      k: ['清空', '重置', '删除数据', '注销'],
      a: '「我的设置 → 数据」里有「清空本机数据」，会删掉测评、收藏、对话与打卡，连称呼也回到「同学」，不可恢复，建议先导出备份。',
      act: { label: '打开数据设置', settings: true }
    },
    {
      id: 'who-made',
      k: ['谁做的', '团队', '比赛', '作品', '参赛'],
      a: '这是「拾光职引」队伍的作品，参加 2026「联通杯」广东第二师范学院 AI 应用创新大赛，赛道是县乡教育赋能。\n\n做它的原因很朴素：县乡孩子缺的不是努力，是"看见"——看见有哪些职业、看见路怎么走。',
      act: null
    },
    {
      id: 'nav-help',
      k: ['按钮', '这是干什么', '什么意思', '看不懂', '界面'],
      a: '界面分成三块：顶部是「我的设置」，中间一排是七个功能入口（我的星图 / 兴趣测评 / 职业星图 / 职业对比 / 问问学长 / 探索任务 / 科学性），右下角这颗星就是我。\n\n教师端不在这排里——它是给老师用的独立页面 teacher.html，学生端不占位置。\n\n我可以一步步指给你看，也可以你直接问"报告在哪"这种具体问题。',
      act: { label: '带我看一遍界面', tour: true }
    },
    {
      id: 'thanks',
      k: ['谢谢', '感谢', '好的', '明白', '懂了'],
      a: '不客气。有想不清楚的地方随时喊我——右下角那颗星一直在。',
      act: null
    }
  ];

  /* ================= 状态与配置 ================= */
  function cfg() {
    try {
      const raw = localStorage.getItem(K_CFG);
      const o = raw ? JSON.parse(raw) : {};
      return { baseUrl: '', apiKey: '', model: '', ...(o || {}) };
    } catch (e) { return { baseUrl: '', apiKey: '', model: '' }; }
  }

  function saveCfg(o) {
    try { localStorage.setItem(K_CFG, JSON.stringify(o)); return true; } catch (e) { return false; }
  }

  function log() {
    const s = window.XYXT_APP && window.XYXT_APP.state();
    if (!s) return [];
    if (!Array.isArray(s.starChat)) s.starChat = [];
    return s.starChat;
  }

  function pushMsg(role, text, act) {
    const s = window.XYXT_APP && window.XYXT_APP.state();
    if (!s) return;
    if (!Array.isArray(s.starChat)) s.starChat = [];
    s.starChat.push({ role, text, act: act || null, at: Date.now() });
    if (s.starChat.length > MAX_LOG) s.starChat = s.starChat.slice(-MAX_LOG);
    if (window.XYXT_APP.save) window.XYXT_APP.save();
  }

  /* ================= 知识库匹配 ================= */
  function scoreEntry(entry, text) {
    const t = String(text);
    let score = 0;
    entry.k.forEach(k => {
      if (t.indexOf(k) >= 0) score += k.length >= 4 ? 2 : 1;
    });
    return score;
  }

  function bestEntry(text) {
    let best = null, bestScore = 0;
    KB.forEach(e => {
      const s = scoreEntry(e, text);
      if (s > bestScore) { best = e; bestScore = s; }
    });
    return bestScore >= 2 ? best : null;
  }

  function careerHit(text) {
    const data = window.XYXT;
    if (!data || !Array.isArray(data.CAREERS)) return null;
    const t = String(text);
    for (const c of data.CAREERS) {
      const short = c.name.split('（')[0];
      if (short && t.indexOf(short) >= 0) return c;
    }
    return null;
  }

  const CAREER_INTENT = /(哪个好|好不好|怎么样|工资|收入|就业|前景|专业|学历|考|累|辛苦|县城|本地|远程|适合|推荐|选什么|学什么)/;

  /* 一次问两个职业时才算「在做两选一」；只提两个名字（「护理和幼师的工资」）仍走单职业回答 */
  const COMPARE_INTENT = /(怎么选|哪个好|选哪个|对比|区别|更适合|还是)/;

  /* 命中的职业，最多两个。先按全名/简称做子串命中（「护理师」「小学教师」），
     再借主应用的别名表兜住口语说法（「护理」「幼师」「汽修」）——
     主应用的 ALIAS 只存一份，这里不复制第二份，避免两边漂移。 */
  function careersHit(text) {
    const data = window.XYXT;
    if (!data || !Array.isArray(data.CAREERS)) return [];
    const t = String(text || '');
    const out = [];
    const push = c => {
      if (c && out.length < 2 && !out.some(x => x.id === c.id)) out.push(c);
    };
    data.CAREERS.forEach(c => {
      const short = c.name.split('（')[0];
      if (short && t.indexOf(short) >= 0) push(c);
    });
    const app = window.XYXT_APP;
    if (out.length < 2 && app && typeof app.findCareers === 'function') {
      app.findCareers(t, 3).forEach(push);
    }
    return out;
  }

  function firstClause(s) {
    return String(s || '').split(/[；;。]/)[0].trim();
  }

  /* 双职业对照：不判谁更好，只把最影响选择的三条差别摆出来。
     三条里如果有两条两边完全一样，光看清单会像在凑数，所以再算一遍「哪几条一样」，
     自动点明真正把人分开的是哪一条——句子由数据拼，不针对某个职业写死。 */
  function compareReply(a, b) {
    const na = a.name.split('（')[0];
    const nb = b.name.split('（')[0];
    const rows = [
      { t: '学历门槛', av: String(a.edu || ''), bv: String(b.edu || ''), quote: false },
      { t: '本地机会', av: String(a.local || ''), bv: String(b.local || ''), quote: false },
      { t: '最难的地方', av: firstClause(a.hint), bv: firstClause(b.hint), quote: true }
    ];
    const sameRows = rows.filter(r => r.av === r.bv);
    const diffRows = rows.filter(r => r.av !== r.bv);
    const same = sameRows.length;

    const lines = rows.map(r => '· ' + r.t + '：' + na + ' 是' +
      (r.quote ? '「' + r.av + '」' : ' ' + r.av) + '，' + nb + ' 是' +
      (r.quote ? '「' + r.bv + '」' : ' ' + r.bv) + '。');

    let verdict = '';
    if (same === 3) {
      /* 三条全一样：仍然由数据判定，不硬写职业 */
      verdict = '这三条两边完全一样——在你现在最该先看的这三点上，它们几乎是同一条路，差别要到「真实的一天」「怎么入行」里才看得出来。';
    } else if (same >= 2) {
      verdict = '上面 ' + same + ' 条两边一样，真正把人分开的是「' + diffRows[0].t + '」——那一条建议你对着自己的情况读两遍。';
    } else if (same === 1) {
      verdict = '有一项两边一样（' + sameRows[0].t + '），差别主要在另外两条。';
    }

    return {
      text: [
        na + ' 和 ' + nb + ' 不是「谁更好」，是两条代价不同的路。三条最该先看的差别：',
        lines.join('\n'),
        verdict,
        '想看清全部 9 项，点下面把两个都加进对比。'
      ].filter(Boolean).join('\n\n'),
      act: { label: '加入对比并查看', compare: [a.id, b.id] }
    };
  }

  /* ================= 组织回答 ================= */
  function localReply(text) {
    const t = String(text || '').trim();

    if (!t) return { text: '你可以直接问，比如「怎么开始」「报告在哪导出」。', act: null };

    // 1) 程序使用知识库
    const hit = bestEntry(t);
    if (hit) return { text: hit.a, act: hit.act || null };

    // 2) 一次问两个职业 → 对照回答（比单职业长文更该做的事是先摆差别）
    if (COMPARE_INTENT.test(t)) {
      const cs = careersHit(t);
      if (cs.length >= 2) return compareReply(cs[0], cs[1]);
    }

    // 3) 单职业问题 → 交给问答引擎
    if (careerHit(t) || (CAREER_INTENT.test(t) && t.length >= 4)) {
      const r = window.XYXT_APP && window.XYXT_APP.answer ? window.XYXT_APP.answer(t) : null;
      if (r && r.text) {
        return {
          text: r.text,
          act: r.careerId ? { label: '看这个职业的完整画像', career: r.careerId } : { label: '去问问学长细聊', go: 'ask' }
        };
      }
    }

    // 3) 兜底
    const s = window.XYXT_APP && window.XYXT_APP.state();
    const tip = s && s.result ? '你已经做完测评了，可以问我「报告在哪导出」或者「护理和幼师怎么选」。' : '还没做测评的话，我可以先带你去做，8 分钟。';
    return {
      text: '这个我暂时答不准，不想瞎猜。\n\n我最擅长回答两类问题：① 这个程序怎么用（测评、星图、报告、教师端、导出备份）；② 某个职业的真实情况。\n\n' + tip,
      act: s && s.result ? null : { label: '去做测评', go: 'test' }
    };
  }

  /* ================= 大模型（可选） ================= */
  function systemPrompt() {
    const s = (window.XYXT_APP && window.XYXT_APP.state()) || {};
    const res = s.result;
    const me = NICK() ? '当前用户昵称：' + NICK() + '。' : '';
    const st = res
      ? '已完成的兴趣测评：霍兰德代码 ' + res.code + '，分化度 ' + res.diff + '。'
      : '该用户还没有做兴趣测评。';
    return [
      '你叫小星星，是「乡野星图」这款县乡青少年职业探索程序里的向导。',
      '语气：像高两届的学长学姐，说人话，短句，不用书面腔，不说教，不卖焦虑。',
      '你熟悉这个程序（v6.1）：七个入口——我的星图（首页/结果/报告）、兴趣测评（60 题·约 8 分钟·可中断续做·答完最后一题不会自动交卷：有跳过的题会弹「补答闸门」，全答完则停在一张「都答完了」的绿色卡片上等你自己按「提交并生成我的星图」，还能翻回去改）、职业星图（29 个职业·四类筛选·收藏）、职业对比（最多 3 个·9 项）、问问学长（职业问答）、探索任务（14 件分三阶的小事：轻松上手 / 需要开口 / 要花点功夫）、科学性（量表依据）；另有设置（称呼·年级·学科偏好·数据备份·引导重看·小星星接口）。「重新做一遍」这类会清空答案的按钮要点两次才生效。',
      '年级共 11 个，分四个学段：小学（五年级、六年级）、初中（初一 / 初二 / 初三）、高中（高一 / 高二 / 高三）、中职（一 / 二 / 三年级）。学段会影响首页建议与任务的适用提示。',
      '教师端已经不是学生端的标签页，而是独立页面 teacher.html：老师用浏览器打开它，粘贴学生发来的结果码生成班级看板，与学生端数据完全隔离。',
      '可选接入大模型：设置里「一键填入 DeepSeek」→ 地址 https://api.deepseek.com/v1、模型 deepseek-chat / deepseek-reasoner，用户自己补 API Key；未填则完全离线。',
      '回答规则：先给结论，再给一步能立刻做的事；不确定就直说不知道，不要编造具体的招聘人数、分数线或薪资数字。',
      me + st
    ].join('\n');
  }

  async function askLLM(text, history) {
    const c = cfg();
    if (!c.baseUrl || !c.model) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(c.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          c.apiKey ? { Authorization: 'Bearer ' + c.apiKey } : {}
        ),
        body: JSON.stringify({
          model: c.model,
          temperature: 0.6,
          messages: [
            { role: 'system', content: systemPrompt() },
            ...history.slice(-6).map(m => ({
              role: m.role === 'me' ? 'user' : 'assistant',
              content: m.text
            })),
            { role: 'user', content: text }
          ]
        }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const ans = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : '';
      return ans ? String(ans).trim() : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ================= 渲染 ================= */
  function buildPanel() {
    if (panel && document.body.contains(panel)) return panel;

    fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'star-fab';
    fab.id = 'starFab';
    fab.setAttribute('aria-label', '打开小星星助手');
    fab.innerHTML = '<span class="star-fab-ico" aria-hidden="true">✦</span><span class="star-fab-txt">小星星</span>';
    fab.addEventListener('click', () => toggle());
    document.body.appendChild(fab);

    panel = document.createElement('section');
    panel.className = 'star';
    panel.id = 'starPanel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', '小星星助手');
    panel.innerHTML = `
      <header class="star-head">
        <span class="star-ava" aria-hidden="true">✦</span>
        <span class="star-title">
          <b>小星星</b>
          <small id="starSub">向导 · 本地知识库</small>
        </span>
        <button type="button" class="star-x" data-star="close" aria-label="收起小星星">✕</button>
      </header>
      <div class="star-log" id="starLog" role="log" aria-live="polite"></div>
      <div class="star-quick" id="starQuick"></div>
      <div class="star-in">
        <button type="button" class="star-mic" data-star="mic" aria-label="语音提问">🎤</button>
        <label class="sr-only" for="starIn">问小星星</label>
        <input id="starIn" maxlength="120" placeholder="问我：这个程序怎么用…">
        <button type="button" class="btn small primary" data-star="send">发送</button>
      </div>
      <footer class="star-foot">
        <span id="starSrc">回答来自内置知识库，不联网</span>
        <button type="button" class="link" data-star="clear">清空</button>
      </footer>`;
    document.body.appendChild(panel);

    panel.addEventListener('click', e => {
      const b = e.target.closest('[data-star]');
      if (b) {
        const a = b.dataset.star;
        if (a === 'close') close();
        else if (a === 'send') sendFromInput();
        else if (a === 'mic') startVoice();
        else if (a === 'clear') clearLog();
        return;
      }
      const actBtn = e.target.closest('[data-star-act]');
      if (actBtn) { runAction(JSON.parse(actBtn.dataset.starAct)); return; }
      const chip = e.target.closest('[data-star-ask]');
      if (chip) send(chip.dataset.starAsk);
    });

    panel.addEventListener('keydown', e => {
      if (e.key === 'Escape') { close(); }
      if (e.target.id === 'starIn' && e.key === 'Enter') {
        const v = e.target.value.trim();
        if (v) { e.target.value = ''; send(v); }
      }
    });

    return panel;
  }

  function renderLog() {
    const box = document.getElementById('starLog');
    if (!box) return;
    const msgs = log();
    const intro = `<div class="star-msg ai">${escHTML(greeting())}</div>`;
    box.innerHTML = msgs.length
      ? msgs.map(m => `
        <div class="star-msg ${m.role === 'me' ? 'me' : 'ai'}">${escHTML(m.text)}
          ${m.act ? `<button type="button" class="star-act" data-star-act='${escAttr(JSON.stringify(m.act))}'>${escHTML(m.act.label)}</button>` : ''}
        </div>`).join('')
      : intro;
    box.scrollTop = box.scrollHeight;
    renderQuick();
    const sub = document.getElementById('starSub');
    const c = cfg();
    if (sub) sub.textContent = c.baseUrl && c.model ? '向导 · 已接入大模型' : '向导 · 本地知识库';
    const src = document.getElementById('starSrc');
    if (src) src.textContent = c.baseUrl && c.model ? '未命中知识库时转给大模型，失败自动退回本地' : '回答来自内置知识库，不联网';
  }

  function greeting() {
    const n = NICK();
    const head = n ? '你好，' + n + '。我是小星星 ✦' : '你好，我是小星星 ✦';
    return head + '\n\n这个程序里的事都可以问我：怎么开始、结果怎么看、报告在哪导出、每个按钮是干什么的。\n\n想让我带路，点下面的问题，或者直接问。';
  }

  function quickList() {
    const base = ['怎么开始？', '结果怎么读？', '报告在哪导出？', '带我看一遍界面'];
    return hasResult() ? ['报告在哪导出？', '我的结果怎么看？', '护理和幼师怎么选？', '带我看一遍界面'] : base;
  }

  function renderQuick() {
    const box = document.getElementById('starQuick');
    if (!box) return;
    box.innerHTML = quickList().map(q => `<button type="button" data-star-ask="${escAttr(q)}">${escHTML(q)}</button>`).join('');
  }

  function escHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  }

  /* ================= 交互 ================= */
  function toggle() {
    if (open) close(); else show();
  }

  function show() {
    buildPanel();
    panel.hidden = false;
    open = true;
    document.body.classList.add('staring');
    renderLog();
    setTimeout(() => {
      const inp = document.getElementById('starIn');
      if (inp && window.innerWidth > 640) inp.focus({ preventScroll: true });
    }, 60);
  }

  function close() {
    if (!panel) return;
    panel.hidden = true;
    open = false;
    document.body.classList.remove('staring');
    if (fab) fab.focus({ preventScroll: true });
  }

  async function send(text) {
    const t = String(text || '').trim();
    if (!t || busy) return;
    buildPanel();
    pushMsg('me', t);
    renderLog();

    busy = true;
    const box = document.getElementById('starLog');
    if (box) {
      const typing = document.createElement('div');
      typing.className = 'star-msg ai typing';
      typing.id = 'starTyping';
      typing.textContent = '小星星正在想…';
      box.appendChild(typing);
      box.scrollTop = box.scrollHeight;
    }

    let r = null;
    const c = cfg();
    const useLLM = c.baseUrl && c.model;

    if (useLLM && !bestEntry(t)) {
      const ans = await askLLM(t, log().slice(0, -1));
      if (ans) r = { text: ans, act: null };
    }
    if (!r) {
      await new Promise(res => setTimeout(res, 220)); // 轻微延迟，避免"秒回"显得像死板匹配
      r = localReply(t);
    }

    const ty = document.getElementById('starTyping');
    if (ty) ty.remove();
    pushMsg('ai', r.text, r.act);
    busy = false;
    renderLog();
  }

  function sendFromInput() {
    const inp = document.getElementById('starIn');
    if (!inp) return;
    const v = inp.value.trim();
    if (!v) return;
    inp.value = '';
    send(v);
  }

  function clearLog() {
    const s = window.XYXT_APP && window.XYXT_APP.state();
    if (!s) return;
    s.starChat = [];
    if (window.XYXT_APP.save) window.XYXT_APP.save();
    renderLog();
  }

  function runAction(act) {
    if (!act) return;
    const app = window.XYXT_APP;
    /* page：独立页面（目前只有教师端 teacher.html），新窗口打开，被拦截就当前窗口跳 */
    if (act.page) {
      close();
      if (!window.open(act.page, '_blank')) location.href = act.page;
      return;
    }
    if (act.go && app && app.go) { close(); app.go(act.go); return; }
    /* compare：把这两个职业放进对比条（已有别的就整体替换，最多留 2 个），再跳对比页 */
    if (Array.isArray(act.compare) && act.compare.length && app && app.state && app.go) {
      const st = app.state();
      if (st) {
        st.compare = act.compare.slice(0, 2);
        if (app.save) app.save();
      }
      close();
      app.go('compare');
      return;
    }
    if (act.tour) { close(); if (window.XYXT_TOUR) window.XYXT_TOUR.start({}); return; }
    if (act.settings && app && app.openSettings) { close(); app.openSettings(); return; }
    if (act.career && app && app.openCareer) { close(); app.openCareer(act.career); return; }
  }

  /* 语音：复用主应用的识别封装（若可用），否则给出提示 */
  function startVoice() {
    const btn = panel && panel.querySelector('[data-star="mic"]');
    if (listening) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      pushMsg('ai', '这个浏览器不支持语音识别，换成 Edge 或 Chrome 就行；也可以直接打字。');
      renderLog();
      return;
    }
    if (location.protocol === 'file:') {
      pushMsg('ai', '现在是用「本地文件」方式打开的，浏览器不允许网页录音。\n\n用「打开.bat」启动后，我就能听你说话了；也可以先打字。');
      renderLog();
      return;
    }
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    listening = true;
    if (btn) btn.classList.add('on');
    rec.onend = () => { listening = false; if (btn) btn.classList.remove('on'); };
    rec.onerror = () => { listening = false; if (btn) btn.classList.remove('on'); };
    rec.onresult = ev => {
      const t = (ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : '').trim();
      if (t) send(t);
    };
    try { rec.start(); } catch (e) { listening = false; if (btn) btn.classList.remove('on'); }
  }

  /* ================= 对外 API ================= */
  window.XYXT_STAR = {
    mount: () => { buildPanel(); },
    show,
    close,
    toggle,
    ask: send,
    reset: clearLog,
    config: cfg,
    saveConfig: saveCfg,
    isOpen: () => open,
    // 供测试：直接拿本地引擎的回答，不经过 UI
    __localReply: localReply
  };
})();

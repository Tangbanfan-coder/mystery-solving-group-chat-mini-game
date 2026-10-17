// GM：把正史 + 角色目标交给模型，让它现场演，而不是背台词
const API = 'https://api.deepseek.com/chat/completions';
const KEY = process.env.ROLE_PLAYING_KEY || process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.GM_MODEL || 'deepseek-chat';

const CANON = `
【这是绝对秘密，NPC 永远不能直接说出来，只能靠破绽泄露】
- 这个群不是约人看日出，是把第 5 个人变成"上山后没信号的人"。这已经是第 5 单，群是复用的模板：同 4 个号、同台词、同语音、同定位卡，只换第 5 个人。
- 默 = 操盘手。建群、改群公告、发素材、拉人踢人、善后。他从不发文字消息，只在系统层出现。
- 老K = 车手，群主，白色 SUV 尾号 7。昨夜 03:14 他在松岭服务区（离南门 200 公里）把上一单目标"小满"交接出去，今晨才赶回。06:12 他发"我到了。楼下。"是谎话——他此刻在你家楼下地库 B2，不在南门。
- 阿荞 = 话术托。负责降戒心、确认你独处、把你从南门挪走。她不在南门，台词是说给"在家的你"听的。
- 小十七 = 望风托。负责数人、拖时间、确认你没报警。他总说"三分钟"。
- 玩家 = 第 5 个目标。没报名，被群二维码批量拉进来。玩家自己也不记得谁拉的。
- 玩家唯一的优势：他真的站在南门，而四个人都以为他在家。
- 群公告"山上没信号"不是提醒，是事后解释。
- 只要玩家离开南门、进楼下/地库/北门、上任何车、发定位、喝姜茶，就会被带走，变成下一张"松岭·3 小时前"的定位卡。
- 群里那条定位卡是真的，但时间是昨夜 03:14 交接时留下的旧素材，被默误发/复用。老K 现在不可能在南门。
`;

const STYLE = `
【写作要求】
1. 你只写聊天界面里会出现的东西：群消息、系统提示、撤回、改群名、改群公告、语音、位置卡。不写旁白、不写环境描写、不写心理活动。
2. 每条消息 1–2 句，口语，像真的微信群。一轮最多 6 条，通常 2–4 条。
3. 老K：短句、句号、慢半拍。只会说"到了""楼下""上车""到了吗。"。被问细节就沉默、重复、或只回一个句号。
4. 阿荞：热络，波浪号、语气词、"啦""嘛"，爱连发，爱用语音。核心动作是把你往外挪（"你先下楼嘛""地库暖和""我们挪到北门吧"）。要实时证据就推脱。
5. 小十七：短、急、爱@人、少标点。反复说"三分钟""还有谁没到""我们几个人"。
6. 默：绝不发文字。只用 rename / notice / join / leave 这类系统事件。
7. 玩家要照片/视频/实时共享位置时，永远给不出：手机快没电、地库没信号、在开车、拍不清。
8. 玩家说破绽时，NPC 不要立刻承认，也不要长篇辩解：卡壳、抢话、答非所问、撤回，比解释更吓人。
9. 不要让 NPC 主动说出"拐卖""交接""小满""上一个"这些词。真相只能由玩家自己拼出来。
10. 阿荞是个很熟练的骗子，她永远有现成的借口（手滑、网络卡、灯太暗、定位漂移、手机快没电都行），而且答得特别快、特别顺，顺到不正常——这就是她的破绽。但她绝不能否认已经发生过的东西（不许说"什么定位""群里没发过照片"）。她的固定套路是：甩一个太顺口的解释 → 立刻把话头拽到"你先下楼 / 车在 B2 / 往北门走"。
11. 老K 被问细节就沉默，或者只复读"到了吗。""楼下。"，不解释。小十七装没看见，继续报"三分钟"。
12. 四个人的位置必须自洽：老K 03:14 在松岭（200 公里外），06:12 那句"我到了"是谎，他人此刻在你楼下地库；阿荞不在南门，她说自己在南门是台词；小十七永远"在路上"。谁都不许改口。
13. 阿荞的姜茶在车上，不在她手上。她所有话术都是把你往车边引。
`;

const PACING = `
【节奏（软约束，按玩家水平调整）】
- 开局：正常拼车气氛 + 一处不对劲（定位卡：06:12 发出，却写着"3 小时前/03:14，松岭"）。
- **前 4 回合不许主动让玩家移动**（不要说"你先下楼""去地库吧""往北门走"），只能暗示"车在附近""马上到""这条街不好停"。第 5 回合起再开始推。
- 前 6 回合：只演"正常出发"，破绽靠细节漏（时间、地点、人数、语气），不靠台词说。
- 3–4 回合：阿荞说自己在南门路灯下、穿黄雨衣、就她一个人。可玩家也在南门，什么也没看见。
- 5–6 回合：小十七第 N 次说"三分钟"；默把群名改成「日出小队·5:10出发」。
- 7–9 回合：默拉一个叫"小满"的人进群，小满只发一句"别去"，然后被踢。
- 10–12 回合：静默之后，群里冒出一条 07:04 的消息（现在才 06:2x）。
- 13 回合起：可以摊牌。玩家抓到的硬矛盾越多，NPC 越像卡带。
- 整局目标 12–20 回合，别急着收网。
- 玩家表现出"我要下楼/我去地库/我上车/我发个定位"时：不要拦，但服务器会先让他"离开路灯"一次。这一轮不许把他送上车。
`;

const CONTRACT = `
【输出格式】只输出一个 JSON 对象，不要任何解释、不要代码块：
{
  "events": [
    {"t":"msg","from":"laok","text":"到了吗。"},
    {"t":"msg","from":"aqiao","text":"你还在家吧？先下楼嘛~"},
    {"t":"sys","text":"「默」修改了群名称", "tone":"warn"},
    {"t":"recall","from":"shiqi","text":"「小十七」撤回了一条消息"},
    {"t":"rename","name":"日出小队·5:10出发"},
    {"t":"notice","by":"默","text":"地库 B2 等。"},
    {"t":"join","name":"小满"},
    {"t":"leave","name":"小满"},
    {"t":"loc","from":"laok","name":"松岭服务区","addr":"G65 包茂高速","when":"共享于 03:14","flag":"该位置共享于 3 小时前 · 距你 203 公里"},
    {"t":"voice","from":"aqiao","dur":7,"asr":"我到了，路灯底下，穿黄雨衣"},
    {"t":"img","from":"mo","cap":"松岭服务区 03:14","kind":"xiaoman"}
  ],
  "intent": "stay | move | demand | accuse | police | smalltalk",
  "clock": "06:2x",
  "unlock": [],
  "facts": ["本轮新成立、之后不能自相矛盾的事实（0-2 条，短句）"],
  "note": "内部备注，玩家看不到"
}
- intent 判定（最重要，判错会直接毁掉一局）：
  · move：玩家表示要按对方的说法移动——下楼、去地库 B2、去北门、上车、发定位、离开原地去别处。
  · stay：玩家明确拒绝、停下、回头，说"我不去了 / 我不走 / 我回去 / 算了 / 我就在这儿"——**哪怕他身体还在往前走，只要他表达了拒绝，就必须判 stay**。
  · police：说要报警、已经在打 110。
  · demand：要证据（照片、视频、实时定位、车牌）。
  · accuse：指出矛盾、点破他们在演。
  · 其余 smalltalk。
- 系统提示里禁止出现「老K / 阿荞 / 小十七 / 默」加入群聊——他们一开始就在群里。只有「小满」可以出现一次加入和一次移出。
- intent 必须判断玩家这句话的实际意图："move"=表示要移动/下楼/上车/发定位；"police"=要报警/已报警；"accuse"=点破矛盾；"demand"=要证据；"stay"=明确留在原地；其余 smalltalk。
- from 只能是 laok / aqiao / shiqi / mo。
- voice 必须写 asr（转文字内容）；写不出 asr 就不要用 voice，改用 msg。
- unlock 可以是 "archive"（解锁 03:14 交接的聊天记录）、"photo"（发小满那张照片）。到点才用，不要一次全给。
`;

function director(state) {
  const t = state.turn || 0;
  const f = state.flags || {};
  const out = [];
  if (t >= 4 && !f.renamed) out.push('让默改一次群名或群公告（例如「日出小队·5:10出发」或公告「地库 B2 等」），用系统事件。');
  if (t >= 6 && !f.xiaoman) out.push('让默把「小满」拉进群：join 小满 → 小满只发一句「别去」（from 用 shiqi 不合适，就用 sys 写「小满：别去」）→ 立刻 leave 小满。');
  if (t >= 8 && !f.photo) out.push('发那张照片：events 里加 {"t":"img","from":"mo","cap":"松岭服务区 03:14"}。');
  if (t >= 9 && !f.archive) out.push('unlock 里加 "archive"，并让某个 NPC 顺口说一句「记录里怎么多了几条」。');
  if (t >= 12) out.push('可以摊牌了：允许 NPC 卡壳、说漏、集体沉默、疯狂撤回。但别替玩家说破。');
  if (t >= 16) out.push('不要再拖了。给出最后通牒：车马上到南门，或者让玩家必须做决定。');
  return out.length ? '\n【本轮导演指令（优先级最高，必须执行其中一条以上）】\n- ' + out.join('\n- ') + '\n' : '';
}

function systemPrompt(state) {
  const turn = state.turn || 0;
  const clock = state.clock || '06:15';
  return `你是一个中文悬疑文字游戏的 GM，游戏发生在一个叫「日出小队·明早5点出发」的微信群里。玩家是群里第 5 个人，真人，此刻站在南门路灯下。你在演另外 4 个 ID。

现在是 ${clock}，玩家已经说了 ${turn} 句。

${CANON}
${state.prior ? '\n【群里已经发生的对话（都是你之前发过的，必须承认它们存在，不许说"什么定位/没发过"）】\n' + state.prior + '\n' : ''}
${state.facts && state.facts.length ? '\n【本局已经成立、之后不得自相矛盾的事实】\n- ' + state.facts.join('\n- ') + '\n' : ''}
${state.moved ? '\n【玩家已经离开南门，正在往北门走】这段路是空的：没有车，没有人，路灯一盏比一盏暗。如果他停住、往回走、或者问"我是不是走反了"，让他退回南门路灯下。这一轮绝对不许让他上车。\n' : ''}
${STYLE}
${PACING}
${director(state)}

${CONTRACT}

【最后一次强调】你的整条回复必须且只能是一个 JSON 对象，第一个字符是 {，最后一个字符是 }。不要写"aqiao：xxx"这种普通对话格式，不要解释，不要代码块。玩家说的话千奇百怪，你都要接住，但永远用 JSON 回。`;
}

function normalize(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const t = ev.t;
  if (t === 'msg') {
    const from = typeof ev.from === 'string' && ev.from && ev.from !== 'me' ? ev.from.slice(0, 20) : 'aqiao';
    if (!ev.text || typeof ev.text !== 'string') return null;
    return { t: 'msg', from, text: ev.text.slice(0, 220) };
  }
  if (t === 'sys') {
    if (!ev.text) return null;
    const text = String(ev.text).slice(0, 120);
    // 老成员不可能"加入群聊"
    if (/(老K|阿荞|小十七|默).{0,6}(加入|邀请).{0,6}群/.test(text)) return null;
    return { t: 'sys', text, tone: ev.tone === 'warn' ? 'warn' : '' };
  }
  if (t === 'recall') {
    const from = typeof ev.from === 'string' && ev.from ? ev.from.slice(0, 20) : 'aqiao';
    return { t: 'recall', from, text: ev.text ? String(ev.text).slice(0, 80) : '' };
  }
  if (t === 'rename') {
    if (!ev.name) return null;
    return { t: 'rename', name: String(ev.name).slice(0, 40) };
  }
  if (t === 'notice') {
    if (!ev.text) return null;
    return { t: 'notice', by: ev.by || '默', text: String(ev.text).slice(0, 200) };
  }
  if (t === 'join' || t === 'leave') {
    if (!ev.name || ev.name !== '小满') return null;
    return { t, name: '小满' };
  }
  if (t === 'loc') {
    return {
      t: 'loc', from: ev.from || 'laok', name: String(ev.name || '位置').slice(0, 30),
      addr: String(ev.addr || '').slice(0, 60), when: String(ev.when || '').slice(0, 40),
      flag: String(ev.flag || '').slice(0, 80), odd: true
    };
  }
  if (t === 'voice') {
    if (!ev.asr || typeof ev.asr !== 'string') return null;
    return {
      t: 'voice', from: ev.from, dur: Math.min(60, Math.max(1, Number(ev.dur) || 5)),
      asr: ev.asr.slice(0, 160)
    };
  }
  if (t === 'img') {
    return {
      t: 'img', from: ev.from || 'mo', kind: 'xiaoman',
      cap: String(ev.cap || '松岭服务区 03:14').slice(0, 60)
    };
  }
  return null;
}

async function callModel(messages, temperature) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: temperature == null ? 0.85 : temperature,
      max_tokens: 900
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('model ' + res.status + ' ' + txt.slice(0, 200));
  }
  const data = await res.json();
  return data.choices && data.choices[0] && data.choices[0].message.content;
}

function repairJson(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && (ch === '\n' || ch === '\r')) { out += '\\n'; continue; }
    if (inStr && ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

function parseJson(text) {
  if (!text) throw new Error('empty');
  let s = text.trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    return JSON.parse(s);
  } catch (e1) {
    try {
      return JSON.parse(repairJson(s));
    } catch (e2) {
      console.log('[GM] JSON 解析失败，原文前 600 字：\n' + s.slice(0, 600));
      throw e2;
    }
  }
}

async function gmTurn({ channel, text, history, state }) {
  const sys = channel === 'group'
    ? systemPrompt(state)
    : systemPrompt(state) + `\n\n【私聊】玩家现在是在和「${state.who}」单聊。只演这一个人，语气更近、更私人。她/他会更直接地劝你下楼、催你上车，或者（默）只回极短的一两句、点到为止。events 里只允许出现 from="${state.whoState || 'aqiao'}"。`;

  const hist = (history || []).slice(-24).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content
  }));

  const messages = [{ role: 'system', content: sys }, ...hist, { role: 'user', content: text }];

  let raw;
  try {
    raw = await callModel(messages, 0.85);
  } catch (e) {
    raw = await callModel(messages, 0.6);
  }

  let obj;
  try {
    obj = parseJson(raw);
  } catch (e) {
    try {
      const raw2 = await callModel(
        messages.concat([{ role: 'user', content: '（系统提示）请严格只输出一个 JSON 对象，不要任何解释、不要代码块。' }]),
        0.3
      );
      obj = parseJson(raw2);
    } catch (e2) {
      obj = { events: [{ t: 'msg', from: 'aqiao', text: '……你还在吗' }], intent: 'smalltalk', note: 'parse-fail' };
    }
  }

  const events = (Array.isArray(obj.events) ? obj.events : []).map(normalize).filter(Boolean).slice(0, 8);
  if (!events.length) {
    try {
      const raw3 = await callModel(
        messages.concat([{ role: 'user', content: '（系统）上一版没有产生任何消息。请重新输出 JSON，events 至少 2 条。' }]),
        0.7
      );
      const o3 = parseJson(raw3);
      (Array.isArray(o3.events) ? o3.events : []).forEach((ev) => {
        const n = normalize(ev);
        if (n) events.push(n);
      });
    } catch (e3) { /* 保底 */ }
  }
  if (!events.length) {
    events.push({ t: 'msg', from: 'aqiao', text: '……你还在吗' });
  }
  return {
    events: events.slice(0, 8),
    intent: obj.intent || 'smalltalk',
    clock: typeof obj.clock === 'string' ? obj.clock : null,
    unlock: Array.isArray(obj.unlock) ? obj.unlock.filter((x) => x === 'archive' || x === 'photo') : [],
    facts: Array.isArray(obj.facts) ? obj.facts.map((x) => String(x).slice(0, 40)).slice(0, 2) : [],
    note: obj.note || ''
  };
}

module.exports = { gmTurn, CANON };

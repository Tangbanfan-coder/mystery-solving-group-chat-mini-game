// GM：把剧本（scenario）交给模型现场演。这个文件不含任何具体剧情。
const fs = require('fs');
const path = require('path');

const API = 'https://api.deepseek.com/chat/completions';
const KEY = process.env.ROLE_PLAYING_KEY || process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.GM_MODEL || 'deepseek-chat';
const ROOT = __dirname;
const SCEN_DIR = path.join(ROOT, 'scenarios');

const DEFAULT_PROTOCOL = `
【输出格式】只输出一个 JSON 对象，不要任何解释、不要代码块：
{
  "events": [
    {"t":"msg","from":"laok","text":"到了吗。"},
    {"t":"sys","text":"「默」修改了群名称","tone":"warn"},
    {"t":"recall","from":"shiqi","text":"「小十七」撤回了一条消息"},
    {"t":"rename","name":"日出小队·5:10出发"},
    {"t":"notice","by":"默","text":"地库 B2 等。"},
    {"t":"join","name":"小满"},
    {"t":"leave","name":"小满","text":"「小满」已被移出群聊"},
    {"t":"loc","from":"laok","name":"松岭服务区","addr":"G65 包茂高速","when":"共享于 03:14","flag":"该位置共享于 3 小时前","odd":true},
    {"t":"voice","from":"aqiao","dur":7,"asr":"转文字内容"},
    {"t":"img","from":"mo","cap":"图片说明","kind":"xiaoman"}
  ],
  "intent": "stay | move | demand | accuse | police | smalltalk",
  "clock": "06:2x",
  "unlock": [],
  "facts": ["本轮新成立、之后不能自相矛盾的事实（0-2 条，短句）"],
  "note": "内部备注，玩家看不到"
}

- intent 判定（最重要，判错会直接毁掉一局）：
  · move：玩家表示要按对方的说法移动——下楼、去地库、去另一个门、上车、发定位、离开原地去别处。
  · stay：玩家明确拒绝、停下、回头，说"我不去了 / 我不走 / 我回去 / 算了 / 我就在这儿"——**哪怕他身体还在往前走，只要他表达了拒绝，就必须判 stay**。
  · police：说要报警、已经在打 110。
  · demand：要证据（照片、视频、实时定位、车牌）。
  · accuse：指出矛盾、点破他们在演。
  · 其余 smalltalk。
- from 只能填剧本里已有的角色 id。
- voice 必须写 asr；写不出 asr 就不要用 voice，改用 msg。
- 已经死了/已经退群的角色，不能再发言。
- 系统提示里禁止出现核心成员"加入群聊"——他们一开始就在群里。guest 只能出现一次加入、一次移出。
`;

/* ---------------- 剧本加载 ---------------- */

function safeRead(p, fallback) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return fallback || ''; }
}

function loadScenario(id) {
  const dir = path.join(SCEN_DIR, id);
  const raw = safeRead(path.join(dir, 'scenario.json'));
  if (!raw) throw new Error('scenario not found: ' + id);
  const sc = JSON.parse(raw);
  sc.id = sc.id || id;
  sc.dir = dir;
  sc.canon = safeRead(path.join(dir, 'canon.md'));
  sc.style = safeRead(path.join(dir, 'style.md'));
  sc.pacing = safeRead(path.join(dir, 'pacing.md'));
  sc.protocol = safeRead(path.join(dir, 'protocol.md')) || DEFAULT_PROTOCOL;
  sc.assets = sc.assets || {};
  return sc;
}

function listScenarios() {
  try {
    const idx = JSON.parse(safeRead(path.join(SCEN_DIR, 'index.json'), '{"scenarios":[]}'));
    return idx.scenarios.map((id) => {
      try {
        const sc = loadScenario(id);
        return { id: sc.id, title: sc.title || id, subtitle: sc.subtitle || '', cover: sc.cover || '💬' };
      } catch (e) {
        return { id, title: id, subtitle: '（剧本读取失败）', cover: '⚠️' };
      }
    });
  } catch (e) {
    return [];
  }
}

/* ---------------- 提示词拼装 ---------------- */

function sceneOf(sc) {
  const sys = (sc.intro || []).filter((m) => m.t === 'sys');
  return sys.length ? sys[sys.length - 1].text : '';
}

function directorBlock(sc, state) {
  const t = state.turn || 0;
  const f = state.flags || {};
  const hits = (sc.director || []).filter((d) => t >= d.atTurn && (!d.unlessFlag || !f[d.unlessFlag]));
  if (!hits.length) return '';
  return '\n【本轮导演指令（优先级最高，必须执行其中一条以上）】\n- ' + hits.map((d) => d.text).join('\n- ') + '\n';
}

function systemPrompt(sc, state) {
  const members = (sc.meta.members || []).filter((m) => m.id !== 'me');
  const n = members.length;
  const names = members.map((m) => m.id + '=' + m.name).join('、');
  const turn = state.turn || 0;
  const clock = state.clock || sc.meta.startClock;
  const scene = sceneOf(sc);

  return `你是一个中文文字游戏的 GM。游戏发生在一个叫「${sc.meta.groupName}」的微信群里。玩家是群里的一个真人，你在演另外 ${n} 个 ID（${names}）。

现在是 ${clock}，玩家已经说了 ${turn} 句。
${scene ? '玩家此刻：' + scene + '\n' : ''}
${sc.canon}

${state.prior ? '【群里已经发生的对话（都是你之前发过的，必须承认它们存在，不许说"什么定位/没发过"）】\n' + state.prior + '\n' : ''}
${state.facts && state.facts.length ? '【本局已经成立、之后不得自相矛盾的事实】\n- ' + state.facts.join('\n- ') + '\n' : ''}
${state.moved ? '【玩家已经离开原地，正在移动】这段路是空的：没有车，没有人。如果他停住、往回走，让他退回去。这一轮绝对不许让他上车。\n' : ''}
${sc.style}
${sc.pacing}
${directorBlock(sc, state)}

${sc.protocol}

【最后一次强调】你的整条回复必须且只能是一个 JSON 对象，第一个字符是 {，最后一个字符是 }。不要写"某某：xxx"这种普通对话格式，不要解释，不要代码块。玩家说的话千奇百怪，你都要接住，但永远用 JSON 回。`;
}

/* ---------------- 事件校验 ---------------- */

function makeNormalizer(sc) {
  const core = new Set((sc.meta.members || []).map((m) => m.name));
  const ids = new Set((sc.meta.members || []).map((m) => m.id));
  const guestOk = (name) => !!name && !core.has(name);

  return function normalize(ev) {
    if (!ev || typeof ev !== 'object') return null;
    const pick = (id) => (typeof id === 'string' && ids.has(id) && id !== 'me' ? id : null);
    const t = ev.t;
    if (t === 'msg') {
      const from = pick(ev.from) || (typeof ev.from === 'string' && ev.from.startsWith('guest:') ? ev.from : 'aqiao');
      if (!ev.text || typeof ev.text !== 'string') return null;
      return { t: 'msg', from, text: ev.text.slice(0, 240) };
    }
    if (t === 'sys') {
      if (!ev.text) return null;
      const text = String(ev.text).slice(0, 140);
      const joined = Array.from(core).some((n) => new RegExp(n + '.{0,8}(加入|邀请).{0,6}群').test(text));
      if (joined) return null;
      return { t: 'sys', text, tone: ev.tone === 'warn' ? 'warn' : '' };
    }
    if (t === 'recall') {
      const from = pick(ev.from) || (typeof ev.from === 'string' && ev.from.startsWith('guest:') ? ev.from : 'aqiao');
      return { t: 'recall', from, text: String(ev.text || '').slice(0, 90) };
    }
    if (t === 'rename') {
      if (!ev.name) return null;
      return { t: 'rename', name: String(ev.name).slice(0, 48) };
    }
    if (t === 'notice') {
      if (!ev.text) return null;
      return { t: 'notice', by: ev.by || '', text: String(ev.text).slice(0, 240) };
    }
    if (t === 'join' || t === 'leave') {
      if (!guestOk(ev.name)) return null;
      const name = String(ev.name).slice(0, 24);
      return { t, name, text: ev.text ? String(ev.text).slice(0, 60) : '' };
    }
    if (t === 'loc') {
      return {
        t: 'loc', from: pick(ev.from) || 'laok', name: String(ev.name || '位置').slice(0, 32),
        addr: String(ev.addr || '').slice(0, 64), when: String(ev.when || '').slice(0, 44),
        flag: String(ev.flag || '').slice(0, 90), odd: true
      };
    }
    if (t === 'voice') {
      if (!ev.asr || typeof ev.asr !== 'string') return null;
      const from = pick(ev.from) || 'aqiao';
      return { t: 'voice', from, dur: Math.min(60, Math.max(1, Number(ev.dur) || 5)), asr: ev.asr.slice(0, 180) };
    }
    if (t === 'img') {
      const kind = String(ev.kind || '');
      if (!sc.assets[kind]) return null;
      return { t: 'img', from: pick(ev.from) || 'mo', kind, cap: String(ev.cap || '').slice(0, 70) };
    }
    return null;
  };
}

/* ---------------- 调用模型 ---------------- */

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
  try { return JSON.parse(s); } catch (e1) {
    try { return JSON.parse(repairJson(s)); } catch (e2) {
      console.log('[GM] JSON 解析失败，原文前 600 字：\n' + s.slice(0, 600));
      throw e2;
    }
  }
}

async function gmTurn({ scenario, channel, text, history, state }) {
  let sys = systemPrompt(scenario, state);
  if (channel !== 'group' && state.who) {
    const name = (scenario.meta.members.find((m) => m.id === state.who) || {}).name || state.who;
    sys += `\n\n【私聊】玩家现在是在和「${name}」单聊。只演这一个人，语气更近、更私人。events 里 from 只能填 "${state.who}"。`;
  }

  const hist = (history || []).slice(-24).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
  const messages = [{ role: 'system', content: sys }, ...hist, { role: 'user', content: text }];

  let raw;
  try { raw = await callModel(messages, 0.85); } catch (e) { raw = await callModel(messages, 0.6); }

  let obj;
  try { obj = parseJson(raw); } catch (e) {
    try {
      const raw2 = await callModel(messages.concat([{ role: 'user', content: '（系统）请严格只输出一个 JSON 对象，不要任何解释、不要代码块。' }]), 0.3);
      obj = parseJson(raw2);
    } catch (e2) {
      obj = { events: [], intent: 'smalltalk' };
    }
  }

  const normalize = makeNormalizer(scenario);
  let events = (Array.isArray(obj.events) ? obj.events : []).map(normalize).filter(Boolean).slice(0, 8);

  if (!events.length) {
    try {
      const raw3 = await callModel(messages.concat([{ role: 'user', content: '（系统）上一版没有产生任何消息。请重新输出 JSON，events 至少 2 条。' }]), 0.7);
      const o3 = parseJson(raw3);
      events = (Array.isArray(o3.events) ? o3.events : []).map(normalize).filter(Boolean);
    } catch (e3) { /* 保底下面处理 */ }
  }
  if (!events.length) {
    const fallback = (scenario.meta.members.find((m) => m.id === 'aqiao') || scenario.meta.members[1] || {}).id || 'aqiao';
    events = [{ t: 'msg', from: fallback, text: '……你还在吗' }];
  }

  return {
    events: events.slice(0, 8),
    intent: obj.intent || 'smalltalk',
    clock: typeof obj.clock === 'string' ? obj.clock : null,
    unlock: Array.isArray(obj.unlock) ? obj.unlock.map(String).slice(0, 3) : [],
    facts: Array.isArray(obj.facts) ? obj.facts.map((x) => String(x).slice(0, 48)).slice(0, 2) : [],
    note: obj.note || ''
  };
}

module.exports = { gmTurn, loadScenario, listScenarios, API, KEY };

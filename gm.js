// 群聊解密 · 多 agent 引擎
// 导演（知道全部真相）决定这一轮谁开口、玩家想干什么；
// 演员（每人一份独立上下文，只知道自己的事）各写各的台词。
// 这个文件不含任何具体剧情。
const fs = require('fs');
const path = require('path');

const API = 'https://api.deepseek.com/chat/completions';
const KEY = process.env.ROLE_PLAYING_KEY || process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.GM_MODEL || 'deepseek-chat';
const DIRECTOR_MODEL = process.env.DIRECTOR_MODEL || MODEL;
const ROOT = __dirname;
const SCEN_DIR = path.join(ROOT, 'scenarios');

const DIRECTOR_PROTOCOL = `
【导演输出格式】只输出一个 JSON 对象：
{
  "intent": "stay | move | demand | accuse | police | smalltalk",
  "speakers": [ { "id": "aqiao", "goal": "这一轮她想干什么（一句话）" } ],
  "clock": "06:2x",
  "unlock": [],
  "note": "内部备注"
}
- intent 判定（最重要，判错会直接毁掉一局）：
  · move：玩家表示要按对方的说法移动——下楼、去地库、去另一个门、上车、发定位、离开原地去别处。
  · stay：玩家明确拒绝、停下、回头，说"我不去了 / 我不走 / 我回去 / 算了 / 我就在这儿"——**哪怕他身体还在往前走，只要他表达了拒绝，就必须判 stay**。
  · police：说要报警、已经在打 110。
  · demand：要证据（照片、视频、实时定位、车牌）。
  · accuse：指出矛盾、点破他们在演。
  · 其余 smalltalk。
- speakers 最多 2 个，**优先只点 1 个**。真人群里不是所有人一起说话，一轮一两个人足够，其余人潜水。
- 默（mo）如果要动，只能给一个 goal，让演员去发系统事件。
`;

const ACTOR_PROTOCOL = `
【输出格式】只输出一个 JSON 对象，不要解释、不要代码块：
{ "events": [ { "t": "msg", "text": "你说的话" } ], "facts": ["这一轮成立的事（可空）"] }
- 一次最多 2 条 events，第二条通常更短（3–10 个字）。不要一口气说三句长话。
- 只写你自己发的消息，不要替别人说话，不要写旁白、不要写动作描写。
- 不要解释设定，不要复述秘密。
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
  sc.assets = sc.assets || {};
  sc.cast = sc.cast || {};
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

/* ---------------- 工具 ---------------- */

function memberMap(sc) {
  const map = {};
  (sc.meta.members || []).forEach((m) => { map[m.id] = m; });
  return map;
}

function sceneOf(sc) {
  const sys = (sc.intro || []).filter((m) => m.t === 'sys');
  return sys.length ? sys[sys.length - 1].text : '';
}

function transcriptOf(history, sc, limit) {
  const map = memberMap(sc);
  const out = [];
  (history || []).forEach((m) => {
    if (m.role === 'user') {
      out.push('玩家：' + String(m.content || '').replace(/^（私聊）/, ''));
      return;
    }
    try {
      const o = JSON.parse(m.content);
      (o.events || []).forEach((e) => {
        if (e.t === 'msg') out.push((map[e.from] ? map[e.from].name : e.from) + '：' + e.text);
        else if (e.t === 'sys') out.push('· ' + e.text);
        else if (e.t === 'rename') out.push('· 群名被改成「' + e.name + '」');
        else if (e.t === 'notice') out.push('· 群公告被改成「' + e.text + '」');
        else if (e.t === 'join') out.push('· 「' + e.name + '」加入了群聊');
        else if (e.t === 'leave') out.push('· 「' + e.name + '」离开了群聊');
        else if (e.t === 'recall') out.push('· ' + (map[e.from] ? map[e.from].name : e.from) + ' 撤回了一条消息');
      });
    } catch (e) { /* 忽略 */ }
  });
  return out.slice(-(limit || 18)).join('\n');
}

function directorBlock(sc, state) {
  const t = state.turn || 0;
  const f = state.flags || {};
  const hits = (sc.director || []).filter((d) => t >= d.atTurn && (!d.unlessFlag || !f[d.unlessFlag]));
  if (!hits.length) return '';
  return '\n【本轮导演指令（必须执行其中一条以上）】\n- ' + hits.map((d) => d.text).join('\n- ') + '\n';
}

/* ---------------- 模型调用 ---------------- */

async function callModel(messages, temperature, model) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: model || MODEL,
      messages,
      temperature: temperature == null ? 0.85 : temperature,
      max_tokens: 700
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
    try { return JSON.parse(repairJson(s)); } catch (e2) { throw e2; }
  }
}

async function askJson(messages, temperature, model) {
  let raw;
  try { raw = await callModel(messages, temperature, model); } catch (e) { raw = await callModel(messages, 0.5, model); }
  try {
    return parseJson(raw);
  } catch (e) {
    const raw2 = await callModel(messages.concat([{ role: 'user', content: '（系统）只输出一个 JSON 对象，不要任何其他文字。' }]), 0.3, model);
    return parseJson(raw2);
  }
}

/* ---------------- 导演 ---------------- */

function directorMessages(sc, state, text) {
  const members = (sc.meta.members || []).filter((m) => m.id !== 'me');
  const castLines = members.map((m) => {
    const c = sc.cast[m.id] || {};
    return `- ${m.id}（${m.name}）：知道=${c.knows || '—'}｜想要=${c.wants || '—'}`;
  }).join('\n');

  const sys = `你是这个文字游戏的总导演。游戏发生在一个叫「${sc.meta.groupName}」的微信群里，玩家是群里的一个真人。你在决定这一轮：玩家想干什么、谁该开口。

现在 ${state.clock || sc.meta.startClock}，已经进行了 ${state.turn || 0} 轮。玩家此刻：${sceneOf(sc)}

【完整真相（只有你知道，演员不知道）】
${sc.canon}

【角色与他们的认知边界】
${castLines}

【全部角色的人设与文风】
${sc.style}

【节奏】
${sc.pacing}
${directorBlock(sc, state)}
${state.prior ? '【群里已经发生的对话】\n' + state.prior + '\n' : ''}
${state.facts && state.facts.length ? '【已经成立、不得自相矛盾的事实】\n- ' + state.facts.join('\n- ') + '\n' : ''}
${state.moved ? '【玩家已经离开原地，正在移动】这一轮不许让他上车。\n' : ''}
【最近几轮】
${transcriptOf(state.history, sc, 14) || '（还没有）'}

${DIRECTOR_PROTOCOL}`;

  return [{ role: 'system', content: sys }, { role: 'user', content: text }];
}

async function direct(sc, state, text) {
  const obj = await askJson(directorMessages(sc, state, text), 0.7, DIRECTOR_MODEL);
  const valid = (sc.meta.members || []).map((m) => m.id);
  let speakers = Array.isArray(obj.speakers) ? obj.speakers : [];
  speakers = speakers
    .filter((s) => s && valid.includes(s.id) && s.id !== 'me')
    .slice(0, 2)
    .map((s) => ({ id: s.id, goal: String(s.goal || '').slice(0, 80) }));
  return {
    intent: obj.intent || 'smalltalk',
    speakers,
    clock: typeof obj.clock === 'string' ? obj.clock : null,
    unlock: Array.isArray(obj.unlock) ? obj.unlock.map(String).slice(0, 3) : [],
    note: obj.note || ''
  };
}

/* ---------------- 演员 ---------------- */

function actorMessages(sc, state, actor, brief) {
  const map = memberMap(sc);
  const c = sc.cast[actor.id] || {};
  const others = (sc.meta.members || [])
    .filter((m) => m.id !== 'me' && m.id !== actor.id)
    .map((m) => m.name).join('、');

  const sys = `你是「${map[actor.id] ? map[actor.id].name : actor.id}」，在一个叫「${sc.meta.groupName}」的微信群里。现在是 ${state.clock || sc.meta.startClock}。
群里还有：${others}，还有一个玩家（群里显示为「你」，提到他时就用「你」，要 @ 就写「@你」）。

【你知道的】
${c.knows || ''}

【你想要的】
${c.wants || ''}

【你怎么说话】
${c.voice || ''}

【铁律】
1. 你只知道自己上面写的那些事。你不知道的，就是不知道，不要编，也不要突然知道。
2. 不要说出你的秘密，不要解释设定，不要跳出角色。
3. 群里的消息你都能看见（下面就是），但你只回你想回的。

【群里最近发生的事】
${transcriptOf(state.history, sc, 16) || '（群里还很安静）'}

【这一轮你打算】
${brief || '随便说一句，符合你的性格。'}

${ACTOR_PROTOCOL}`;

  return [{ role: 'system', content: sys }, { role: 'user', content: '（按上面这一轮的目标，输出你的 JSON）' }];
}

const ACTOR_TYPES = new Set(['msg', 'voice', 'recall', 'sys', 'rename', 'notice', 'join', 'leave']);

async function act(sc, state, actor, brief) {
  const obj = await askJson(actorMessages(sc, state, actor, brief), 0.9, MODEL);
  const map = memberMap(sc);
  const core = new Set((sc.meta.members || []).map((m) => m.name));
  const admins = sc.meta.adminIds || ['laok', 'mo'];
  const canSystem = admins.includes(actor.id);

  const events = [];
  (Array.isArray(obj.events) ? obj.events : []).forEach((e) => {
    if (!e || !ACTOR_TYPES.has(e.t)) return;
    if (e.t === 'msg') {
      if (!e.text) return;
      events.push({ t: 'msg', from: actor.id, text: String(e.text).slice(0, 200) });
    } else if (e.t === 'voice') {
      if (!e.asr) return;
      events.push({ t: 'voice', from: actor.id, dur: Math.min(60, Math.max(1, Number(e.dur) || 5)), asr: String(e.asr).slice(0, 160) });
    } else if (e.t === 'recall') {
      events.push({ t: 'recall', from: actor.id, text: String(e.text || '').slice(0, 80) });
    } else if (e.t === 'sys') {
      if (!e.text) return;
      const text = String(e.text).slice(0, 120);
      if (Array.from(core).some((n) => new RegExp(n + '.{0,8}(加入|邀请).{0,6}群').test(text))) return;
      events.push({ t: 'sys', text, tone: e.tone === 'warn' ? 'warn' : '' });
    } else if (e.t === 'rename' && canSystem && e.name) {
      events.push({ t: 'rename', name: String(e.name).slice(0, 48) });
    } else if (e.t === 'notice' && canSystem && e.text) {
      events.push({ t: 'notice', by: actor.id, text: String(e.text).slice(0, 220) });
    } else if ((e.t === 'join' || e.t === 'leave') && canSystem && e.name && !core.has(e.name)) {
      events.push({ t: e.t, name: String(e.name).slice(0, 24), text: String(e.text || '').slice(0, 60) });
    }
  });

  const facts = Array.isArray(obj.facts) ? obj.facts.map((x) => String(x).slice(0, 48)).slice(0, 2) : [];
  return { events: events.slice(0, 2), facts };
}

/* ---------------- 回合 ---------------- */

async function gmTurn({ scenario, channel, text, history, state }) {
  const sc = scenario;
  const st = Object.assign({}, state, { history: history || [] });

  let d;
  try {
    d = await direct(sc, st, text);
  } catch (e) {
    console.log('[director] 失败：' + e.message);
    d = { intent: 'smalltalk', speakers: [{ id: pickFallback(sc), goal: '接一句' }], clock: null, unlock: [], note: 'director-fallback' };
  }

  if (!d.speakers.length) {
    d.speakers = [{ id: pickFallback(sc), goal: '接一句，别让场面冷掉' }];
  }
  if (channel !== 'group') {
    d.speakers = [{ id: state.who, goal: '玩家在私聊你，回他' }].filter((s) => s.id);
    if (!d.speakers.length) d.speakers = [{ id: pickFallback(sc), goal: '接一句' }];
  }

  const results = await Promise.all(d.speakers.map((s) => act(sc, st, s, s.goal).catch((e) => {
    console.log('[actor:' + s.id + '] 失败：' + e.message);
    return { events: [], facts: [] };
  })));

  const events = [];
  const facts = [];
  results.forEach((r) => {
    (r.events || []).forEach((e) => events.push(e));
    (r.facts || []).forEach((f) => facts.push(f));
  });

  if (!events.length) {
    events.push({ t: 'msg', from: d.speakers[0].id, text: '……' });
  }

  return {
    events: events.slice(0, 8),
    intent: d.intent,
    clock: d.clock,
    unlock: d.unlock,
    facts: facts.slice(0, 3),
    note: d.note
  };
}

function pickFallback(sc) {
  const ids = (sc.meta.members || []).map((m) => m.id).filter((id) => id !== 'me');
  return ids[1] || ids[0] || 'npc';
}

module.exports = { gmTurn, loadScenario, listScenarios, API, KEY };

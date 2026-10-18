// 群聊解密 · v5 引擎
// GM（知道全部真相）判断玩家在干什么、世界怎么变、谁开口、该不该结局；
// 演员（每人一份独立上下文）只知道自己的事，只写自己的台词。
// 这个文件不含任何具体剧情，也不做关键词/正则匹配。
const fs = require('fs');
const path = require('path');

const API = 'https://api.deepseek.com/chat/completions';
const KEY = process.env.ROLE_PLAYING_KEY || process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.GM_MODEL || 'deepseek-chat';
const GM_MODEL = process.env.DIRECTOR_MODEL || MODEL;
const ROOT = __dirname;
const SCEN_DIR = path.join(ROOT, 'scenarios');

const STATE_BYTES = 8 * 1024;
const MAX_FACTS = 30;
const MAX_MEMORY = 12;
const GM_EVENT_TYPES = new Set(['sys', 'notice', 'rename', 'join', 'leave', 'img', 'loc']);
const ACTOR_EVENT_TYPES = new Set(['msg', 'voice', 'recall']);
const PLAYER_AT = new Set(['south_gate', 'walking', 'home', 'b2', 'car', 'unknown']);

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
  sc.assets = sc.assets || {};
  sc.cast = sc.cast || {};
  sc.state = sc.state || { initial: {} };
  sc.state.initial = sc.state.initial || {};
  sc.arc = sc.arc || [];
  sc.endings = sc.endings || [];
  sc.rules = sc.rules || {};
  sc.setpieces = sc.setpieces || [];
  sc.codebook = sc.codebook || {};
  sc.canon = safeRead(path.join(dir, sc.canon || 'canon.md'));
  sc.style = safeRead(path.join(dir, sc.style || 'style.md'));
  sc.gmNotes = sc.gmNotes || '';
  validateScenario(sc);
  return sc;
}

function validateScenario(sc) {
  if (!sc || sc.version !== 5) throw new Error('scenario version must be 5');
  if (!sc.id) throw new Error('scenario id missing');
  if (!sc.meta || !Array.isArray(sc.meta.members)) throw new Error('meta.members missing');
  const ids = sc.meta.members.map((m) => m.id);
  if (!ids.includes('me')) throw new Error('meta.members must include me');
  if (!sc.meta.groupName) throw new Error('meta.groupName missing');
  if (!sc.canon) throw new Error('canon missing');
  for (const m of sc.meta.members) {
    if (m.id === 'me') continue;
    if (!sc.cast[m.id]) throw new Error('cast missing: ' + m.id);
  }
  if (!Array.isArray(sc.endings) || !sc.endings.length) throw new Error('endings missing');
  const eids = new Set();
  for (const e of sc.endings) {
    if (!e.id || eids.has(e.id)) throw new Error('ending id invalid/duplicate');
    eids.add(e.id);
    if (!e.when || !e.text) throw new Error('ending when/text missing: ' + e.id);
    if (e.minTurn != null && (!Number.isFinite(e.minTurn) || e.minTurn < 1)) throw new Error('ending minTurn invalid: ' + e.id);
    if (e.trigger != null && !plainObject(e.trigger)) throw new Error('ending trigger invalid: ' + e.id);
  }
  const max = Number(sc.rules && sc.rules.maxTurns);
  if (!Number.isFinite(max) || max < 2) throw new Error('rules.maxTurns invalid');
  if (sc.rules.defaultEnding && !eids.has(sc.rules.defaultEnding)) throw new Error('defaultEnding not found: ' + sc.rules.defaultEnding);
  for (const e of sc.endings) {
    if (e.minTurn && e.minTurn > max) throw new Error('ending minTurn > maxTurns: ' + e.id);
  }
  if (sc.state.initial != null && !plainObject(sc.state.initial)) throw new Error('state.initial must be object');
  const aids = new Set();
  for (const a of sc.arc) {
    if (!a.id || aids.has(a.id)) throw new Error('arc id invalid/duplicate');
    aids.add(a.id);
  }
  const sids = new Set();
  for (const s of sc.setpieces) {
    if (!s.id || sids.has(s.id)) throw new Error('setpiece id invalid/duplicate');
    sids.add(s.id);
    if (!Array.isArray(s.events)) throw new Error('setpiece events missing: ' + s.id);
  }
}

// 列表页需要的摘要一次算好：头像、最后一条消息、成员数，避免前端逐条回查。
function summarize(sc, id) {
  const members = (sc.meta && sc.meta.members) || [];
  const names = {};
  members.forEach((m) => { names[m.id] = m.name; });

  let clock = '';
  let preview = null;
  (sc.intro || []).forEach((m) => {
    if (m.t === 'time') { clock = m.v || ''; return; }
    if (m.t !== 'msg') return;
    preview = {
      who: names[m.from] || String(m.from || '').replace(/^u:/, ''),
      text: String(m.text || '').slice(0, 80),
      time: clock
    };
  });

  return {
    id: sc.id || id,
    title: sc.title || id,
    subtitle: sc.subtitle || '',
    cover: sc.cover || '',
    memberCount: members.length,
    avatars: members.filter((m) => m.id !== 'me').slice(0, 4).map((m) => ({
      a: m.a || String(m.name || '?').slice(-1),
      c1: m.c1 || '#8a8a8a',
      c2: m.c2 || '#5f5f5f'
    })),
    preview: preview
  };
}

function listScenarios() {
  try {
    const idx = JSON.parse(safeRead(path.join(SCEN_DIR, 'index.json'), '{"scenarios":[]}'));
    return idx.scenarios.map((id) => {
      try {
        return summarize(loadScenario(id), id);
      } catch (e) {
        return { id, title: id, subtitle: '（剧本读取失败）', cover: '', memberCount: 0, avatars: [], preview: null };
      }
    });
  } catch (e) {
    return [];
  }
}

/* ---------------- 工具 ---------------- */

function plainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function str(v, n) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 9999);
}

function text(v, n) {
  return String(v == null ? '' : v).trim().slice(0, n || 9999);
}

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function oneLine(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function memberMap(sc) {
  const map = {};
  (sc.meta.members || []).forEach((m) => { map[m.id] = m; });
  return map;
}

function nameOf(sc, id) {
  if (id === 'me' || id === 'player') return '玩家';
  const m = memberMap(sc)[id];
  if (m) return m.name;
  const s = String(id || '');
  return s.startsWith('u:') ? s.slice(2) : s;
}

function transcriptOf(history, sc, limit) {
  const out = [];
  (history || []).forEach((m) => {
    if (!m) return;
    if (m.role === 'user') {
      out.push('玩家：' + String(m.content || '').replace(/^（私聊）/, ''));
      return;
    }
    let o;
    try { o = typeof m.content === 'string' ? JSON.parse(m.content) : m.content; } catch (e) { return; }
    (o && o.events || []).forEach((e) => {
      if (!e) return;
      if (e.t === 'msg') out.push(nameOf(sc, e.from) + '：' + e.text);
      else if (e.t === 'sys') out.push('· ' + e.text);
      else if (e.t === 'voice') out.push(nameOf(sc, e.from) + '：[语音] ' + e.asr);
      else if (e.t === 'loc') out.push(nameOf(sc, e.from) + '：[位置] ' + e.name + '（' + (e.when || '') + '）' + (e.flag || ''));
      else if (e.t === 'img') out.push(nameOf(sc, e.from) + '：[图片] ' + (e.cap || ''));
      else if (e.t === 'rename') out.push('· 群名被改成「' + e.name + '」');
      else if (e.t === 'notice') out.push('· 群公告被改成「' + e.text + '」');
      else if (e.t === 'join') out.push('· 「' + e.name + '」加入了群聊');
      else if (e.t === 'leave') out.push('· 「' + e.name + '」离开了群聊');
      else if (e.t === 'recall') out.push('· ' + nameOf(sc, e.from) + ' 撤回了一条消息');
    });
  });
  return out.slice(-(limit || 18)).join('\n');
}

function clipTail(s, n) {
  if (!s) return '';
  return s.length > n ? '…' + s.slice(-n) : s;
}

/* ---------------- 私聊线程 ---------------- */

function threadKey(a, b) {
  return 'dm:' + [a, b].sort().join('|');
}

function appendThread(session, from, to, text, leaked) {
  const key = threadKey(from, to);
  if (!session.threads[key]) session.threads[key] = [];
  session.threads[key].push({ from, to, text: String(text || '').slice(0, 200), turn: (session.turn || 0) + 1, leaked: !!leaked });
  if (session.threads[key].length > 50) session.threads[key] = session.threads[key].slice(-50);
}

function dmThreadText(sc, session, a, b, limit) {
  const arr2 = (session.threads || {})[threadKey(a, b)] || [];
  return arr2.slice(-limit).map((m) => nameOf(sc, m.from) + '：' + m.text).join('\n');
}

function privateThreadsText(sc, session, limit) {
  const keys = Object.keys(session.threads || {}).slice(-limit);
  return keys.map((k) => {
    const arr2 = session.threads[k] || [];
    return k + '\n' + arr2.slice(-2).map((m) => nameOf(sc, m.from) + '→' + nameOf(sc, m.to) + '：' + m.text).join('\n');
  }).join('\n');
}

/* ---------------- 模型调用 ---------------- */

async function callModel(messages, temperature, model, maxTokens) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: model || MODEL,
      messages,
      temperature: temperature == null ? 0.85 : temperature,
      max_tokens: maxTokens || 700
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

function parseJson(text2) {
  if (!text2) throw new Error('empty');
  let s = text2.trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e1) {
    try { return JSON.parse(repairJson(s)); } catch (e2) { throw e2; }
  }
}

async function askJson(messages, temperature, model, maxTokens) {
  let raw;
  try { raw = await callModel(messages, temperature, model, maxTokens); } catch (e) { raw = await callModel(messages, 0.5, model, maxTokens); }
  try {
    return parseJson(raw);
  } catch (e) {
    const raw2 = await callModel(messages.concat([{ role: 'user', content: '（系统）只输出一个 JSON 对象，不要任何其他文字。' }]), 0.3, model, maxTokens);
    return parseJson(raw2);
  }
}

/* ---------------- 玩家状态记录员 ---------------- */

function trackerMessages(sc, session, text2) {
  const facts = (session.publicFacts || []).slice(-6).map((f) => '- ' + f).join('\n') || '（无）';
  const sys = `你是玩家状态记录员。你只根据玩家这句话和当前 state，更新玩家的真实位置、是否已做出不可逆动作、报警威胁、证据。不要演 NPC，不要写台词，不要判断剧情走向。

【当前 state】
${JSON.stringify(session.state || {}, null, 1)}

【最近的公开事实】
${facts}

【允许的 playerAt】
south_gate / walking / home / b2 / car / unknown

【规则】
- 玩家表达“我要回家了 / 我准备回家 / 我回去了 / 我走了 / 我回家了 / 我到家了” -> at=home，committed=true；不要求明确说“到家”，只要明确要离开 / 回家。
- “我不走了 / 我不回家了 / 我还在南门 / 我改主意了” -> at=south_gate，committed=false；允许在结局触发前反悔。
- “我下楼了 / 我在路上 / 我走过去” -> at=walking。
- “我到地库 / 我在B2 / 我进地库” -> at=b2。
- “我要去B2 / 我准备下楼” -> at=walking，不是 b2。
- “我上车了 / 我在车上 / 车开了” -> at=car，committed=true；“我要上车 / 我准备上车” -> at=walking，不是 car。
- 没有明确位置就不改，at=null。
- “我报警了 / 我打了110” -> policeThreat=3；“我要报警 / 再这样我报警” -> policeThreat=1 或 2。
- “我截图了 / 我录了音 / 我有照片” -> evidence 加对应字符串。
- 如果 evidence 里出现小满的照片 / 小满“别去”的截图、03:14 或松岭定位卡、或能指向松岭的私聊口供 -> hiddenEvidence=true；否则 false/null。
- 玩家的话就是事实；不要因为 NPC 不信、没看见、或者剧情里没人承认而改。
- 你没有明确依据时，宁可返回 null，不要猜。

只输出一个 JSON 对象，不要解释、不要代码块：
{ "at": "car" | null, "committed": true | false | null, "policeThreat": 0 | 1 | 2 | 3 | null, "evidence": ["..."], "hiddenEvidence": true | false | null }`;
  return [{ role: 'system', content: sys }, { role: 'user', content: text2 }];
}

async function runTracker(sc, session, text2) {
  try {
    const obj = await askJson(trackerMessages(sc, session, text2), 0.15, MODEL, 300);
    if (!plainObject(obj)) return null;
    const out = {};
    if (PLAYER_AT.has(obj.at)) out.at = obj.at;
    if (typeof obj.committed === 'boolean') out.committed = obj.committed;
    if (obj.policeThreat != null && Number.isFinite(Number(obj.policeThreat))) out.policeThreat = clamp(obj.policeThreat, 0, 3);
    if (Array.isArray(obj.evidence)) out.evidence = obj.evidence.map((x) => str(x, 60)).filter(Boolean).slice(0, 3);
    if (typeof obj.hiddenEvidence === 'boolean') out.hiddenEvidence = obj.hiddenEvidence;
    return out;
  } catch (e) {
    console.log('[tracker] 失败：' + e.message);
    return null;
  }
}

function applyTracked(session, t) {
  if (!t) return;
  if (t.at) session.state.playerAt = t.at;
  if (t.committed != null) session.state.playerCommitted = !!t.committed;
  if (t.policeThreat != null) session.state.policeThreat = t.policeThreat;
  if (t.hiddenEvidence != null) session.state.hiddenEvidence = !!t.hiddenEvidence;
  if (t.evidence && t.evidence.length) {
    const cur = Array.isArray(session.state.evidence) ? session.state.evidence : [];
    t.evidence.forEach((e) => { if (!cur.includes(e)) cur.push(e); });
    session.state.evidence = cur.slice(-6);
    session.state.hasEvidence = true;
  }
}

/* ---------------- GM ---------------- */

function gmMessages(sc, session, text2, opts) {
  const members = (sc.meta.members || []).filter((m) => m.id !== 'me');
  const castLines = members.map((m) => {
    const c = sc.cast[m.id] || {};
    return `- ${m.id}（${m.name}）：知道=${oneLine(c.knows)}｜不知道=${oneLine(c.doesntKnow)}｜想要=${oneLine(c.wants)}｜怕=${oneLine(c.fears)}`;
  }).join('\n');
  const npcLines = members.filter((m) => !(sc.cast[m.id] && sc.cast[m.id].system)).map((m) => {
    const n = session.npcs[m.id] || {};
    const mem = (n.memory || []).slice(-2).join(' / ');
    return `- ${m.id}（${m.name}）：现在知道=${oneLine(n.knowledge)}｜情绪=${oneLine(n.mood)}｜打算=${oneLine(n.goal)}${mem ? '｜记忆=' + oneLine(mem) : ''}`;
  }).join('\n');
  const arcLines = (sc.arc || []).map((a) => `- ${a.id}：${a.goal}`).join('\n') || '（无）';
  const endingLines = (sc.endings || []).map((e) => `- ${e.id}（${e.title}）：${e.when}${e.minTurn ? '（最早第 ' + e.minTurn + ' 轮）' : ''}`).join('\n');
  const spLines = (sc.setpieces || []).map((s) => `- ${s.id}：${s.label ? s.label + '；' : ''}${s.when}${session.playedSetpieces.includes(s.id) ? '（已投放）' : ''}`).join('\n') || '（无）';
  const codeLines = Object.entries(sc.codebook || {}).map(([k, v]) => `- 「${k}」= ${v}`).join('\n') || '（无）';
  const facts = (session.publicFacts || []).slice(-20).map((f) => '- ' + f).join('\n') || '（还没有）';
  const recent = transcriptOf(session.history, sc, 24) || '（还没有）';
  const priv = opts.channel === 'group' ? privateThreadsText(sc, session, 6) : dmThreadText(sc, session, 'player', opts.who, 12);
  const force = opts.forceEnding
    ? '这是最后一轮：你必须从结局菜单里选一个最接近的 ending，不能返回 null。'
    : `softEndTurn=${sc.rules.softEndTurn == null ? '—' : sc.rules.softEndTurn} 只是“开始收网”的建议，不是硬门槛；maxTurns=${sc.rules.maxTurns} 是硬上限。如果玩家已经满足某条 when（尤其是 home / bad 这种主动离开 / 上车的选择），即使没到 softEndTurn 也要提 ending；不要为了拖时长而不提。`;
  const sys = `你是这个文字游戏的总导演（GM）。游戏发生在一个叫「${session.groupName || sc.meta.groupName}」的微信群里，玩家是群里的真人。
现在 ${session.clock || sc.meta.startClock}，已经进行了 ${session.turn || 0} 轮。当前阶段：${session.phase || '未定'}。
当前群名/公告：${session.groupName || sc.meta.groupName}｜${session.notice && session.notice.text ? session.notice.text : (sc.meta.notice || '')}
${opts.channel === 'group' ? '玩家在群里说话。' : '玩家正在私聊「' + nameOf(sc, opts.who) + '」；这一轮只有 TA 会回复，不要产生群事件。'}

【完整真相（只有你知道，演员不知道）】
${sc.canon}

【关于玩家】
- 玩家是唯一真人，他的行动声明就是事实来源：他说“我到家了 / 我下楼了 / 我上车了 / 我报警了”，就按这个更新 state；不要因为 NPC 不信而不更新。
- canon 是开局真相，不是永久真相；玩家离开南门后，canon 里“他真的站在南门”不再成立。
- state 是客观真相，不是 NPC 的信念。NPC 看不到、不信、否认，不代表事情没发生；不要把 NPC 的怀疑写进 state。NPC 的怀疑写进各自的 knowledge / mood / goal。
- 如果玩家已经明确说“我到家了 / 我不去了 / 我不会下楼”，并且 state.playerAt=home，home 的 when 已经成立；minTurn 到了就提 home。

【角色与认知边界】
${castLines}

【每个角色现在的私有状态】
${npcLines || '（无）'}

【全局写作要求】
${sc.style || '（无）'}

【节奏备注】
${sc.gmNotes || '（无）'}

【阶段目标】
${arcLines}

【结局菜单（你只能从这里选；引擎只检查 id/minTurn/maxTurns，语义由你判断）】
${endingLines}

【已经成立、不得自相矛盾的事实】
${facts}

【群里的公开对话】
${recent}
${session.prior ? '\n【开场/之前发生的事】\n' + session.prior + '\n' : ''}
${priv ? '\n【私聊】\n' + priv + '\n' : ''}
【当前世界状态（JSON，真相）】
${JSON.stringify(session.state || {}, null, 1)}

【可投放的 setpiece】
${spLines}

【setpiece 规则】
- 这些是保底线索，不是可选装饰。玩家的发言/行为命中某条 when 时，必须在本轮 setpieces 里选它；不要用 NPC 的否认代替事件本身。
- 如果玩家直接问“小满 / 少一个人 / 松岭 / 照片 / 聊天记录”，优先投放对应 setpiece。
- 投放 setpiece 时，不要再用 notice/sys 重复它已经包含的事件；join/leave 用对应事件，不要用 notice 代替。

【群里的暗语】
${codeLines}

【输出格式】只输出一个 JSON 对象，不要解释、不要代码块：
{
  "scene": "给演员看的当前场景，1-3 句；不要写只有某个 NPC 知道的秘密",
  "state": { "heat": 5 },
  "knowledge": { "aqiao": "她新知道的事" },
  "publicFacts": ["这一轮群里看得见的新事实"],
  "phase": "pressure",
  "clock": "06:38",
  "active": [ { "id": "aqiao", "privateBrief": "她私下知道/感觉到什么、这一拍想干什么；不要写台词", "urgency": 0.9 } ],
  "setpieces": [],
  "events": [ { "t": "notice", "by": "mo", "text": "..." } ],
  "privateMessages": [ { "from": "mo", "to": "laok", "text": "..." } ],
  "ending": { "id": "home", "reason": "为什么现在可以结束", "evidence": ["playerAt=home"] }
}

规则：
- 你是导演，不是台词机：不要写 NPC 的公开 msg；台词由演员写。
- 玩家位置由记录员先写进 state；你直接看 state，不需要输出 player。你可以修正明显的世界状态（车在哪、heat、warnings），但不要把 NPC 的怀疑当成玩家的真实位置。
- 结局由你判断，不要等关键词；玩家已经满足某条 when，就提 ending。
- ${force}
- 不要替玩家做决定；只判断已经发生的事。
- ${opts.nudge || ''}`;
  return [{ role: 'system', content: sys }, { role: 'user', content: text2 }];
}

/* ---------------- 演员 ---------------- */

function actorMessages(sc, session, active, opts) {
  const map = memberMap(sc);
  const c = sc.cast[active.id] || {};
  const m = map[active.id] || { name: active.id };
  const n = session.npcs[active.id] || {};
  const others = (sc.meta.members || []).filter((x) => x.id !== 'me' && x.id !== active.id).map((x) => x.name).join('、');
  const mem = (n.memory || []).slice(-8).map((x) => '- ' + x).join('\n') || '（还没有）';
  const inbox = (n.inbox || []).slice(-5).map((x) => `- ${nameOf(sc, x.from)}：${x.text}`).join('\n') || '（没有）';
  const facts = (session.publicFacts || []).slice(-12).map((x) => '- ' + x).join('\n') || '（还没有）';
  const recent = transcriptOf(session.history, sc, 16) || '（群里还很安静）';
  const dm = opts.channel === 'group' ? '' : dmThreadText(sc, session, 'player', active.id, 10);
  const phase = (sc.arc || []).find((a) => a.id === session.phase);
  const code = Object.entries(sc.codebook || {}).map(([k, v]) => `- 「${k}」= ${v}`).join('\n') || '（无）';
  const privateTo = (c.privateWith || []).map((id) => nameOf(sc, id)).join('、') || '任何同伴';
  const sys = `你是「${m.name}」，在「${session.groupName || sc.meta.groupName}」微信群里。现在是 ${session.clock || sc.meta.startClock}。
${opts.channel === 'group' ? '群里有玩家（显示为「你」）。' : '玩家正在私聊你；这一轮你的 events 会直接回给玩家。'}
群里还有：${others}，还有一个玩家（显示为「你」，提到他时用「你」，要 @ 就写「@你」）。

【你是谁】
知道：${c.knows || ''}
不知道：${c.doesntKnow || ''}
想要：${c.wants || ''}
怕：${c.fears || ''}
说话方式：${c.voice || ''}
关系：${JSON.stringify(c.relationships || {})}
可以私聊：${privateTo}

【你现在知道的事】
${n.knowledge || c.knows || ''}

【你自己的记忆】
${mem}

【你收到的私聊】
${inbox}

【现在发生的事】
${opts.scene || '（群里安静了几秒）'}

【这一轮刚刚发生】
${(opts.currentEvents || []).map(eventText).filter(Boolean).map((x) => '· ' + x).join('\n') || '（无）'}

【公开事实】
${facts}

【最近对话】
${recent}
${dm ? '\n【你和玩家的私聊】\n' + dm + '\n' : ''}
${session.prior ? '\n【开场/之前发生的事】\n' + clipTail(session.prior, 900) + '\n' : ''}
【这一拍你私下知道/感觉到】
${opts.privateBrief || '按你的性格接一句。'}

【阶段目标】
${phase ? phase.goal : '（无）'}

【暗语（只在群里用；细节走私聊）】
${code}

【规则】
1. 你是「${m.name}」，只写自己的话；不要替别人说话，不要写旁白。
2. ${opts.channel === 'group' ? '群里有玩家：计划、报警、撤退、望风、车、松岭、小满，不能在 events 里说；只能在 private 里发给同伴，或者用暗语。' : '这是私聊；你可以说真话、撒谎、装傻、沉默。'}
3. 不要重复你上一句；你可以换战术、示弱、威胁、装傻、pass。
4. 你不知道的事就是不知道；不要突然知道。
5. 你可以 pass；不想说话就 pass。
6. ${opts.channel === 'group' ? 'events 会发到群里；private 会私聊给指定的人。' : 'events 会直接回给玩家；private 可以私聊别的 NPC。'}
7. 玩家要求私聊，或你要说不能进群的话，用 private 发给 player；不要只在群里答应“私聊”却什么都不发。

只输出一个 JSON 对象，不要解释、不要代码块：
{
  "pass": false,
  "events": [ { "t": "msg", "text": "..." } ],
  "private": [ { "to": "laok", "text": "...", "leak": false } ],
  "memory": "1-2 句你记住的事",
  "mood": "…",
  "goal": "…"
}
最多 2 条 events，2 条 private。`;
  return [{ role: 'system', content: sys }, { role: 'user', content: '按上面的情境，输出你的 JSON。' }];
}

/* ---------------- 归一化 ---------------- */

function normalizeEvent(e) {
  if (!e || !GM_EVENT_TYPES.has(e.t)) return null;
  if (e.t === 'sys') {
    const t = str(e.text, 200);
    return t ? { t: 'sys', text: t, tone: e.tone === 'warn' ? 'warn' : '' } : null;
  }
  if (e.t === 'notice') {
    const t = str(e.text, 220);
    return t ? { t: 'notice', by: str(e.by, 40) || 'mo', text: t } : null;
  }
  if (e.t === 'rename') {
    const name = str(e.name, 48);
    return name ? { t: 'rename', name } : null;
  }
  if (e.t === 'join' || e.t === 'leave') {
    const name = str(e.name, 24);
    return name ? { t: e.t, name, text: str(e.text, 60) } : null;
  }
  if (e.t === 'img') {
    const kind = str(e.kind, 40);
    const cap = str(e.cap, 80);
    return kind || cap ? { t: 'img', from: str(e.from, 40) || 'mo', kind, cap } : null;
  }
  if (e.t === 'loc') {
    const name = str(e.name, 60);
    return name ? { t: 'loc', from: str(e.from, 40) || 'mo', name, addr: str(e.addr, 120), when: str(e.when, 40), flag: str(e.flag, 120) } : null;
  }
  return null;
}

function normalizeSetpieceEvent(e) {
  if (!e) return null;
  if (e.t === 'msg') {
    const from = str(e.from, 40);
    const t = str(e.text, 200);
    return from && t ? { t: 'msg', from, text: t } : null;
  }
  return normalizeEvent(e);
}

function normalizeGm(sc, obj) {
  const out = { scene: '', state: {}, knowledge: {}, publicFacts: [], phase: '', clock: '', active: [], setpieces: [], events: [], privateMessages: [], ending: null };
  if (!plainObject(obj)) return out;
  out.scene = text(obj.scene, 800);
  out.state = plainObject(obj.state) ? obj.state : {};
  if (plainObject(obj.knowledge)) {
    for (const [k, v] of Object.entries(obj.knowledge)) {
      if (sc.cast[k] && k !== 'me') out.knowledge[k] = str(v, 400);
    }
  }
  out.publicFacts = arr(obj.publicFacts).map((x) => str(x, 120)).filter(Boolean).slice(0, 3);
  out.phase = str(obj.phase, 40);
  out.clock = str(obj.clock, 5);
  const cast = sc.cast || {};
  out.active = arr(obj.active).map((a) => ({
    id: str(a && a.id, 40),
    privateBrief: str(a && a.privateBrief, 400),
    urgency: clamp(a && a.urgency, 0, 1)
  })).filter((a) => a.id && a.id !== 'me' && cast[a.id] && !cast[a.id].system).slice(0, 3);
  const spids = new Set((sc.setpieces || []).map((s) => s.id));
  out.setpieces = arr(obj.setpieces).map((x) => String(x)).filter((x) => spids.has(x)).slice(0, 2);
  out.events = arr(obj.events).map(normalizeEvent).filter(Boolean).slice(0, 4);
  out.privateMessages = arr(obj.privateMessages).map((m) => ({
    from: str(m && m.from, 40) || 'mo',
    to: str(m && m.to, 40),
    text: str(m && m.text, 200)
  })).filter((m) => cast[m.from] && cast[m.from].system && (m.to === 'player' || cast[m.to]) && m.text).slice(0, 3);
  if (obj.ending && typeof obj.ending === 'object' && obj.ending.id) {
    const spec = (sc.endings || []).find((e) => e.id === String(obj.ending.id));
    if (spec) {
      out.ending = {
        id: spec.id,
        title: spec.title,
        text: spec.text,
        minTurn: spec.minTurn || 0,
        reason: str(obj.ending.reason, 300),
        evidence: arr(obj.ending.evidence).map((x) => str(x, 120)).slice(0, 4)
      };
    }
  }
  return out;
}

function normalizeActorEvent(e, actorId) {
  if (e.t === 'msg') {
    const t = str(e.text, 200);
    return t ? { t: 'msg', from: actorId, text: t } : null;
  }
  if (e.t === 'voice') {
    const asr = str(e.asr, 160);
    return asr ? { t: 'voice', from: actorId, dur: Math.min(60, Math.max(1, Number(e.dur) || 5)), asr } : null;
  }
  if (e.t === 'recall') return { t: 'recall', from: actorId, text: str(e.text, 80) };
  return null;
}

function normalizeActor(sc, actorId, obj) {
  const out = { pass: true, events: [], private: [], memory: '', mood: '', goal: '' };
  if (!plainObject(obj)) return out;
  out.pass = obj.pass === true;
  out.memory = str(obj.memory, 120);
  out.mood = str(obj.mood, 40);
  out.goal = str(obj.goal, 80);
  if (!out.pass) {
    out.events = arr(obj.events).filter((e) => e && ACTOR_EVENT_TYPES.has(e.t)).map((e) => normalizeActorEvent(e, actorId)).filter(Boolean).slice(0, 2);
    const validTo = (id) => id === 'player' || (sc.cast[id] && id !== actorId);
    out.private = arr(obj.private).filter((p) => p && validTo(String(p.to)) && p.text).map((p) => ({
      to: String(p.to),
      text: str(p.text, 200),
      leak: p.leak === true
    })).slice(0, 2);
  }
  if (!out.events.length && !out.private.length) out.pass = true;
  return out;
}

/* ---------------- state / 事件 ---------------- */

function checkType(v, def) {
  if (Array.isArray(def)) return def.includes(v);
  if (def === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (def === 'string') return typeof v === 'string';
  if (def === 'boolean') return typeof v === 'boolean';
  if (def === 'string[]') return Array.isArray(v) && v.every((x) => typeof x === 'string');
  return true;
}

function depthOf(v, d) {
  d = d || 0;
  if (v && typeof v === 'object') {
    let max = d;
    for (const k of Object.keys(v)) max = Math.max(max, depthOf(v[k], d + 1));
    return max;
  }
  return d;
}

function mergeState(target, patch, schema) {
  if (!plainObject(target) || !plainObject(patch)) return false;
  const next = JSON.parse(JSON.stringify(target));
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return false;
    if (v === null) { delete next[k]; continue; }
    if (schema && plainObject(schema)) {
      if (!Object.prototype.hasOwnProperty.call(schema, k)) return false;
      if (!checkType(v, schema[k])) return false;
    }
    next[k] = v;
  }
  if (JSON.stringify(next).length > STATE_BYTES) return false;
  if (depthOf(next) > 4) return false;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
  return true;
}

function applyGm(sc, session, gm, isGroup) {
  if (!mergeState(session.state, gm.state, sc.state && sc.state.schema)) {
    if (Object.keys(gm.state || {}).length) console.log('[gm] state patch rejected');
  }
  for (const [id, value] of Object.entries(gm.knowledge)) {
    if (session.npcs[id]) session.npcs[id].knowledge = value;
  }
  if (isGroup) {
    gm.publicFacts.forEach((f) => session.publicFacts.push(f));
    if (session.publicFacts.length > MAX_FACTS) session.publicFacts = session.publicFacts.slice(-MAX_FACTS);
  }
  if (gm.phase && (!sc.arc.length || sc.arc.some((a) => a.id === gm.phase))) session.phase = gm.phase;
  if (/^\d{1,2}:\d{2}$/.test(gm.clock)) session.clock = gm.clock;
}

function applyPublicEvent(sc, session, e, out) {
  if (!e) return;
  if (e.t === 'rename' && e.name) session.groupName = e.name;
  if (e.t === 'notice' && e.text) session.notice = { from: e.by || 'mo', text: e.text, meta: '刚刚' };
  out.push(e);
}

function applySetpieces(sc, session, ids, out, unlock) {
  for (const id of ids) {
    if (session.playedSetpieces.includes(id)) continue;
    const sp = (sc.setpieces || []).find((s) => s.id === id);
    if (!sp) continue;
    session.playedSetpieces.push(id);
    (sp.events || []).map(normalizeSetpieceEvent).filter(Boolean).forEach((e) => applyPublicEvent(sc, session, e, out));
    (sp.unlock || []).forEach((u) => {
      const key = String(u);
      session.flags[key] = true;
      if (!unlock.includes(key)) unlock.push(key);
    });
  }
}

function addDm(dmEvents, channel, ev) {
  let entry = dmEvents.find((d) => d.channel === channel);
  if (!entry) { entry = { channel, events: [] }; dmEvents.push(entry); }
  entry.events.push(ev);
}

function routePrivate(sc, session, from, to, text2, leak, dmEvents, publicEvents) {
  if (!text2) return;
  if (leak && publicEvents) {
    publicEvents.push({ t: 'msg', from, text: text2 });
    return;
  }
  appendThread(session, from, to, text2, false);
  if (to === 'player') {
    if (dmEvents) addDm(dmEvents, 'p:' + from, { t: 'msg', from, text: text2 });
    return;
  }
  const npc = session.npcs[to];
  if (npc) {
    npc.inbox.push({ from, text: text2, turn: (session.turn || 0) + 1 });
    if (npc.inbox.length > 20) npc.inbox = npc.inbox.slice(-20);
  }
}

function eventText(e) {
  if (!e) return '';
  if (e.t === 'msg') return e.text || '';
  if (e.t === 'voice') return '[语音] ' + (e.asr || '');
  if (e.t === 'recall') return '[撤回] ' + (e.text || '');
  if (e.t === 'sys') return e.text || '';
  if (e.t === 'img') return '[图片] ' + (e.cap || '');
  if (e.t === 'loc') return '[位置] ' + (e.name || '');
  if (e.t === 'join') return '「' + (e.name || '?') + '」加入了群聊';
  if (e.t === 'leave') return e.text || ('「' + (e.name || '?') + '」离开了群聊');
  if (e.t === 'rename') return '群名被改成「' + (e.name || '') + '」';
  if (e.t === 'notice') return '群公告被改成「' + (e.text || '') + '」';
  return '';
}

function updateNpc(session, id, res) {
  const n = session.npcs[id];
  if (!n) return;
  if (res.memory) {
    n.memory.push(res.memory);
    if (n.memory.length > MAX_MEMORY) n.memory = n.memory.slice(-MAX_MEMORY);
  }
  if (res.mood) n.mood = res.mood;
  if (res.goal) n.goal = res.goal;
  n.inbox = [];
}

function pickFallback(sc) {
  const ids = (sc.meta.members || []).map((m) => m.id).filter((id) => id !== 'me' && !(sc.cast[id] && sc.cast[id].system));
  return ids[0] || 'npc';
}

function findEnding(sc, id) {
  return (sc.endings || []).find((e) => e.id === id) || null;
}

// 状态硬门槛：只在 GM 没提结局时兜底。只比较 state 的键值，不做文本匹配。
function findTriggeredEnding(sc, session) {
  const state = session.state || {};
  for (const e of sc.endings || []) {
    if (!plainObject(e.trigger)) continue;
    if (e.minTurn && session.turn + 1 < e.minTurn) continue;
    const hit = Object.entries(e.trigger).every(([k, v]) => state[k] === v);
    if (hit) return e;
  }
  return null;
}

function fallbackGm(sc) {
  return {
    scene: '群里安静了几秒。',
    state: {},
    knowledge: {},
    publicFacts: [],
    phase: '',
    clock: '',
    active: [{ id: pickFallback(sc), privateBrief: '接一句，别让场面冷掉。', urgency: 0.5 }],
    setpieces: [],
    events: [],
    privateMessages: [],
    ending: null
  };
}

/* ---------------- 回合 ---------------- */

async function runGm(sc, session, text2, opts) {
  const obj = await askJson(gmMessages(sc, session, text2, opts), 0.7, GM_MODEL, 1600);
  return normalizeGm(sc, obj);
}

async function runActor(sc, session, active, opts) {
  const obj = await askJson(actorMessages(sc, session, active, opts), 0.9, MODEL, 800);
  return normalizeActor(sc, active.id, obj);
}

async function gmTurn({ scenario, session, channel, text: text2, who }) {
  const sc = scenario;
  const isGroup = channel === 'group';
  session.turn = session.turn || 0;
  session.state = session.state || {};
  session.publicFacts = session.publicFacts || [];
  session.npcs = session.npcs || {};
  session.threads = session.threads || {};
  session.playedSetpieces = session.playedSetpieces || [];
  session.history = session.history || [];
  session.flags = session.flags || {};
  if (isGroup) {
    session.history.push({ role: 'user', content: text2 });
    if (session.history.length > 60) session.history = session.history.slice(-60);
  } else {
    appendThread(session, 'player', who, text2);
  }

  const tracked = await runTracker(sc, session, text2);
  applyTracked(session, tracked);

  const forced = isGroup && Number.isFinite(sc.rules.maxTurns) && session.turn + 1 >= sc.rules.maxTurns;
  let gm;
  try {
    gm = await runGm(sc, session, text2, { channel, who, forceEnding: forced });
  } catch (e) {
    console.log('[gm] 失败：' + e.message);
    gm = fallbackGm(sc);
  }

  if (isGroup && gm.ending && session.turn + 1 < (gm.ending.minTurn || 0)) {
    try {
      gm = await runGm(sc, session, text2, {
        channel,
        who,
        forceEnding: forced,
        nudge: `你刚才想提前提「${gm.ending.id}」，但还没到第 ${gm.ending.minTurn} 轮；继续演，不要提结局。`
      });
    } catch (e) { /* 保留上一次 */ }
    if (gm.ending && session.turn + 1 < (gm.ending.minTurn || 0)) gm.ending = null;
  }

  applyGm(sc, session, gm, isGroup);
  applyTracked(session, tracked);
  const triggered = isGroup ? findTriggeredEnding(sc, session) : null;

  const publicEvents = [];
  const dmEvents = [];
  const unlock = [];

  if (isGroup) {
    applySetpieces(sc, session, gm.setpieces, publicEvents, unlock);
    gm.events.forEach((e) => applyPublicEvent(sc, session, e, publicEvents));
    gm.privateMessages.forEach((m) => routePrivate(sc, session, m.from, m.to, m.text, false, dmEvents, publicEvents));
  } else {
    gm.privateMessages.forEach((m) => routePrivate(sc, session, m.from, m.to, m.text, false, dmEvents, null));
  }

  let active;
  if (isGroup) {
    active = gm.active.slice();
  } else {
    const brief = (gm.active.find((a) => a.id === who) || {}).privateBrief || '玩家在私聊你；回他。';
    active = [{ id: who, privateBrief: brief, urgency: 1 }];
  }
  if (!active.length) active = [{ id: pickFallback(sc), privateBrief: '接一句，别让场面冷掉。', urgency: 0.5 }];

  const skipActors = isGroup && (!!gm.ending || !!triggered || forced);
  let acted = 0;
  for (const a of (skipActors ? [] : active)) {
    if (acted >= 2) break;
    const actor = sc.cast[a.id];
    if (!actor || actor.system) continue;
    let res;
    try {
      res = await runActor(sc, session, a, {
        channel,
        who,
        scene: gm.scene,
        privateBrief: a.privateBrief,
        currentEvents: publicEvents.slice()
      });
    } catch (e) {
      console.log('[actor:' + a.id + '] 失败：' + e.message);
      continue;
    }
    if (!res) continue;
    updateNpc(session, a.id, res);
    if (!res.events.length && !res.private.length) continue;
    acted += 1;

    if (isGroup) {
      res.events.forEach((e) => publicEvents.push(e));
      res.private.forEach((p) => routePrivate(sc, session, a.id, p.to, p.text, p.leak, dmEvents, publicEvents));
    } else {
      res.events.forEach((e) => {
        addDm(dmEvents, 'p:' + a.id, e);
        appendThread(session, a.id, 'player', eventText(e));
      });
      res.private.forEach((p) => routePrivate(sc, session, a.id, p.to, p.text, false, dmEvents, null));
    }
  }

  if (isGroup && !publicEvents.length && !dmEvents.length && !skipActors) {
    publicEvents.push({ t: 'sys', text: '群里安静了几秒。' });
  }
  if (!isGroup && !dmEvents.some((d) => d.channel === 'p:' + who)) {
    addDm(dmEvents, 'p:' + who, { t: 'sys', text: '对方没有回复。' });
  }

  let ending = null;
  if (isGroup && gm.ending) {
    ending = { id: gm.ending.id, title: gm.ending.title, text: gm.ending.text };
    session.ended = gm.ending.id;
  } else if (isGroup && triggered) {
    ending = { id: triggered.id, title: triggered.title, text: triggered.text };
    session.ended = triggered.id;
  } else if (forced) {
    const def = findEnding(sc, sc.rules.defaultEnding) || sc.endings[sc.endings.length - 1];
    if (def) {
      ending = { id: def.id, title: def.title, text: def.text };
      session.ended = def.id;
    }
  }

  if (isGroup) {
    session.history.push({ role: 'assistant', content: JSON.stringify({ events: publicEvents }) });
    if (session.history.length > 60) session.history = session.history.slice(-60);
  }

  session.turn += 1;

  if (isGroup) return { events: publicEvents, dmEvents, unlock, ending };
  const cur = dmEvents.find((d) => d.channel === 'p:' + who);
  return {
    events: cur ? cur.events : [],
    dmEvents: dmEvents.filter((d) => d.channel !== 'p:' + who),
    unlock,
    ending
  };
}

module.exports = { gmTurn, loadScenario, listScenarios, API, KEY };

# 剧本 Schema v5

> 状态：v5-lite 已接入（`gm.js` / `server.js` / `app.js` / richu `scenario.json`）。v3 的 `intent` / `pickEnding` 已删除。
> 原则：**AI 做判断，引擎做账本**。剧本只写世界、角色、结局菜单；引擎只校验结构，不写剧情规则，也不做关键词/正则匹配。

## 0. 一句话

- 剧本层：作者写 `canon` / `cast` / `state` / `arc` / `endings`。
- 运行时：服务端存 `state` / `publicFacts` / `npcs` / `dm`。
- 协议：GM 输出 `scene` / `state` / `active` / `ending`；演员输出 `events` / `private` / `memory`。
- 频道：`group` 公开；`dm` 私聊，玩家只看到自己参与的线程。

## 1. 三层与数据流

```
剧本（canon / cast / state.initial / arc / endings）
        ↓
[记录员] 只根据玩家这句话更新 playerAt / playerCommitted / policeThreat / evidence
        ↓
[GM] 看：canon + cast + state + publicFacts + 最近公开对话 + endings 菜单 + arc
        ↓ 输出：scene / state patch / knowledge / publicFacts / active / setpieces /
                events / privateMessages / ending
[引擎] 校验、合并 state、路由 dm、检查 ending.id/minTurn/maxTurns
        ↓
[演员] 看：自己的 knows/doesntKnow/wants/fears/voice + knowledge + memory + inbox
            + scene + publicFacts + 最近公开对话 + privateBrief
        ↓ 输出：pass / events（群）/ private（dm）/ memory / mood / goal
[引擎] 合并事件、渲染、落盘
```

- GM 不写公开 `msg`；公开台词由演员写。
- GM 可以写 `scene` / `state` / `knowledge` / `publicFacts` / 系统事件 / 系统角色的私聊。
- 演员看不到 `canon`、`endings`、别人的 `dm`。
- 引擎不判断“玩家想干什么”；那是 GM 从自由文本里读出来的。

## 2. 频道模型

| 线程 | 参与者 | 玩家可见 | 例子 |
|---|---|---|---|
| `group` | 所有人 | 可见 | 群里演戏 |
| `dm:player\|aqiao` | 玩家、阿荞 | 可见 | 玩家私聊阿荞套话 |
| `dm:laok\|shiqi` | 老K、小十七 | 不可见 | 小十七私聊老K“他截图了” |

- 线程 key 的 id 排序后拼接：`dm:<a>|<b>`。
- 客户端仍用 `p:<npc>` 打开玩家私聊；服务端映射成 `dm:player|<npc>`。
- 玩家只看到包含 `player` 的线程；NPC↔NPC 线程对玩家不存在。
- 每个 NPC 有 `inbox`：它参与的 dm 的未读消息；被叫到时读取，成功后清空（重要内容由它写进 `memory`）。
- 玩家把私聊内容贴到群里，其他 NPC 才知道；GM 据此更新它们的 `knowledge`。
- GM 能看到所有 dm，但不得把 dm 内容写进 `scene` / `publicFacts`；只能通过 NPC 的嘴、引用、或者 `leak` 让玩家知道。
- NPC 主动私聊玩家：演员输出 `private.to = "player"`；引擎写入 `dm:<npc>|player`，客户端在 `p:<npc>` 里显示。

## 3. 剧本层

### 3.1 顶层

```jsonc
{
  "version": 5,
  "id": "richu",
  "title": "日出小队",
  "subtitle": "群聊解密 · 五个人，一辆不会来的车",
  "cover": "🌄",

  "meta": { ... },        // 不变
  "intro": [ ... ],       // 不变
  "archive": { ... },     // 不变
  "assets": { ... },      // 不变

  "canon": "canon.md",    // 真相，只给 GM
  "style": "style.md",    // 可选：全局写作要求，给 GM
  "gmNotes": "前几回合不要主动让玩家移动；破绽靠细节漏。", // 可选：GM 的软约束

  "cast": { ... },        // §3.2
  "state": { ... },       // §3.3
  "arc": [ ... ],         // §3.4
  "endings": [ ... ],     // §3.5
  "rules": { ... },       // §3.6

  "codebook": { ... },    // 可选：群里可说的暗语
  "setpieces": [ ... ]    // 可选：作者保底的剧情节点，GM 决定何时投放
}
```

### 3.2 cast

每个非 `me` 成员一份。`system: true` 的角色由 GM 直接控制（例如默），不调用演员。

```jsonc
"cast": {
  "aqiao": {
    "name": "阿荞",
    "knows": "你是话术托……",
    "doesntKnow": "松岭、小满、昨夜交接、老K现在在哪",
    "wants": "把他从南门/家里挪到B2或车上",
    "fears": "他报警；他不上钩；小十七说漏嘴",
    "voice": "热络，波浪号、语气词……",
    "relationships": { "laok": "同伙，但觉得他不靠谱", "shiqi": "嫌他毛躁" },
    "privateWith": ["laok", "shiqi"]
  },
  "mo": {
    "name": "默",
    "knows": "你知道全部……",
    "doesntKnow": "玩家群外的动作（截图/报警）",
    "wants": "把这一单收干净",
    "fears": "玩家报警；群被截图",
    "voice": "从不发文字；只发系统事件",
    "system": true
  }
}
```

- `knows` 和 `doesntKnow` 是自然语言，GM 读；引擎不解析。
- `privateWith` 是叙事提示，不是硬限制；引擎允许任意 NPC 之间 dm。
- `system: true` 的角色没有演员调用；它的公开消息不应该出现，系统事件由 GM 发。
- 运行时 `npcs[id].knowledge` 初始化为 `cast.knows`；GM 可以在后续回合更新。

### 3.3 state

`state` 是 GM 的世界真相，机器可读；不是玩家看到的 `flags`。

```jsonc
"state": {
  "initial": {
    "playerAt": "south_gate",
    "carAt": "b2",
    "heat": 2,
    "policeThreat": 0,
    "evidence": [],
    "warnings": 0
  },
  "schema": {                       // 可选；不写就是自由 JSON
    "playerAt": ["south_gate", "home", "b2", "car"],
    "carAt": ["b2", "south_gate", "gone"],
    "heat": "number",
    "policeThreat": "number",
    "evidence": "string[]",
    "warnings": "number"
  }
}
```

- 合并规则：浅合并；`null` 删除；数组/对象整体替换。
- 不写 `schema`：自由 JSON，引擎只限大小/深度/防原型污染。
- 写 `schema`：只允许声明的 key；类型/枚举不符则拒绝。
- 上限：序列化后 8KB；深度 4；key 长度 64。

### 3.4 arc

用自然语言写“这一幕的目标”，GM 自己决定何时进入下一幕。

```jsonc
"arc": [
  { "id": "probe", "goal": "让玩家相信车就在附近，确认他是否独处。" },
  { "id": "pressure", "goal": "玩家起疑后换集合点、制造时间压力，开始互相甩锅。" },
  { "id": "reveal", "goal": "矛盾压不住时让某人说漏嘴，默开始清场。" },
  { "id": "endgame", "goal": "逼玩家做最后选择：上车 / 留下 / 报警 / 离开。" }
]
```

- `phase` 的合法值来自 `arc[].id`；不写 `arc` 时 `phase` 是自由字符串。
- 不再有 `atTurn` 硬切幕。

### 3.5 endings

数组顺序只是展示顺序；实际由 GM 选。引擎只检查 `id` 存在、`minTurn`/`maxTurns` 没越界。

```jsonc
"endings": [
  {
    "id": "home",
    "title": "回 家",
    "when": "玩家已经明确离开南门并回到家，且没有上车；玩家已经明确拒绝继续（不再下楼、不再去集合点）。",
    "trigger": { "playerAt": "home" },
    "minTurn": 3,
    "text": "你回家了。<br><br>……"
  },
  {
    "id": "good",
    "title": "南 门 证 人",
    "when": "玩家没有上车，手里有截图或私聊证据，并明确报警。",
    "minTurn": 10,
    "text": "……"
  },
  {
    "id": "bad",
    "title": "上 山 没 信 号",
    "when": "玩家已经进入地库B2、上了车，或跟着NPC离开南门往车边走；口头说走不算，第一次先警告。",
    "trigger": { "playerAt": "car" },
    "text": "……"
  }
]
```

- `when` 是自然语言，只给 GM 读；引擎不做语义匹配。
- `trigger`（可选）：状态硬门槛，只在 GM 没提结局时兜底；只比较 `state` 的键值，不做文本匹配。比如 `{ "playerAt": "home" }` 表示玩家已经被 GM 记录为到家，`minTurn` 到了就直接结束。它是防止 GM 拖着不收的安全网，不替代 GM 的语义判断。
- `minTurn` 是硬门槛；GM 提前提结局会被引擎拒绝并重试一次。
- 不设 `when.intent` / `when.flags`；状态在 `state` 里，由 GM 判断。
- 不设 `grace` / `graceEvents`；需要“第一次警告”就写进 `when`，由 GM 用 `state.warnings` 跟踪。
- `text` 只在结局触发时发给浏览器。

### 3.6 rules

```jsonc
"rules": {
  "softEndTurn": 20,
  "maxTurns": 30,
  "defaultEnding": "home"
}
```

- `softEndTurn`：写进 GM prompt 的软提示，不硬执行。
- `maxTurns`：硬上限；到了还没结局，引擎给 GM 一次“必须收”的调用；还没有就用 `defaultEnding`。
- `defaultEnding`：必须是 `endings[].id`；缺省时用最后一条。

### 3.7 codebook（可选）

群里可以说的暗语；GM 和演员看得到，玩家看不到。

```jsonc
"codebook": {
  "按计划": "按原计划把玩家带到B2",
  "老地方": "松岭服务区",
  "那件事": "上一单的交接",
  "撤": "放弃这单，离开"
}
```

- 演员在群里说暗语，细节走 `dm`。
- 玩家可以猜；猜中后 GM 可以把对应事实写进 `state.evidence`。

### 3.8 setpieces（可选）

作者想保底的剧情节点；GM 决定什么时候投放，不再按 `atTurn` 硬投。

```jsonc
"setpieces": [
  {
    "id": "xiaoman",
    "when": "玩家开始怀疑人数，或提到群里少了一个人。",
    "events": [
      { "t": "join", "name": "小满" },
      { "t": "msg", "from": "u:小满", "text": "别去" },
      { "t": "leave", "name": "小满", "text": "「小满」已被移出群聊" }
    ]
  }
]
```

- `events` 里的 `msg` 是剧本保底台词，不是演员写的；GM 投放时直接发给群。
- 如果 GM 自己已经演过类似节点，可以跳过。
- 每个 setpiece 只投放一次；引擎记录 `playedSetpieces`。

## 4. 运行时状态

```jsonc
{
  "version": 5,
  "sid": "…",
  "scenario": "richu",
  "turn": 6,
  "clock": "06:43",
  "phase": "pressure",
  "state": {
    "playerAt": "home",
    "carAt": "b2",
    "heat": 7,
    "policeThreat": 3,
    "evidence": ["location_card", "photo", "screenshots"],
    "warnings": 0,
    "playerCommitted": true
  },
  "publicFacts": ["玩家说自己到家了", "小十七说楼下没车"],
  "npcs": {
    "aqiao": {
      "memory": ["他说他到家了", "小十七当众说楼下没车，我改口B2"],
      "knowledge": "玩家住址；车在B2；小十七在楼下",
      "mood": "慌，装委屈",
      "goal": "先压住他别报警",
      "inbox": [{ "from": "laok", "text": "别在群里说。", "turn": 5 }]
    }
  },
  "threads": {
    "dm:laok|shiqi": [
      { "from": "shiqi", "to": "laok", "text": "他截图了 说要报警 我怎么办", "turn": 5, "leaked": false }
    ]
  },
  "playedSetpieces": ["xiaoman"],
  "ended": null,
  "history": [ ... ]
}
```

- `state`：世界真相，GM 写。
- `publicFacts`：群里看得见的事实，GM 写；最多 30 条，每条 120 字。
- `npcs`：每个 NPC 的私有状态；`memory` 最多 12 条 × 120 字；`inbox` 最多 20 条。
- `threads`：dm 线程；玩家只看到包含 `player` 的线程；服务端保留全部。
- `playedSetpieces`：已投放的 setpiece id。
- `history`：群聊公开日志；给 UI/导出/转写用。
- `ended`：只写一次；写了之后不再接回合。

## 5. GM 输出

```jsonc
{
  "scene": "玩家在群里说自己到家了；老K在B2等；小十七在楼门口，没看见车。",
  "state": { "heat": 5 },
  "knowledge": {
    "aqiao": "玩家说自己到家了；小十七在楼下没看见车；老K把车钉在B2。"
  },
  "publicFacts": ["玩家说自己到家了", "小十七说楼下没车"],
  "phase": "pressure",
  "clock": "06:38",
  "active": [
    { "id": "aqiao", "privateBrief": "小十七当众拆台，说楼下没车；你刚吹自己在车里，现在必须圆。", "urgency": 0.9 },
    { "id": "laok", "privateBrief": "玩家问松岭；你知道03:14你在松岭交接，绝不能承认。", "urgency": 0.8 }
  ],
  "setpieces": [],
  "events": [
    { "t": "notice", "by": "mo", "text": "别在群里说。撤。" }
  ],
  "privateMessages": [
    { "from": "mo", "to": "laok", "text": "撤。" }
  ],
  "ending": null
}
```

- `scene`：共享场景；不能写只有某个 NPC 知道的秘密。
- 玩家位置：由 §5.5 的记录员先写进 `state`；GM 直接读 `state`，不需要输出 `player`。
- `state`：JSON 浅合并补丁；`null` 删除。
- `knowledge`：可选；按 NPC id 替换其知识摘要；最多 2 个/回合；每条 400 字。
- `publicFacts`：新增公开事实；最多 3 条/回合。
- `active`：最多 3 个；按 `urgency` 排序；引擎叫到 2 个开口或全部 pass 为止。
- `setpieces`：可选；从 `sc.setpieces` 里选 id，最多 2 个；引擎把对应事件投放到群，每个只投一次。
- `events`：只允许系统事件：`sys` / `notice` / `rename` / `join` / `leave` / `img` / `loc`；不允许 `msg` / `voice`（公开台词归演员）。
- `privateMessages`：GM 代发的后台私聊；`from` 必须是 `system: true` 的角色（默认 `mo`）；`to` 是成员 id 或 `player`；最多 3 条。
- `ending`：`{ id, reason, evidence }` 或 `null`。`evidence` 只记录，不硬判。
- 如果 `ending` 非空：这一轮不叫演员；播完 `setpieces`/`events` 直接弹结局。想要最后一句台词，就不要在这一轮提结局。

### 5.5 玩家状态记录员（引擎调用，先于 GM）

引擎在每回合开始先调一次“记录员”，只根据玩家这句话更新 state；它不演 NPC、不写台词。GM 看到的是更新后的 state。

```jsonc
{ "at": "car" | null, "committed": true | false | null, "policeThreat": 0 | 1 | 2 | 3 | null, "evidence": ["..."] }
```

- `at`：`south_gate` / `walking` / `home` / `b2` / `car` / `unknown`；没明确位置就 `null`。玩家明确表达“我要回家了 / 我回家了”就写 `home`，不要求已经到家；“我不走了 / 我不回家了”可以改回 `south_gate`；“我要上车”是 `walking`，“我上车了”才是 `car`。
- `committed`：是否已经做出不可逆动作（回家 / 上车 / 进地库 / 报警）。
- `policeThreat`：0–3。
- `evidence`：截图 / 录音 / 照片等，最多 3 条。
- 记录员的话就是事实：玩家说“我上车了”，即使 NPC 没看见，也写 `car`；NPC 的怀疑留给 `npcs` 的 knowledge / mood。
- 引擎在 GM 之后会再应用一次记录员结果，防止 GM 把玩家位置改回旧值。
- 失败时保留原 state，不阻塞回合。

## 6. 演员输出

```jsonc
{
  "pass": false,
  "events": [],
  "private": [
    { "to": "laok", "text": "他截图了 说要报警 我怎么办", "leak": false },
    { "to": "laok", "text": "我就望风的", "leak": true }
  ],
  "memory": "玩家截图了，说要报警；我慌了，问老K怎么办。",
  "mood": "慌，腿软",
  "goal": "问老K要不要撤"
}
```

- `pass: true`：不说话；`events`/`private` 忽略；`memory`/`mood`/`goal` 仍可更新。
- `events`：只允许 `msg` / `voice` / `recall`；最多 2 条；只写自己的话。
- `private`：最多 2 条；`to` 是成员 id 或 `player`；`leak` 是布尔。
- `leak: true`：本来想私聊，结果发到群里；只有 `group` 看得到，目标 NPC 收不到。
- `to: "player"`：走 `dm:<actor>|player`，玩家在私聊里看到。
- `memory`：1–2 句，最多 120 字；追加到 `npcs[id].memory`，超过 12 条丢最旧。
- `mood` / `goal`：最多 40 / 80 字。
- 演员不能发系统事件；不能改 `knowledge`（GM 改）。

## 7. 引擎校验

### 7.1 三层校验

- `validateScenario`：`version` / `id` / `meta.members` / `cast` 覆盖非 me 成员 / `endings[].id` 唯一 / `endings[].trigger` 是对象（可选）/ `defaultEnding` 存在 / `maxTurns` / `state.initial` 是对象 / `arc[].id` 唯一 / `setpieces[].id` 唯一。
- `validateGm`：`state` 是对象 / `knowledge` 的 key 是 NPC / `active` id 合法 / `setpieces` id 合法且未投放 / `events` 类型合法 / `privateMessages` 的 `from` 是 system 角色、`to` 合法 / `ending.id` 存在。
- `validateActor`：`pass` 布尔 / `events` 类型合法 / `private.to` 合法 / `leak` 布尔 / 长度上限。
- `validateTracker`：`at` 在允许值内 / `committed` 布尔 / `policeThreat` 0–3 / `evidence` 字符串数组；越界丢弃。

### 7.2 不做什么

- 引擎不解析玩家文本，不做关键词/正则；玩家状态由记录员 AI 读取，引擎只合并结构化结果。
- 不判断 `when` 的语义；只检查 `ending.id`、`minTurn`、`maxTurns`。
- 不替 GM 决定谁说话；只看 `active` 是否合法。
- 不强制“每轮必须有人说话”；全员 pass 是合法结果。

### 7.3 限额

| 项 | 上限 |
|---|---|
| `state` 序列化 | 8KB |
| `state` 深度 | 4 |
| `publicFacts` | 3 条/回合，30 条总量 |
| `npcs[].memory` | 12 条 × 120 字 |
| `npcs[].knowledge` | 400 字 |
| `npcs[].inbox` | 20 条 |
| `threads` 单线程 | 50 条 |
| `active` | 3 个 |
| `knowledge` patch | 2 个/回合 |
| `setpieces` | 2 个/回合 |
| 演员 `events` | 2 条 |
| 演员 `private` | 2 条 |
| GM `events` | 4 条 |
| GM `privateMessages` | 3 条 |
| 消息文本 | 200 字（语音 asr 160） |

### 7.4 失败处理

- GM/演员 JSON 解析失败：用修复提示重试一次；仍失败则降级，不让整局崩。
- GM 失败：不合并 state，挑一个 speaker 说“接一句”，或发一条 `sys`“群里安静了几秒”。
- 演员失败：视为 `pass`；不要强制塞“……”（v3 的 `gmTurn` 会塞，v5 删除）。
- 全员 `pass`：GM 补一拍（事件/换人/推进），而不是让场面死掉。
- `maxTurns`：GM 一次强制收尾调用；仍无结局则 `defaultEnding`。

## 8. 迁移 v3 → v5（richu）

### 8.1 字段映射

| v3 | v5 |
|---|---|
| `canon.md` | `canon` |
| `style.md` | `style`（全局）+ `cast[].voice`（个人） |
| `pacing.md` | `arc` + `gmNotes` |
| `cast.knows/wants/voice` | 保留，补 `doesntKnow/fears/relationships/privateWith` |
| `beats[].atTurn` | `setpieces[].when`（GM 决定） |
| `director[].atTurn` | `arc` / `gmNotes`（GM 决定） |
| `endings[].when.intent/flags` | `when` 自然语言 + `minTurn` |
| `rules.maxTurns` | 保留，真正执行 |
| `rules.moveGrace` | `state.warnings` 或 GM 逻辑 |
| `intent` / `pickEnding` | 删除 |
| `moved` | 删除；用 `state.playerAt` |
| `grace` / `graceEvents` | 删除；写进 `when` + `state.warnings` |

### 8.2 richu 的 `scenario.json` 关键段

```jsonc
{
  "version": 5,
  "id": "richu",
  "title": "日出小队",
  "meta": { ... },
  "intro": [ ... ],
  "archive": { ... },
  "assets": { ... },
  "canon": "canon.md",
  "style": "style.md",
  "gmNotes": "前几回合不要主动让玩家移动；破绽靠细节漏，不靠台词说。玩家抓到的硬矛盾越多，NPC 越像卡带，但必须有摊牌/撤退的下一拍。",

  "cast": {
    "aqiao": {
      "name": "阿荞",
      "knows": "你是话术托，负责把玩家从南门挪走……",
      "doesntKnow": "松岭、小满、昨夜交接、老K现在在哪",
      "wants": "把他从南门/家里挪到B2或车上",
      "fears": "他报警；他不上钩；小十七说漏嘴",
      "voice": "热络，波浪号、语气词（啦、嘛、呀），爱连发两三条，偶尔语音。被戳穿时甩一个太顺口的借口，然后立刻把话头拽回“你先下楼”。",
      "relationships": { "laok": "同伙，但觉得他不靠谱", "shiqi": "嫌他毛躁" },
      "privateWith": ["laok", "shiqi"]
    },
    "laok": {
      "name": "老K",
      "knows": "你是车手，白色SUV尾号7。昨夜03:14在松岭服务区把上一单的「小满」交给默，收了钱，今早赶回。你现在把车停在地库B2。",
      "doesntKnow": "玩家此刻具体在哪；默是谁",
      "wants": "让他下楼、进地库、上车；少说话",
      "fears": "定位卡被追问；玩家报警",
      "voice": "极短句，句号结尾，慢半拍。常用「到了吗。」「楼下。」「上车。」被追问就沉默、重复，或只回一个句号。",
      "relationships": { "aqiao": "同伙；她话太多", "shiqi": "同伙；毛躁" },
      "privateWith": ["aqiao", "shiqi", "mo"]
    },
    "shiqi": {
      "name": "小十七",
      "knows": "你是望风的，负责数人数、拖时间、确认玩家一个人、没报警。",
      "doesntKnow": "松岭、小满、默是谁、车几点到",
      "wants": "确认他一个人、没报警；拖住他",
      "fears": "他报警；自己背锅",
      "voice": "短、急、少标点，爱@人。反复说「三分钟」「还有谁没到」。被问细节就装没看见。",
      "relationships": { "laok": "听他的", "aqiao": "觉得她甩锅" },
      "privateWith": ["laok", "aqiao"]
    },
    "mo": {
      "name": "默",
      "knows": "你知道全部：克隆群、拉人、松岭交接、小满、善后。",
      "doesntKnow": "玩家群外的动作（截图/报警）",
      "wants": "把这一单收干净",
      "fears": "玩家报警；群被截图",
      "voice": "从不发文字；只发系统事件。",
      "system": true
    }
  },

  "state": {
    "initial": {
      "playerAt": "south_gate",
      "carAt": "b2",
      "heat": 2,
      "policeThreat": 0,
      "evidence": [],
      "warnings": 0
    }
  },

  "arc": [
    { "id": "probe", "goal": "让玩家相信车就在附近，确认他是否独处。" },
    { "id": "pressure", "goal": "玩家起疑后换集合点、制造时间压力，开始互相甩锅。" },
    { "id": "reveal", "goal": "矛盾压不住时让某人说漏嘴，默开始清场。" },
    { "id": "endgame", "goal": "逼玩家做最后选择：上车 / 留下 / 报警 / 离开。" }
  ],

  "endings": [
    {
      "id": "home",
      "title": "回 家",
      "when": "玩家已经明确表示要离开南门 / 回家（不要求已经到家），且没有上车；玩家已经明确拒绝继续（不再下楼、不再去集合点）。",
      "trigger": { "playerAt": "home" },
      "minTurn": 3,
      "text": "……"
    },
    {
      "id": "good",
      "title": "南 门 证 人",
      "when": "玩家没有上车，手里有截图或私聊证据，并明确报警。",
      "minTurn": 10,
      "text": "……"
    },
    {
      "id": "hidden",
      "title": "第 六 个 人",
      "when": "玩家报警，且手里有小满照片、03:14 定位卡或私聊口供，能指向松岭。",
      "minTurn": 10,
      "text": "……"
    },
    {
      "id": "bad",
      "title": "上 山 没 信 号",
      "when": "玩家已经进入地库B2、上了车，或跟着NPC离开南门往车边走；口头说走不算，第一次先警告。",
      "trigger": { "playerAt": "car" },
      "text": "……"
    }
  ],

  "rules": { "softEndTurn": 20, "maxTurns": 30, "defaultEnding": "home" },

  "codebook": {
    "按计划": "按原计划把玩家带到B2",
    "老地方": "松岭服务区",
    "那件事": "上一单的交接",
    "撤": "放弃这单，离开"
  },

  "setpieces": [
    { "id": "xiaoman", "when": "玩家开始怀疑人数，或提到群里少了一个人。", "events": [ ... ] },
    { "id": "photo", "when": "玩家提到松岭，或要求证据。", "events": [ ... ] },
    { "id": "archive", "when": "玩家开始翻聊天记录，或矛盾压不住。", "events": [ ... ] }
  ]
}
```

### 8.3 迁移后删掉

- `server.js` 的 `pickEnding`、`out.intent` 分支。
- `gm.js` 的 `DIRECTOR_PROTOCOL` 里的 `intent` 定义、`ACTOR_PROTOCOL` 里的 `facts`。
- `scenario.json` 的 `endings[].when.intent/flags`、`beats[].atTurn`、`director[].atTurn`、`rules.moveGrace`。
- `s.moved`、`s.flags` 里的剧情 flag（客户端 `archive`/`photo` 门禁保留）。
- `pacing.md` 不再被读取；内容合并进 `arc`/`gmNotes`/`setpieces`。

## 9. 设计决策

- **AI 判断，引擎记账**：记录员先把玩家位置写进 state；GM 读状态、写世界、选结局；引擎只校验结构。
- **不做剧情正则**：没有“玩家说回家→stay”“报警→good”这种规则。
- **leak**：演员标，GM 可否决；默认不 leak，只在 high heat/panic 时用。
- **state**：自由 JSON + 可选 schema；richu 先不写 schema。
- **memory**：NPC 自己写；GM 只读。
- **dm**：统一 `dm:<a>|<b>`；玩家只看到自己参与的线程；NPC↔NPC 默认隐藏。
- **NPC 主动私聊玩家**：可以；`to: "player"`。
- **结局**：GM 提；引擎检查 `id`/`minTurn`/`maxTurns`；`evidence` 只记录。
- **成本**：1 次 GM + 最多 2 次演员/回合；`active` 最多 3，叫到 2 个开口为止。

## 10. 后续（不在本稿）

- judge / leak checker：可选；只在提结局或高 heat 时调用。
- codebook 的泄露检测：可选。
- NPC↔NPC 的群聊/私聊 UI：玩家只看自己的 dm；NPC↔NPC 默认不可见。
- NPC→玩家的 dm 投递：客户端需要 `dmEvents` 通道；v5-lite 可以先做“玩家打开私聊时拉取”，再做实时推送。
- 回放/评估脚本：用同一段对话跑不同模型，统计结局触发率、平均回合、重复率、状态矛盾率。

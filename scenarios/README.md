# 剧本格式

一个剧本 = `scenarios/` 下的一个文件夹。放进去、在 `index.json` 里登记 id，刷新页面就能玩，**不用改任何代码**。

```
scenarios/
  index.json          {"scenarios":["richu","另一个剧本id"]}
  richu/
    scenario.json     结构：群、成员、开场、历史、节拍、结局
    canon.md          真相（只给模型看，浏览器读不到）
    style.md          人设与文风
    pacing.md         节奏
    protocol.md       可选：覆盖默认的输出协议
    assets/           图片资源，能被 scenario.json 的 assets 引用
      xiaoman.svg
```

## 三层内容

| 文件 | 给谁看 | 会不会泄露给玩家 |
|---|---|---|
| `scenario.json` 里的 `meta/intro/archive` | 浏览器 + 模型 | 会（这是玩家能看到的） |
| `scenario.json` 里的 `beats/endings/director` | 只有服务端 | 不会 |
| `canon.md` / `style.md` / `pacing.md` | 只有模型 | 不会，`/scenarios/` 整个目录被拦掉 |

结局文案写在 `endings[].text`，只在真的触发时才随响应发回浏览器。

## scenario.json

```jsonc
{
  "id": "richu",
  "title": "日出小队",              // 列表页标题
  "subtitle": "群聊解密 · …",        // 列表页副标题
  "cover": "🌄",                     // 列表页封面（一个 emoji）

  "meta": {
    "groupName": "日出小队·明早5点出发",  // 顶部群名
    "startClock": "06:15",              // 状态栏时间
    "notice": "5:00 南门集合…",          // 群公告
    "noticeFrom": "老K",
    "noticeMeta": "昨天 23:47",
    "inputPlaceholder": "说点什么",
    "quitText": "退不出去。",            // 点"删除并退出"时的提示
    "members": [
      { "id": "laok", "name": "老K", "a": "K", "c1": "#5d6b78", "c2": "#2f3a44" }
      // a=头像字，c1/c2=头像渐变两端。必须有 id="me" 的一项代表玩家自己。
    ]
  },

  "assets": { "xiaoman": "assets/xiaoman.svg" },  // key 给 img 事件用

  "intro": [ … ],       // 玩家打开页面时逐条播放的聊天，见下
  "archive": {          // "查找聊天记录"里能看到的东西
    "date": "今天 11月17日",
    "items": [ { "name": "老K", "time": "05:00", "text": "…", "gate": "archive" } ],
    "foot": "以上为今天的聊天记录。"
    // gate:"archive" 的条目，要等 flags.archive 被置位后才显示
  },

  "beats": [ … ],       // 按回合数保底投放的剧情节点
  "director": [ … ],    // 每回合塞给模型的导演提示
  "rules": { "moveGrace": 1, "maxTurns": 30 },
  "endings": [ … ]
}
```

### intro 的条目

```jsonc
{ "t": "time",  "v": "06:02" }                                        // 时间分隔
{ "t": "sys",   "text": "「老K」邀请你加入了群聊", "tone": "ghost" }   // 居中系统提示
{ "t": "msg",   "from": "laok", "text": "我到了。楼下。", "d": 700 }   // d=这条之前等多久
{ "t": "voice", "from": "aqiao", "dur": 7, "asr": "转文字内容" }
{ "t": "loc",   "from": "laok", "name": "松岭服务区", "addr": "…", "when": "共享于 03:14", "flag": "3 小时前" }
{ "t": "msg",   "from": "laok", "text": "…", "fast": true }            // fast=不显示"正在输入"，快速带过
```

### beats（保底剧情）

```jsonc
{
  "id": "photo", "atTurn": 8, "flag": "photo",   // 到第 8 回合且 flags.photo 未置位时投放
  "events": [ { "t": "img", "from": "mo", "kind": "xiaoman", "cap": "…" } ],
  "unlock": ["archive"]                          // 同时点亮 flag
}
```
模型自己先做到了（比如自己发了图），flag 就会提前置位，beats 不再重复。

### director（导演提示）

```jsonc
{ "atTurn": 4, "unlessFlag": "renamed", "text": "让默改一次群名。" }
```
每回合把满足条件的条目拼进系统提示，模型据此知道"该发生点什么了"。

### endings（结局）

按数组顺序判定，第一个满足条件的生效。

```jsonc
{
  "id": "bad", "title": "上 山 没 信 号", "text": "结局正文，可用 <br>",
  "when": { "intent": "move", "minTurn": 10, "flags": ["archive"] },
  "grace": 1,                                    // 第一次先不杀，给一次回头机会
  "graceEvents": [ { "t": "sys", "text": "你离开了路灯。" } ]
}
```

- `when.intent`：`move` / `stay` / `police` / `demand` / `accuse` / `smalltalk`
- `when.minTurn`：最早第几回合生效
- `when.flags`：必须已置位的 flag（`archive`、`photo` 等）
- `grace`：宽限次数，触发时只播 `graceEvents`、不结局

## 模型能做的事

`event.t` 支持：`msg` `sys` `recall` `rename` `notice` `join` `leave` `loc` `voice` `img`。
`join/leave` 只接受不在 `members` 里的名字（防止核心成员被"重新拉进群"）。

想改模型的行为边界，先改 `style.md` / `pacing.md`，不用碰代码。

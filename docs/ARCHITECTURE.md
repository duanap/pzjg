# 技术架构设计 —— 骗子酒馆网页版（pzjg）

## 1. 总体架构

```
┌───────────────────────────  浏览器（每个玩家一个） ───────────────────────────┐
│  public/                          纯原生 HTML + CSS + JS，无构建步骤          │
│  ├─ index.html                    单页应用：大厅 / 房间 / 牌桌 三屏切换        │
│  ├─ css/style.css                 暗色酒馆风格样式                            │
│  └─ js/app.js                     Socket.IO 客户端 + 状态渲染 + 动画 + 音效   │
└───────────────┬──────────────────────────────────────────────┬───────────────┘
                │ WebSocket (Socket.IO)                         │ HTTP 静态资源
┌───────────────┴──────────────────────────────────────────────┴───────────────┐
│  server/                        Node.js (Express + Socket.IO v4)             │
│  ├─ index.js                    入口：HTTP 服务 + 静态托管 + socket 接入      │
│  ├─ rooms.js                    房间管理：座位、广播、定时器、断线接管         │
│  └─ game/                                                                    │
│     ├─ deck.js                  牌堆构建与洗牌（纯函数）                      │
│     ├─ engine.js                纯游戏引擎（无 IO、无定时器，可单测）          │
│     └─ bots.js                  机器人 AI（只读局面 → 返回决策）              │
│  test/                                                                       │
│     ├─ engine.test.js           引擎单元测试（node:test）                     │
│     ├─ sim.js                   全机器人对局模拟（验证终局无死锁）             │
│     └─ e2e.js                   真实 Socket 双客户端端到端冒烟                │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 核心原则

1. **服务端权威**：所有牌面、牌堆、轮盘结果只在服务端；客户端只收"自己能看到的信息"，发"动作意图"。
2. **引擎纯函数化**：`engine.js` 不依赖网络和时间，随机数通过注入的 `rng` 提供 → 可确定性单测。
3. **无构建步骤**：前端原生 JS，任何静态服务器 / 宝塔 / EdgeOne 都能部署，`npm start` 即跑。
4. **机器人即玩家**：机器人与人类玩家走**同一套引擎 API**；人类超时的托底动作也复用机器人决策。

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 18 | 用户指定 |
| HTTP | Express 4 | 托管静态页，够用且稳 |
| 实时通信 | Socket.IO 4 | 房间语义、自动重连、事件广播开箱即用 |
| 测试 | node:test 内置 | 零依赖，`npm test` 直跑 |
| 前端 | 原生 JS + CSS | 无构建、无框架，卡牌全部 CSS 绘制，零素材依赖 |

## 3. 目录与模块职责

```
pzjg/
├─ package.json            start / test / sim / e2e 脚本
├─ docs/                   RULES.md / ARCHITECTURE.md / UI-DESIGN.md
├─ server/
│  ├─ index.js             端口(PORT env, 默认3000)、socket.io 接线
│  ├─ rooms.js             Room 类 + 房间表 + 全部定时调度
│  └─ game/
│     ├─ deck.js           buildDeck(devilMode) / shuffle(rng)
│     ├─ engine.js         Game 类：发牌、出牌、质疑、轮盘、恶魔、局流转
│     └─ bots.js           decide(game, seat) → {type:'play'|'call', ...}
├─ public/                 index.html / css/style.css / js/app.js
└─ test/                   engine.test.js / sim.js / e2e.js
```

### Game 引擎状态机

```
Game 构造(seats, devilMode, rng)
  └─ startGame()                      全员复活、受罚次数清零
       └─ startRound(firstSeat)       洗牌发5张、翻目标牌、清空牌堆
            │
            │  playCards(seat, cardIds)   出牌（校验回合/张数/恶魔单出）
            │  callLiar(seat)             质疑 → 返回完整结算结果
            │        │
            │        ├─ 验牌（说谎? / 恶魔现身?）
            │        ├─ 轮盘结算（受罚递增扳机 + 恶魔强制单发）
            │        └─ 存活≤1 ? phase='over' : startRound(下一起始玩家)
            ▼
          phase: 'round' ──► 'over'
```

关键校验（engine 内强制）：
- 出牌必须是当前行动者；牌堆为空时不能质疑；只剩一人有牌时只能质疑；
- 一次出 1–3 张且全部属于自己的手牌；恶魔标记牌必须单独出。

### 随机数与轮盘结算

- `rng` 注入（默认 `Math.random`，测试可注入确定序列）。
- 扳机模拟：一次惩罚扣 N 发 → 随机子弹位 `b ∈ [0,6)`，`b < N` 即死亡（同次惩罚不重转，死亡概率恰为 N/6）；强制单发即 `N=1`。

## 4. 网络协议（Socket.IO 事件）

### C → S

| 事件 | 载荷 | 说明 |
|---|---|---|
| `lobby:create` | `{name}` | 建房并入座 |
| `lobby:join` | `{code, name}` | 凭房号入座 |
| `room:mode` | `{mode}` | 房主切换 normal / devil |
| `room:add_bot` | — | 空位补机器人（房主） |
| `room:kick` | `{seat}` | 房主移除座位 |
| `room:start` | — | 开局（房主，≥2 人） |
| `game:play` | `{cardIds:[]}` | 扣牌 1–3 张（恶魔仅 1 张） |
| `game:call` | — | 质疑上家 |
| `room:rematch` | — | 结束后再来一局（房主） |

### S → C

| 事件 | 载荷 | 说明 |
|---|---|---|
| `room:state` | 座位/房主/模式/房号/阶段 | 大厅与房间屏 |
| `game:start` | 模式、玩家列表、`you` 座位号 | 进入牌桌 |
| `game:state` | **按人消毒后的完整快照**（见下） | 每次状态变化全量推送 |
| `game:challenge` | 验牌结果 + 恶魔标记 + 轮盘逐发结果 | 客户端据此播放动画 |
| `game:over` | `{winnerSeat}` | 终局 |
| `game:notice` | `{text}` | 提示（断线接管等） |
| `err` | `{message}` | 动作被拒 |

### 状态消毒（sanitized state）

```
{
  phase, roundNo, tableCard, mode,
  you: seatIndex,
  turnSeat, mustCall, turnEndsAt,        // 行动者与倒计时截止
  hand: Card[],                          // 只有自己的真实手牌
  players: [{seat,name,isBot,alive,punishments,handCount,connected}],
  pile: { total, plays:[{seat,count}] }, // 牌面不外发
  log: [ 最近 40 条文本战报 ]
}
```

### 动画与节奏

- 结算事件（`game:challenge`）**立即**下发，客户端本地按时序播放：验牌翻牌 → （恶魔横幅）→ 逐发轮盘动画。
- 服务端在结算后延迟 `开牌动画 + 发数×1.3s + 1s` 才发下一局的 `game:state`，动画不会被新回合冲掉。
- 机器人行动延迟 1.2–3s 拟人；人类回合 30s 超时自动托底。

## 5. 房间管理（rooms.js）

- 房间号：4 位大写字母数字；容量 4 座；空闲且无人连接的房间 30 分钟后回收。
- **断线接管**：对局中断线 → 座位原地转为机器人（改名"XX(机器人)"），游戏继续；大厅断线 → 直接移出座位。
- 定时器（机器人思考、人类超时、结算动画间隔）全部登记在 Room 上，终局/解散时统一清理，防止泄漏。

## 6. 机器人 AI 设计（bots.js）

只读引擎公开快照，输出动作：

```
真牌上限 unseenTruths = 8 − 我手里真牌数          # 6 张目标牌 + 2 王
本局宣称总数 claimed = 牌堆已扣总张数
怀疑度 suspicion = max(0, claimed − unseenTruths) / max(claimed,1)

出牌：
  有同点恶魔牌 → 视作真牌，但只能单张出
  真牌充足(≥2) → 65% 出 1–2 张真牌
  手里全是真牌 → 倾向多出（2–3 张）快速清牌
  否则          → 出 1 张假牌（15% 冒险出 2 张）

质疑（非强制时）：
  claimed > unseenTruths        → 必然质疑（数学上必有假牌）
  base = 0.35 + 0.5×suspicion
  +0.15 上家一次扣 3 张（清库可疑）
  +0.20 自己已 2 次受罚（再罚近必死，赌了）
  +0.15 自己手牌烂（假牌多，盼重发）
  −0.15 恶魔模式且上家单张出牌（怕恶魔）
  random() < clamp(base)        → 质疑，否则跟牌
```

## 7. 测试策略

| 层 | 手段 | 验证点 |
|---|---|---|
| 引擎 | `node:test` 单测 + 注入确定 rng | 牌堆构成、恶魔标记数量、出牌校验、真/假/王判定、恶魔现身人群、扳机递增与死亡、局流转、终局 |
| 引擎压力 | `sim.js`：4 机器人 × 50 局全流程同步模拟 | 必有终局、无死锁、无非法状态 |
| 服务 | `e2e.js`：真实 Socket.IO 双客户端 | 建房/加入/开局/出牌/质疑全链路 |
| UI | 浏览器实测 | 三屏切换、出牌、质疑动画、恶魔模式 |

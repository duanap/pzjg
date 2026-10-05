# 🍺 骗子酒馆（pzjg）网页版

复刻 Steam 游戏《Liar's Bar》扑克牌局的网页版，支持 **普通牌局** 和 **恶魔牌局 😈** 两种模式，2-4 人联机（可加机器人补位），断线自动由机器人接管。

> 撒谎，或者扣下扳机。

## 快速开始

```bash
npm install
npm start          # 默认 http://localhost:3000 ，可用 PORT 环境变量改端口
```

打开浏览器创建房间，把 4 位房号发给朋友；一个人也能玩——空位点「加机器人」即可开局。

## 玩法一览（详细规则见 [docs/RULES.md](docs/RULES.md)）

- 20 张牌：K×6、Q×6、A×6、王×2。每局每人 5 张，翻一张目标牌（K/Q/A）。
- 轮到你：**扣 1-3 张牌**宣称全是目标牌（可以撒谎），或**质疑**上家。
- 翻牌验真：混有假牌 → 出牌者上轮盘；全是真牌 → 质疑者上轮盘。
- 🃏 王永远是真牌。左轮 6 弹巢 1 子弹，被罚次数越多扣的扳机越多（1/2/3 发递增）。
- **恶魔牌局**：3 张恶魔标记牌（K/Q/A 各一），只能单独出；被质疑翻开时不算假牌，质疑者受罚，且**全桌有手牌的都要陪拉一次扳机**，打牌的人毫发无伤。

## 技术架构

Node.js + Express + Socket.IO v4，服务端权威、引擎纯函数化、前端零构建（原生 HTML/CSS/JS）。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/UI-DESIGN.md](docs/UI-DESIGN.md)。

## 测试

```bash
npm test   # 引擎单元测试（node:test）
npm run sim  # 全机器人对局模拟（默认 50 局 × 两种模式，验证必有终局、无死锁）
npm run e2e  # 真实 Socket.IO 双客户端端到端冒烟（需先安装依赖，会临时起服务）
```

## 部署提示

- 任意能常驻运行 Node 程序的主机均可（宝塔 Node 项目 / pm2 / systemd）。
- 仅需开放一个端口（默认 3000），WebSocket 与静态资源同源，无需额外反代配置；如走 Nginx 反代记得加 `Upgrade` 头支持 WebSocket。

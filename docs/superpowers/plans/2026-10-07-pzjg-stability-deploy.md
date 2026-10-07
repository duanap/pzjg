# pzjg stability and deployment implementation plan
> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task.

**Goal:** Fix confirmed multiplayer defects, then deploy to pzjg.duanap.cn.
**Architecture:** Keep the authoritative engine and native client. Use a single systemd process behind Nginx.
**Tech Stack:** Node.js, Express, Socket.IO, node:test, systemd, Nginx.
**Spec:** User request in this chat: fix first, then deploy using pzjg.duanap.cn.

## Global Constraints
- Preserve game rules; do not modify databases or unrelated sites.
- Back up affected production configurations before changes.
- Verify origin and public home, health and WebSocket behavior separately.

## Review Focus
- Null/scalar/array lobby payloads must not terminate the process.
- Disconnected players must act as bots with accurate connection state.
- Connected humans must inherit host privileges, including after seat compaction.
- Actions and rematches must not mutate state during settlement.
- New rounds must wait for the existing client animation.

### Task 1: Stability
**Files:** server/index.js, server/rooms.js, test/rooms.test.js, test/server.test.js, package.json.
**Interfaces:** Existing room/socket shapes; additive GET /health and optional HOST.
- [x] Write regression tests and confirm the expected failures.
- [x] Apply minimal fixes and match the frontend settlement duration.
- [x] Run full tests, 300 simulated games and real Socket.IO smoke.
- [x] Review and commit the release locally.

### Task 2: Deployment
**Files:** pzjg-only systemd/Nginx configuration and release artifacts.
**Interfaces:** Verified free loopback port and pzjg.duanap.cn.
- [ ] Inspect server, DNS and certificates; back up configuration.
- [ ] Upload committed archive, install locked dependencies and start unprivileged service.
- [ ] Validate and reload Nginx; verify origin/public gameplay.
- [ ] Report release, results and rollback steps.

## Ledger
- Inspection: clean main at 6f6af4c; no pzjg service/site; DNS points to EdgeOne.
- Ruling: proceed under the user's explicit fix-and-deploy authorization, without a further design approval.
- Ruling: SSH/systemd follows live server topology; panel project tools are unavailable.

- Task 1 complete: 26/26 tests, 300/300 simulations and Socket.IO smoke passed; independent source review found no critical/important issues.
- Ruling: reconnect recovery, room rate limiting, existing CORS and background-tab animation drift remain outside this bounded repair; no gameplay redesign.

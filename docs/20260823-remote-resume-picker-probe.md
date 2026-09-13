# Probe 实证:pinned Codex 0.147.0 `resume` 在 `--remote` 下的会话选择面

验证日期:2026-08-23(gateway job `20260823-223609-26020`,gpt-5.4,danger-full-access,120,823 tokens)
Prompt trace:`codex-prompts/20260823/probe-remote-resume-picker.md`
版本相关事实,升级 pinned Codex 后降级为假设、需复验。

## 已验事实

1. **`codex resume --remote unix://<sock>` 无 id 在 TTY 下渲染官方会话 picker**,
   列表来自共享 store:两条手机侧线程(`01a01f85-…` companion、`01a021a7-…`)
   均可在 picker 内搜索命中(各 1/1)。搜索、排序(Updated/Created)、
   cwd 过滤(`--all` 解除并显示 CWD 列)可用。
2. **`--last` 可跳过 picker 直续最近会话**;`fork` 同样支持 picker/`--last`/`--remote`。
3. **无非交互列表面**:`sessions`/`thread` 子命令不存在(exit 2),help 无 `--list`;
   非 TTY 下一切 resume 入口拒启(`TERM is set to "dumb"` / no TTY,exit 1)。
4. **Picker 内 Esc = 新建会话,不是退出**;退出用 Ctrl-C(exit 0)。脚本化包裹时注意。
5. app-server 未隔离 CODEX_HOME(`telecodex.app-server.start.sh` 无覆盖),与桌面
   CLI 共用 `~/.codex`;桥的 `/sessions` 列表直接读 `~/.codex/state_*.sqlite`
   threads 表(`.vendor/telecodex/src/codex-state.ts:90`)——同一张会话列表三端同源。

## 设计含义

桌面端「任意会话免 UUID 接入共享 app-server」只需一个 PATH 上的透传 wrapper
(pinned binary + `--remote` 常量 + `"$@"`),picker/搜索/最近续接全部由官方 TUI
提供,无需自建列表或改桥。

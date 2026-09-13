# Telegram 富交互使用说明

Bot 现在可以在一次回答里使用 Telegram 原生交互：给消息加 reaction、
拆成多条气泡，以及发送一次性选择按钮。

## 怎么用

1. 先给 bot 发一次 `/new`。已有 thread 不会自动获得新工具。
   如果群里有多个 bot，用 `/new@your_bot`。
2. 像平时一样说话，不需要写 JSON，也没有单独的 `/mood` 命令。模型会根据
   对话节奏和是否存在真实选择，自主决定用普通文字、reaction、气泡或按钮。
3. 出现选择按钮时直接点。选中的一项会变成 `✓ 选项名`，其他按钮消失，
   模型会在同一个 Codex thread 里继续回答。

例如，下面只是正常聊天，不是功能口令：

> 我今晚只剩半小时，脑子有点散，在“读论文”和“整理笔记”之间摇摆。你替我把区别说清楚，但最后这一步我想自己选。

## 当前支持

- 给触发本轮对话的消息加 reaction。
- 按指定顺序发送多条文字气泡。
- 提供 2–4 个选择按钮。
- 富回复成功后替代普通结尾，不再重复回答或追加 `✅ Done`。
- 按钮只允许原 Telegram 用户在原 chat、topic 和 Codex thread 中点击。
- 按钮 30 分钟过期，只能成功使用一次；如果还没被 Core 接收就失败，
  会保留按钮供重试。

Sticker 暂未开放；需要先建立 bot 专用、可信的 sticker catalog。

## 只收到普通文字怎么办

通常是因为当前还是旧 thread。发送 `/new` 后重试。富交互不是每轮必用；
普通文字更自然时，模型会保留普通文字。

## Playwright 实测命令

下面的命令会在专用测试群创建真实 Codex thread，并消耗两个真实 turn：

```bash
cd smoke
HEADLESS=1 TELEMOOD_LIVE=1 \
  SMOKE_CHAT=<-100... 测试群 id> \
  SMOKE_BOT_USERNAME=@your_bot \
  npx playwright test telemood.spec.js
```

它会检查 reaction、气泡/按钮顺序、按钮点击后的 UI、callback 回传，以及
是否错误追加了普通结尾。

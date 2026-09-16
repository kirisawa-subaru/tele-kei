# tele-kei

让电脑上的 Codex 与 Telegram bot 同时在线，在手机和电脑之间继续同一段工作。

简体中文 · [English](README.en.md)

## 这个 fork 重点打磨了什么

**桌面端和 bot 同时在线，接着同一段对话工作。**
不用先退出电脑端，手机就能接着已有对话发消息。Codex Desktop 接入复用了 Codex 的 agent 传话机制，把手机消息送进桌面上已打开的会话；CLI 接入则共享同一个会话服务，让两端沿用同一份上下文。

**为手机打磨历史、回滚与状态操作。**
针对 Telegram 重新打磨了会话浏览与操作：用 `/view` 找历史、看会话详情，`/past` 补看电脑端消息，`/rewind` 回滚对话，`/status` 查看当前会话、上下文用量和额度状态。这套完整操作适用于 CLI 共享会话模式。

另外做了发送重试和未完成回复的补投，减少网络抖动造成的回复中断，照顾手机上的使用体验。

支持 **macOS、Linux**，Windows 可用 **WSL2 Ubuntu**。Codex Desktop 接入目前限 macOS；Linux 使用 CLI 接入。运行 Codex 的电脑需要保持开机、联网。

## 安装需要你提供什么

把仓库链接交给**运行在目标电脑上的 coding agent**，例如 Codex CLI 或 Claude Code。依赖安装和配置由它处理，你只需要准备：

| 需要提供 | 怎么准备 |
| --- | --- |
| Telegram bot Token | 向 [@BotFather](https://t.me/BotFather) 发 `/newbot`，按提示创建机器人 |
| 你的 Telegram 数字用户 ID | 向 [@userinfobot](https://t.me/userinfobot) 发 `/start`，记下自己的 Id |
| 工作目录 | 选已有项目或新建文件夹，和在 Codex CLI 中选择工作路径一样 |
| Codex 订阅账号 | 需要时按提示完成登录，已有登录可复用 |

Token 是机器人的密码。bot 会以你的权限调用 Codex 处理文件和运行命令，用户 ID 请填你自己的。

把下面这段话连同仓库链接发给 agent 即可：

> 请按 https://github.com/kirisawa-subaru/tele-kei 的 SETUP.md 安装。配好后台 bot 和按需打开、恢复的 tmux 电脑端入口。需要 Token、用户 ID、工作目录或登录时再找我。验证手机和电脑能继续同一段对话，再告诉我怎么打开、离开、停止和恢复。

装好后，手机上直接找 bot 聊天；电脑上用 agent 配好的入口打开或恢复会话。**退出 tmux 的显示界面，bot 仍在后台工作；电脑睡眠或关机后无法继续服务。**

## 给安装 agent

从 [SETUP.md](SETUP.md) 开始。完成标准是后台运行、tmux 入口和手机／电脑接续均可用，并交付日常开停方式。

---

由 [kirisawa-subaru](https://github.com/kirisawa-subaru) 维护，基于 [TeleCodex](https://github.com/benedict2310/telecodex) 修改。
[MIT 许可证](LICENSE) · [第三方声明](.vendor/telecodex/THIRD_PARTY_NOTICES.md) · [权限说明](SECURITY.md)

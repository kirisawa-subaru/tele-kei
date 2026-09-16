# tele-kei

把自己电脑上的 Codex 接到 Telegram，在手机和电脑之间继续同一段工作。

简体中文 · [English](README.en.md)

## 能做什么

- **手机和电脑接着聊。** 手机上交代的工作，可以回到电脑继续；电脑里的会话也可以交给 Telegram。
- **直接处理你的文件。** 发文字、图片或文件，让 Codex 在你指定的工作目录里处理，结果回到聊天中。
- **离开终端也能用。** bot 在后台运行；电脑端需要时再打开，tmux 保留终端会话，回来继续。
- **在 Telegram 管理会话。** 新开对话、找历史、切换模型、查看状态，都能在聊天里完成。

支持 **macOS、Linux**，Windows 可用 **WSL2 Ubuntu**。运行 Codex 的电脑需要保持开机、联网。

## 安装需要你提供什么

把仓库链接交给**运行在目标电脑上的 coding agent**，例如 Codex CLI 或 Claude Code。依赖安装和配置由它处理，你只需要准备：

| 需要提供 | 怎么准备 |
| --- | --- |
| Telegram bot Token | 向 [@BotFather](https://t.me/BotFather) 发 `/newbot`，按提示创建机器人 |
| 你的 Telegram 数字用户 ID | 向 [@userinfobot](https://t.me/userinfobot) 发 `/start`，记下自己的 Id |
| 工作目录 | 告诉 agent 希望它处理哪个文件夹 |
| Codex 登录 | 需要时按提示完成账号登录，已有登录可复用 |

Token 是机器人的密码。bot 会以你的权限调用 Codex 处理文件和运行命令，用户 ID 请填你自己的。

把下面这段话连同仓库链接发给 agent 即可：

> 请按 https://github.com/kirisawa-subaru/tele-kei 的 SETUP.md 安装。配好后台 bot 和按需打开、恢复的 tmux 电脑端入口。需要 Token、用户 ID、工作目录或登录时再找我。验证手机和电脑能继续同一段对话，再告诉我怎么打开、离开、停止和恢复。

装好后，手机上直接找 bot 聊天；电脑上用 agent 配好的入口打开或恢复会话。**退出 tmux 的显示界面，bot 仍在后台工作；电脑睡眠或关机后无法继续服务。**

## 给安装 agent

从 [SETUP.md](SETUP.md) 开始。完成标准是后台运行、tmux 入口和手机／电脑接续均可用，并交付日常开停方式。

---

由 [kirisawa-subaru](https://github.com/kirisawa-subaru) 维护，基于 [TeleCodex](https://github.com/benedict2310/telecodex) 修改。
[MIT 许可证](LICENSE) · [第三方声明](.vendor/telecodex/THIRD_PARTY_NOTICES.md) · [权限说明](SECURITY.md)

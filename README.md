# tele-kei

在 Telegram 里使用自己电脑上的 Codex：发消息、收回复，让它帮你处理电脑里的文件。
支持 **macOS 和 Linux**；Windows 用户请在 **WSL2 的 Ubuntu** 中操作。

简体中文 · [English](README.en.md)

## 先准备好

- 一台能连接 Telegram 和 Codex 的电脑。使用时电脑要保持开机、联网，不能睡眠。
- [Git](https://git-scm.com/downloads/) 和 [Node.js](https://nodejs.org/en/download)（22 或 24，推荐 24 LTS）。安装 Node.js 时会一起安装 npm。
- 一个能正常使用 Codex 的账号。Codex 本身会由安装脚本下载。

打开终端，确认下面三条命令都能显示版本号：

```bash
git --version
node --version
npm --version
```

## 1. 创建自己的 Telegram 机器人

1. 打开 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示起名，保存它给你的 **Token**。
2. 打开 [@userinfobot](https://t.me/userinfobot)，发送 `/start`，记下你自己的数字 **Id**。

Token 是机器人的密码，不要分享。Id 要填你自己的用户 ID，不是机器人的 ID，也不是 `@用户名`。

## 2. 下载并填写配置

以下安装步骤只需做一次。在终端依次运行：

```bash
cd ~
git clone https://github.com/kirisawa-subaru/tele-kei.git
cd tele-kei
cp .telecodex.env.example .telecodex.env
chmod 600 .telecodex.env
nano .telecodex.env
```

找到下面两项，**去掉行首的 `#`**，把等号后的内容换成刚才拿到的值：

```ini
TELEGRAM_BOT_TOKEN='你的Token'
TELEGRAM_ALLOWED_USER_IDS=你的数字Id
```

其余配置保持默认。在 nano 中按 **Ctrl+O → 回车**保存，再按 **Ctrl+X**退出（Mac 也是 Ctrl，不是 Command）。

WSL2 用户也用上面的 `cd ~`，把项目放在 Linux 的家目录里，不要放进 `/mnt/c/`。

## 3. 给它一个工作文件夹

先创建一个空文件夹供 Codex 使用。继续在 `tele-kei` 目录运行：

```bash
mkdir -p "$HOME/tele-kei-work" profiles/main
cat > profiles/main/profile.json <<EOF
{
  "default_workspace": "$HOME/tele-kei-work"
}
EOF
```

之后把要处理的文件放进家目录下的 `tele-kei-work`。机器人可以在工作文件夹里修改文件和运行命令。
想用已有项目时，把 `profiles/main/profile.json` 里的路径改成那个项目的完整路径。

## 4. 安装并登录 Codex

```bash
./telecodex.setup.sh
./telecodex-bin/codex login status
```

第一次安装需要联网下载，请等它完成。如果提示尚未登录，运行下面这条，按提示完成登录：

```bash
./telecodex-bin/codex login
```

没有浏览器的 Linux 机器可用 `./telecodex-bin/codex login --device-auth`，在另一台设备按提示完成登录。

## 5. 启动，然后去 Telegram 聊天

打开 **三个终端窗口**，按顺序运行。每个窗口启动后保持打开，再去下一个窗口；有报错就先处理报错。

**窗口 1：**

```bash
cd ~/tele-kei
./telecodex.app-server.start.sh
```

**窗口 2：**

```bash
cd ~/tele-kei
./telecodex.core.start.sh
```

**窗口 3：**

```bash
cd ~/tele-kei
./telecodex.worker.start.sh main
```

现在打开你刚创建的机器人，点 **Start / 开始**，发一句「你好」。收到回复就可以用了。

常用命令直接发给机器人：

| 命令 | 用途 |
| --- | --- |
| `/new` | 新开一段对话 |
| `/status` | 看当前状态 |
| `/model` | 选择模型 |
| `/view` | 找回之前的对话 |
| `/help` | 查看更多用法 |

**停止：**依次在窗口 3、2、1 按 Ctrl+C。下次使用只需重复第 5 步，不用重新安装或填 Token。

## 遇到问题

- **提示找不到 Node / npm：**确认装的是 Node.js 22 或 24，重新打开终端，再运行开头的版本检查。
- **机器人不回复：**先看三个窗口是否有报错，再检查 Token、自己的数字 Id，以及这台电脑的网络。
- **提示未登录 Codex：**回到第 4 步登录，再重新启动。

想关掉终端后继续运行，可按需配置[后台启动](deploy/README.md)。如果希望让 coding agent 帮你配置，给它看 [SETUP.md](SETUP.md)。

## 来源与许可

由 [kirisawa-subaru](https://github.com/kirisawa-subaru) 维护，基于 [TeleCodex](https://github.com/benedict2310/telecodex) 修改。
采用 [MIT 许可证](LICENSE)，保留上游版权声明和[第三方声明](.vendor/telecodex/THIRD_PARTY_NOTICES.md)。

更多配置见 [使用参考](TELECODEX.md)，权限说明见 [SECURITY.md](SECURITY.md)。

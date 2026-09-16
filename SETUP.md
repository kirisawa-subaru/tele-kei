# tele-kei：给安装 agent 的操作指南

用户把仓库交给你后，由你完成依赖、配置和安装。只向用户索取缺失的 Token、数字用户 ID、工作目录，以及必须由本人完成的 Codex 登录。

**默认交付是后台 bot + 按需打开的 tmux CLI。** bot 要持续接收 Telegram 消息；电脑端 CLI 只在用户需要时打开，并连接同一个 app-server。分离 tmux 不会停 bot，tmux 也不负责开机恢复后台服务。

完成标准：

- app-server、Core、worker 由系统服务托管，用户不用保持三个终端窗口。
- 有一个 `tele-kei` 电脑端入口：首次打开 CLI，之后恢复同一 tmux 会话。
- 验证 Telegram 回复、手机／电脑接续，以及离开终端后 bot 仍可用。
- 用户拿到简短的打开、分离、停止、恢复说明，知道重启电脑后的行为。

参数和检查项见 [setup-manifest.json](docs/setup-manifest.json)；本文规定执行顺序与交付范围。

## 1. 确认目标电脑与已有安装

在实际运行 bot 的电脑上操作。先检查平台、仓库目录和已有服务；SSHFS 等映射路径不代表命令执行在另一台机器。

```bash
uname -s -m
pwd
```

- 支持 macOS、Linux、WSL2。WSL2 的 checkout 和运行数据放 Linux 文件系统，不能放 `/mnt/c/` 等 Windows 挂载。
- 若还没有 checkout，克隆 `https://github.com/kirisawa-subaru/tele-kei.git` 到本机目录。
- 已有安装先读配置，保留其 Token、会话和用户改动；不要重复复制 env 示例覆盖配置。
- 先确认已有的同名服务、tmux 会话和快捷命令属于哪个安装，不覆盖别的部署。同一 Token 只能有一个 Telegram worker。
- 不输出凭证，不提交 `.telecodex.env`、`.telecodex/`、`.vendor/codex/`。权限含义见 [SECURITY.md](SECURITY.md)。

## 2. 收齐资料，安装依赖

从用户已有信息中取值，只询问缺失项：

| 信息 | 用法 |
| --- | --- |
| Telegram bot Token | `.telecodex.env` 的 `TELEGRAM_BOT_TOKEN` |
| 用户自己的数字 ID | `TELEGRAM_ALLOWED_USER_IDS`；不要填 bot ID 或用户名 |
| 工作目录的完整路径 | `profiles/main/profile.json` 的 `default_workspace`，同时用于电脑端入口 |
| Codex 账号 | 优先复用此运行用户的已有登录；没有则在第 4 步完成登录 |

默认 bot key 是 `main`。确认用户知道 bot 会通过 Codex 处理工作目录中的文件、执行命令即可，不把安装文档转交给用户逐段阅读。

检查 Git、Node 22/24、npm、tmux。缺依赖时按本机包管理方式安装；安装器或提权需要人工操作时，只让用户完成那一步。Node 优先 24。不要为安装这个项目另加 Docker 或编译工具链。

```bash
git --version
node --version
npm --version
tmux -V
```

运行脚本会自动查找 Node；若版本管理器未加入当前 PATH，使用同样的发现逻辑：

```bash
bash -c 'TELECODEX_ROOT=$PWD . ./telecodex.runtime.sh; telecodex_prepare_runtime; "$TELECODEX_NODE_BIN" --version'
```

需要覆盖路径时写入 `.telecodex.env` 的 `TELECODEX_NODE_BIN` / `TELECODEX_CODEX_BIN`，不要修改启动脚本。
`rsvg-convert` 是可选的公式图片依赖：需要时安装 librsvg；没有它不阻止普通文字收发。

## 3. 写配置

首次安装才复制：

```bash
cp .telecodex.env.example .telecodex.env
chmod 600 .telecodex.env
mkdir -p profiles/main
```

填写 Token 和数字 ID，不在日志、终端输出或提交中展示 Token。env 文件采用 shell 赋值语法，含空格的值须加引号。

保留以下默认值：

```ini
CODEX_BACKEND=app-server
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=never
TELECODEX_BOT_KEY=main
```

只支持 `never`；项目没有审批交互。不要为了绕过报错扩大 sandbox。

在 `profiles/main/profile.json` 写入用户选择的工作目录，不要把源码目录默认为用户工作目录：

```json
{
  "default_workspace": "/absolute/path/chosen/by/the/user"
}
```

根 env 先加载，worker 的实例 env 再覆盖。其他 bot 需要各自的凭证；本指南先交付 `main`。

## 4. 安装、登录

```bash
./telecodex.setup.sh
./telecodex-bin/codex --version
./telecodex-bin/codex login status
```

setup 安装依赖、构建程序、获取固定版本的 Codex，并把 `telegram-active` 放到 `~/.local/bin/`。不需要全局安装第二份 Codex。

若未登录，让用户完成 `./telecodex-bin/codex login`。没有浏览器的主机可用 `./telecodex-bin/codex login --device-auth`，按实际提示在另一台设备完成登录。若用户明确使用 API key，按现有 `CODEX_API_KEY` 配置路径处理。

确保后台服务、电脑端 wrapper 使用同一个运行用户、`CODEX_HOME` 和 app-server socket。不要为了 tmux 另起一个独立 Codex 后端。

## 5. 安装后台服务

这一步是默认交付的一部分。可以用前台启动排障，但不要把三个前台窗口作为最终使用方式。

使用现有模板：

```bash
./deploy/render.sh --bot-key main
```

render 只生成文件和打印安装命令。检查内容后，**执行生成的安装命令**，依次启动 app-server、Core、worker；每层就绪后再检查下一层。已有服务先确认归属并复用，不直接覆盖。

- **Linux：**安装到该用户的 systemd unit 目录，启用 app-server、Core 和 `telecodex-worker@main`。用 `systemctl --user status` / `journalctl --user` 查状态和错误。需要退出登录后仍在线时设置 `loginctl enable-linger "$USER"`，确认它实际生效。
- **macOS：**渲染 launchd 模板，使用明确的 label prefix，例如 `io.github.kirisawa-subaru.tele-kei`。创建日志目录，安装并 bootstrap 三个 LaunchAgent。用 `launchctl print` 核实状态；它们在该用户登录后自动启动。
- **WSL2：**先确认 systemd 可用。需要修改 `/etc/wsl.conf` 并重启 WSL 时，让用户完成这一阶段后继续。说明 bot 依赖 WSL 实例保持运行。

具体命令和日志位置见 [deploy/README.md](deploy/README.md)。服务状态、socket 和实际收发都要检查，不能只凭文件已生成判断完成。

若用户明确选择手动开停，可以不启用自动启动，但仍提供后台运行方式及确定的开停命令。未能完成后台配置时，说明实际缺项。

## 6. 配置按需打开的 tmux 入口

目标：用户输入 `tele-kei`，第一次打开电脑端 CLI，以后回到原来的 tmux 会话；bot 不受终端关闭影响。

复用已有 `telecodex-bin/telecodex-remote`。它会连接当前 checkout 的共享 app-server，运行同一份固定版本 Codex；不要改为裸 `codex` 命令。

原生命令如下。`REPO`、`WORKSPACE` 必须换成安装目录和用户选择的工作目录，不要把示例路径写进实际入口：

```bash
REPO='/absolute/path/to/tele-kei'
WORKSPACE='/absolute/path/chosen/by/the/user'
tmux new-session -A -s tele-kei -c "$WORKSPACE" \
  "$REPO/telecodex-bin/telecodex-remote" \
  --cd "$WORKSPACE" --ask-for-approval never --sandbox workspace-write resume --all
```

将这条调用做成本机的 `tele-kei` 快捷入口（现有 shell 的函数或 `~/.local/bin/tele-kei` 短脚本即可），写入实际路径并正确转义。无需另建会话管理程序。若用户选了不同的 sandbox，入口应与已确认配置一致。

入口行为必须包括：

- 没有该 tmux 会话时创建，有则恢复，不重复创建 CLI。
- 从已有 tmux 内调用时，用 `switch-client` 切换；必要时先用 `new-session -d` 创建，避免嵌套 attach。
- bot 停止时按已有服务配置恢复，或给出确定的恢复命令；不能另起第二套 app-server。
- CLI 已退出、tmux 会话不存在时，下次调用可以重新打开会话选择器。`resume --all` 让不同工作目录下的 Telegram 会话可见。

把入口和 `telegram-active` 加入运行用户的 PATH。确认 `telegram-active` 指向本 checkout；setup 不会覆盖已有的同名命令。后台 app-server 的环境也必须能找到它，例如在 `.telecodex.env` 中加入：

```bash
PATH="$HOME/.local/bin:$PATH"
```

若修改了后台服务环境，受控重启后再验收。不要只验证交互 shell 的 PATH。

教用户：按 **Ctrl+B，再按 D** 分离；再次运行 `tele-kei` 恢复。关闭 CLI 或分离 tmux 都不等于停止后台 bot。电脑重启后 tmux 终端进程不会保留，`tele-kei` 可重新打开并选择已保存的 Codex 会话。

## 7. 验收日常使用

用用户同意的测试对话做少量真实交互；请求用户发消息，或按明确授权代操作。不要把调试消息注入已有的重要工作线程。

1. **手机可用：**让用户给 bot 发一条短消息，确认有回复。
2. **电脑能接续：**用安装好的 `tele-kei` 入口打开 tmux，选择这条 Telegram 对话，核对同一 thread 和工作目录；从 CLI 发一条短消息并收到回复。
3. **电脑 → 手机：**在 CLI 输入 `!telegram-active` 绑定这条对话，再从 Telegram 延续刚才 CLI 中的内容，确认上下文接续且 thread 没变。需要看电脑端消息时使用 `/past`。
4. **终端可恢复：**分离 tmux，再打开入口，确认回到同一 pane/CLI；在分离期间确认 bot 仍能回复。
5. **服务可恢复：**在测试 turn 完成后，验证安装好的服务停止／启动方式以及历史会话仍能打开。检查自启动配置；没有实际重启电脑，就不要声称已经做过整机重启验收。

这些检查验证的是当前安装与交接，不要求重跑项目的全部开发测试。遇到失败就处理对应问题；未完成的检查明确记下。

## 8. 交给用户

最后只给用户本机可直接使用的信息：

- bot 的 Telegram 入口、它工作的文件夹；
- `tele-kei` 的打开／恢复方式，Ctrl+B → D 的分离方式；
- 暂停 Telegram 收发的命令：只停该 bot 的 worker，保留 Core/app-server，电脑端 CLI 可继续使用；以及恢复 worker 的命令；
- 完全停止的命令：先退出 CLI，再依次停止 worker、Core、app-server；说明停 app-server 会断开共享它的 CLI，并给出整套服务的恢复顺序；
- 重启电脑后是自动恢复、登录后恢复，还是需要手动启动；
- 一处日志位置，供出问题时交给 agent 排查。

用户不需要了解三进程架构、模板渲染、构建或日常测试。后续需要高级功能时再查 [TELECODEX.md](TELECODEX.md)。

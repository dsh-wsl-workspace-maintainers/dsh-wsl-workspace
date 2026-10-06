# dsh-wsl-workspace

[![dsh.so security](https://www.dsh.so/badge/dsh-wsl-workspace.svg)](https://www.dsh.so/artifact/dsh-wsl-workspace)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-wsl-workspace.svg)](https://www.dsh.so/artifact/dsh-wsl-workspace)

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md)
![alt text](image-3.png)
在 DeepSeek Harness Web GUI 中「添加 WSL 工作区」：让 agent 会话的 bash 命令与文件读写都运行在本机 WSL 发行版里，路径均为 Linux 形式，WSL 内无需安装任何工具链。会话可同时访问 WSL 与 Windows 两个系统——bash 命令在 WSL 发行版内执行，Windows 文件随时可通过 `/mnt/<drive>`（如 `/mnt/c/Users/...`）访问。

## 安装

三种方式任选其一，然后重启 `dsh web`：

```powershell
# 1) npm 包
dsh plugin --profile web add dsh-wsl-workspace

# 2) GitHub 仓库（仓库内已含预构建 lib/，无需本地构建）
dsh plugin --profile web add https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

# 3) 本地目录（开发/自用）
dsh plugin --profile web add D:\path\to\dsh-wsl-workspace
```

重启 `dsh web` 后，侧栏底部 Settings 旁出现 W 按钮。

## 兼容性

这份构建声明兼容下列 DSH 版本，每一条都在隔离实例上实测过（独立 `DSH_HOME`、依赖固定到该版本、跑满整套门禁）：

`0.1.0-rc.7` · `0.1.0-rc.8` · `0.1.1-rc.1` · `0.1.1-rc.2` · `0.1.2-rc.1` · `0.1.3-alpha.2` ·
`0.1.5-rc.1` · `0.1.5-rc.2` · `0.1.7-rc.1` · `0.1.7-rc.2` · `0.2.0-rc.2`

这份列表与 `package.json` 里的 `dsh.compatibility.dshReleases` 一一对应，单测会在两者不一致时失败。
其中 `0.2.0-rc.2` 就是 DSH Desktop `0.2.0-rc.2` 自带的 DSH 版本，所以桌面版由同一份声明覆盖；应用内帮助面板（对话框右上角「?」）会显示同一组 chip 以及插件版本。
插件在运行时自动识别 DSH 版本并选用对应的 API；两边都不支持时会明确报错，而不是留下一个空工作区。版本不在列表里通常仍然可用，但未经验证。

## 使用
点侧栏底部 Settings 旁的 W 按钮，打开「添加 WSL 工作区」对话框。先从下拉框选择一个发行版，再浏览目录树或直接输入 Linux 绝对路径（如 `/home/me/proj`），可以点「检查」确认路径存在。对话框文案跟随 DSH 界面语言。用户名是可选项：留空则以该发行版的默认用户运行，填写该发行版里的某个 Linux 用户名则以该用户运行（等价于 `wsl.exe -u <用户名>`）。用户名只影响 bash 命令的运行身份，文件工具通过 Windows 侧的 WSL 共享访问、不受其影响；每个工作区填写的用户名保存在 `<dshHome>/wsl-workspaces.json`，删除对应条目（或重开对话框重建工作区）即可恢复默认用户。

点「创建并打开」后，新会话随即运行在 WSL：`bash` 工具在所选发行版内执行命令，`read`/`write`/`edit` 读写 WSL 文件，模型看到的所有路径都是 Linux 形式。模式选择器照常可用——标准、PTC、极简、创造都会自动落到对应的 WSL 变体（选择器里的 WSL 变体条目为中英双语，如 `WSL · Standard mode（标准模式）`）；会话内仍可通过 `/mnt/<drive>`（如 `/mnt/c/Users/...`）访问 Windows 文件。对话框右上角的「?」按钮会展开一页说明：这份构建声明兼容的 DSH 版本、插件的用法与特性，以及它无法绕过的已知限制。
![alt text](image-2.png)
## 行为与权限说明

- **bash 工具**：以配置的用户名在 WSL 发行版内运行（留空 = 发行版默认用户，通常为 root），可对发行版内任意路径读写。Windows 的 ACL 沙箱无法包裹 `wsl.exe`（子进程运行在 Linux 内核侧），WSL 自身即隔离边界，DSH 文件策略不作用于 bash。
- **文件工具（read/write/edit）**：经 Windows 侧的 WSL 9P 共享访问；用户名设置不影响它们。宿主原本会提供的两处能力，现在由 WSL 世界自己在内部补上——变体在预设的 isolate realm 里挂自己的 `fs` 提供者，宿主的 `fs-sandbox` 包装层不在调用路径上。**符号链接**：共享只列得出链接、解不开目标，链接路径以前会被当成不存在的文件；现在 `resolve`/`lstat` 会向发行版问一次真实路径（`wsl.exe … readlink -f`）并从那里继续，链接本身绝不会被普通文件替换。**访问模式**：`write`/`edit` 完全按宿主后端的做法由 `ctx.sandboxPolicy` 围栏——同一份 `writableRoots` 白名单（另加发行版的 `/tmp`，即会话所在世界的临时区）、同样的 `FS_SANDBOX_DENIED`（工具层会渲染成拒绝）、同样的 `sandboxMode`（工具据此声明升级）。由于围栏在解析之后执行，判定的是真实路径：链接指向工作区外就按工作区外处理，`workspace-write` 下会被拒绝。完全没有策略服务的部署则不围栏，与宿主一致。**文件引用**（issue #49）：会话里的文件链接、工具行的行号引用、回合末尾的「已改动文件」都走右侧栏，地址里带的是模型原样写下的 Linux 路径。宿主用 `node:path.resolve(cwd, path)` 解析它，而 POSIX 绝对路径在 Windows 上是「当前盘根目录下的相对路径」，所以文档面板以前报文件不存在：`/mnt/d/x` 落到工作区所在的盘（`D:\mnt\d\x`），发行版内的路径落到 cwd 共享的根下，而 drvfs 挂载在 9P 下服务不了、报 `EPERM`。客户端半边现在先把地址翻译好再交给侧栏——`/mnt/<盘符>/…` 换回 `X:\…`，其余 Linux 路径走该发行版的 UNC 共享（发行版取自会话的 UNC 工作区，或 `/mnt/<盘符>` 工作区注册时存下的记录）——tab 的内容与同一地址下的元数据读取一并修好。插件不认为是 WSL 会话的地址原样不动；逐字节重建不出来、或发行版未知的地址也原样透传，不做猜测：宿主平面没有可用的钩子——`fs` 与 `workspaceFiles` 端点属于别的插件，cordis 也不允许第二个 `provide` 抢别人 fiber 持有的名字。另外，只有 0.1.5-rc.1 及以后才有右侧栏与文档预览，六个更早的已声明版本上这个钩子根本不会安装。
- **文件搜索（grep / glob）**：宿主的搜索套件驱动的是打包进来的 **Windows** ripgrep，模型交给它的路径却全是 Linux 路径，所以 WSL 变体一直把这一行丢掉、让模型自己在 shell 里搜。现在世界挂上自己的同类实现（`src/host/wsl-search.ts` → `lib/wsl-search.js`），搜索**在发行版内**执行：工具名、参数 schema、条数上限、输出 schema（`Line N:` 分组、命中数表头、超限尾部提示）、搜索卡片与超限结果落盘全部沿用 `@deepseek-ai/dsh-tool-fs-search` 自己导出的部件，所以模型看到的东西与宿主一致。`grep` 用发行版自带的 GNU grep（`-rnIEH -Z`，POSIX ERE：`\d`、`\w`、`\b`、`(?i)` 可用，环视与反向引用不支持），像 ripgrep 默认那样跳过隐藏文件/目录与 `node_modules`，**不读 `.gitignore`**，`{a,b}` 会展开成多个 `--include`，含 `/` 的 include 在插件进程里按相对路径匹配（ripgrep 语义）；发行版没有 GNU grep 时明确报错，而不是给出错位的记录。`glob` 用 GNU `find` 列出文件（`-printf` 直接带出修改时间，不必逐个 stat），在插件里按 gitignore 风格匹配（`*` 不跨分隔符、`**` 跨、`?`、`[...]`、`{a,b}`，前导 `!` 取反），并按修改时间从旧到新排序——与 `rg --sort=modified` 一致。两者都直接搜 Linux 真实目录（符号链接、权限、不理会忽略规则），不走 9P 共享；都跳过版本库目录，也都不跟进递归中遇到的符号链接（同样是 ripgrep 的默认）。源预设没有搜索套件的模式（极简）不会凭空多出这两个工具。
- **技能目录（skill catalog）**：从会话 cwd 最近的 `.git` 祖先开始（没有 `.git` 祖先则用 cwd 本身）向下扫描 `.dsh/skills` 与 `.agents/skills`（含嵌套项目），上限为 4 层目录、64 个技能目录、4096 个已访问目录。建议把工作区注册在你实际工作的项目根；若注册目录本身在更大的 git 仓库里，扫描会从该仓库根开始（与宿主规则一致），同级项目可能一并出现。Windows 侧共享解不开的 Linux 符号链接会改由发行版解析（`wsl.exe … readlink -f`，每次查找最多 32 条、并发 4 条），解析后从真实路径继续扫描，因此 `ln -s` 链进来的项目、以及它下面的嵌套项目都能被发现，并按真实路径去重。技能正文始终实时读取。生成预设会把 `skill-filesystem` 行的 `watch` 固定为 `false`（对 `\\wsl.localhost\...` 开监视会失败），插件改为自己轮询，分两档：轻量档每 3 秒重查一次已发布的技能目录、并给每个技能文件记一次修改时间与大小，所以会话中途**新增、删除或改写**技能都会在下一个回合生效——改写这条正是时间戳的意义：模型看到的目录只在注册表修订号变化时重建，而光看目录列表分不出一个被改写的 `SKILL.md` 和没动过的文件。完整重新发现每 30 秒一次，因为只有走一遍才可能找到此前不存在的技能目录（比如新项目里的第一个 `.dsh/skills`）。两档都不重读技能正文。
- **shell 的生命周期**：`bash` 现在**有状态**——`cd`、export 的变量、激活的 venv、后台任务都跨调用保留。它是发行版里一只长命的 `bash --norc -i`，由本插件启动（`src/host/wsl-bash-tool.ts` + `src/host/wsl-bash-session.ts` → `lib/wsl-bash-tool.js`）并**经管道**驱动：每条命令以 base64 送出，shell 用一条 NUL 分隔的记录回答，记录里带着这次调用独有的 nonce 和退出码——完成是一个字节通道上的事件，而不是在终端画面上匹配一行字。这是有意替换宿主的 PTY 持久 shell：它的判据是"在终端文本里找到哨号行，并要求退出码后面紧跟换行"，而交互式 Linux shell 会重绘那一行，把擦掉的格子留成哨号之后的空格，于是判定永远不成立——在真实的 DSH Desktop 0.2.x 会话里，连续三次调用各挂 303.8 秒，之后宿主把 shell 重置（issue #51）。登录环境没有丢：会话启动时依次 source `/etc/profile`、`~/.profile`、`/etc/bash.bashrc`、`~/.bashrc`，**把它们自己的输出丢掉**，并关闭 history expansion，于是命令里的 `!` 就是模型写的那个意思。PTY 那一档用 `DSH_WSL_PTY_SHELL=1` 仍可挂载以便对照——那一档挂的是宿主 PTY 后端指向本插件的中继脚本（`src/host/wsl-relay.ts` → `lib/wsl-relay.js`，中继把 PTY 交给 `wsl.exe … bash -i`）；世界同时隔离并提供自己的 no-op `sandbox` 能力（`src/host/wsl-sandbox.ts`）——宿主的 Windows ACL 运行器读不了 `\\wsl.localhost\…` 工作区根的安全描述符。命令都在发行版内运行，不受 DSH 文件策略约束——WSL 自身就是隔离边界。**包装带来的两个后果写在工具描述里**：整轮会话只有这一只 shell，所以某次调用里的 `cd` 决定下一次从哪里开始——请用绝对路径或在命令开头显式 `cd`；命令以 `&` 结尾会在**调用内部**被后台化——调用立刻返回 exit code 0 且没有输出，真正的输出晚到，甚至落进下一次调用的输出里。后台任务请写成单独一行的 `( 长任务 > log 2>&1 ) &`，或使用后台任务工具。终端是**按进程实际在做什么**给的，不再按命令的名字：一旦命令卡在键盘上，工具会在它卡住的过程中把它看出来、停下来，并在**同一次调用里**用属于它自己的伪终端重跑一遍——伪终端由会话内部的 `script -qec` 起，而记录仍由外层帧在 `script` **之外**写出，所以升级碰不到协议（机械部分在 `src/host/wsl-bash-tty.ts`，那份读数本身在 `src/host/wsl-bash-starve.ts`）。判别靠从会话外面向发行版看第二眼：进程状态、`/proc/<pid>/wchan`、它的描述符里有没有终端、以及它在不在烧 CPU——把"在等一次按键"和"在干活"分开的就是这几列，而不是命令名。`tty: true` 仍可一上来就要终端，`tty: false` 则否决那次重跑；一次在终端上失败、又不落在已知形状里的调用会自己说明是哪一层、以及一发就能定案的对照（见 docs/tty-triage.md，该件为英文）。**2026-10-05 实测的几发**（`D:\Temp\issue51-s0\v5-run.txt`）：`sh -c 'read x < /dev/tty'`——程序名是 `sh`，过去任何一份名单里都没有它——在 628 毫秒被停下、1 760 毫秒带回它自己的 `GOT=`；同样安静、同样不耗 CPU 的 `sleep 4` 一步没被碰；`sudo` 要密码时会把自己的 `/proc` 条目藏起来（它清掉了 dumpable 标志），于是改由**发行版的 root 权限**读同一枚探针——root 看得到它自己的用户看不到的那次等待——2 412 毫秒变成 2 412 毫秒，带回 sudo 自己的话；一条为等待键盘的请求写了 60 000 毫秒期限的调用 1 733 毫秒就返回了。旧规则为同样的形状付出的是默认两分钟外加一次会话重建，而之所以改用名单：本票里量着了两件事——`ssh-copy-id` 因为扫描停在连字符上而永远匹配不上，`printf x; vim note.txt` 因为只读第一个词而烧掉 **121 703 毫秒**。**重跑就是第二次执行，所以正文会明说**：一条在走到它的提示之前已经做过些什么的命令，现在把那部分做了两遍。万一某条命令把 shell 卡住，会话会被重建，工作目录和 export 的变量回放进新会话——而**只是跑得久**的命令不会被第二次执行。**边界是一只 agent 一只 shell**：第二只 agent 的 `cd`、export 的变量、别名与脱离进程都属于它自己，同时发出的两次调用各自带回各自的答案，重建时的进程清扫只停携带本会话令牌的那些进程，而一只 agent 自己的作用域结束时它的 shell 随之停止——于是一个窗口里几轮会话不会攒出没人能关掉的 shell。**有一件事最好在 agent 需要 root 之前就知道**：这只 shell 是非交互的，所以会要密码的 `sudo` 在**这里**没人能答——它约 100 毫秒失败，带回 sudo 自己的话和两条出路（人在产品右栏的终端标签里跑一次，那里能输密码；或给会话用户配 sudoers 的 `NOPASSWD`，或用 `DSH_WSL_USER` 把会话直接跑成 root）。本插件没有任何设置能让密码提示变得可回答，也不跑探测去假装知道结论：sudoers 的授权是按命令给的，一句"这个用户有没有 NOPASSWD"对刚失败的那条命令而言就是猜测。**这只 shell 与宿主自己的 `bash` 工具所有不同之处都逐行列在 docs/bash-parity.md**（该表与兼容性证据同为英文），每行写明是谁的行为、用户会看到什么、以及判决；这张表被两枚闸读：`tests/wsl-bash-parity.test.ts` 拿装着的宿主包比对双方声明的参数与输出字段，`scripts/compatibility/bash-parity-real.mjs` 用同一份探针脚本在真发行版上把两个工具各问一遍、再逐字段对答案——于是"没写进台账的差异"与"写了但已消失的差异"都是构建红，而不是用户意外。
- **可敲键的终端（`wsl_terminal`）**：管道无法被敲键，所以会提问的程序——`sudo` 要密码、`ssh` 首次连接的指纹、REPL、编辑器、TUI——过去没有 agent 能给的答案：它被诊断、停下、改用一次性伪终端重跑，只为让模型读到程序自己的抱怨，剩下的只能由人接手。现在世界多挂了一扇 agent 能敲进去的门：`open` 开一个交互终端，`send` 打文字（默认回车，`submit: false` 只打字不回车），`read` 翻看保留的屏幕，`signal` 发 `SIGINT`/`SIGTERM`/`SIGKILL`/`SIGTSTP`/`SIGHUP`（`SIGINT` 就是 Ctrl-C），`close` 关闭，`list` 列出开着的。它就是宿主的 PTY 注册表与 `dsh-terminal-bash` 后端指向本插件的中继脚本——右栏终端标签背后那套机械，只是键盘换到了 agent 手上——而且它起的 shell 跑在**工作区配置的用户**下：宿主自己构造 PTY 子进程的环境、会把 `DSH_*` 全部丢掉，所以用户是从工作区存储里读回来的。其余一切仍走上面那枚管道 `bash`：管道给的是每个字节，终端屏幕只是 160 列渲染加有限滚动缓冲。三件事写在明处：后端的静默窗口从默认 3000 毫秒下调到 1200 毫秒（来源注在 `src/host/variants.ts`），于是宿主没认出提示符的那一发约 1.2–1.8 秒返回、而不是约 3.0–3.6 秒；一发 `send` 会说明自己落在哪一档，而不是把安静的屏幕说成提示符；敲进去的一切都会进对话记录，所以密码只能来自用户。真发行版实测（两档平面 × `root`/`ruler`，`bash-session-real` 66/66 格）：`open` 477–490 毫秒、打进去的命令有回答、**敲键能到达阻塞在 `/dev/tty` 上的程序**（`GOT=…`）、`submit: false` 只打字不执行而下一次回车执行它、`SIGINT` 结束 `sleep 30` 且 shell 存活、`close` 之后不留 `bash -i`。
- **可跟踪的后台任务**：`bash_background` 把一条命令放到后台并立刻返回注册表里的 job id，之后宿主的 `job_list` / `job_output`（增量读取、状态流转、完成通告）/ `job_kill` 都照常工作。之所以需要这一行：持久 shell 的 schema 只声明了 `command`，没有生产者时 `job_list` 永远回答"没有后台任务"，而传给 `bash` 的 `run_in_background: true` 会被**静默忽略**——参数 schema 不禁止额外属性，所以没有任何地方报错。这是真实会话里被发现的问题。该工具只在持久 shell 存在时挂载；保留一次性 bash 行的世界本来就有 `run_in_background`。
- **老宿主回退到一次性 shell**：持久 shell 是**宿主**的代码，而在 Windows 上它需要一个平台进程检查器，那个东西从 `0.1.0-rc.8` 才有——在 `0.1.0-rc.7` 里 `spawnTerminal` 会在启动任何进程之前抛 `subprocess-local: terminal inspection is unsupported on platform win32`，于是该版本里**每一次 `bash` 调用都直接失败**（不碰 PTY 的 grep/glob 仍正常）。因此插件在启动时**探测**底座而不是假设：它把一个不存在的程序交给 `spawnTerminal`，这只会走到检查器那一步、不会真的创建进程，报错信息就能说明是哪一半失败。答案是否时，生成的世界保留一次性的 `dsh-tool-bash` 行（走本插件自己的 `ctx.shell`，不经 PTY），模型得到的是一个能用的无状态 shell，而不是每次调用都报错。八个已声明版本里只有 `0.1.0-rc.7` 是这种状态，之后的版本都拿到持久 shell。
- `wsl.exe` 在发行版尚未启动时向 stderr 打印的 localhost 端口转发提示（乱码但无害）可忽略。

## 更新日志

完整版本历史（最新在前）已抽到单独的 [CHANGELOG.zh.md](CHANGELOG.zh.md)（英文：[CHANGELOG.md](CHANGELOG.md)）；本文只保留上面「行为与权限说明」的当前口径。

## 相关文档

各文档的位置、语言与口径见 [docs/README.md](docs/README.md)（英文索引）：[设计方案记录](docs/design.zh.md)、支撑 `dsh.compatibility.dshReleases` 声明的[逐版本兼容性证据](docs/compatibility-evidence.md)，以及已被取代、原文保留在 [docs/archive/](docs/archive/) 的历史结论。改动或发布前的验证步骤见 [TESTING.md](TESTING.md)。

## 许可与出处

MIT，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)，NOTICE 精确列明：

- **改编/继承源码**：DeepSeek Harness（MIT）的 `dsh-bash-local`（执行器机制）、`dsh-fs-local`（`WslFileSystem` 子类化）、shipped agent presets（变体生成读取/变换）；
- **设计参考（未复制源码）**：[dsh-bash-terminal](https://github.com/MAXeaglet/dsh-bash-terminal)（MIT，wsl argv/WSLENV 思路）、[dsh-side-panel](https://github.com/ccq1/dsh-side-panel)（BSD-3-Clause，Host 路由模式）、[vpshub](https://github.com/Sdongmaker/vpshub)（MIT，路线图参考）。

发布/再分发时请保留 LICENSE 与 NOTICE。

## 致谢

特别感谢 [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale)（DSH Web 鲸鱼娘皮肤系列 · 深海女仆工坊 maid-atelier，CC BY-NC-SA 4.0）：鲸鱼娘皮肤插件为 DeepSeek Harness Web 界面带来了一整套可爱的皮肤，让 DSH 的日常使用更有温度。

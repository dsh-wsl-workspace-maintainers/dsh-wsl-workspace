# 更新日志

`dsh-wsl-workspace` 的完整版本历史（最新在前）。返回 [README.zh.md](README.zh.md)；英文原文见 [CHANGELOG.md](CHANGELOG.md)。

本文件为中文记录（0.4.3 及更早为摘要）；英文原文见 [CHANGELOG.md](CHANGELOG.md)。

## 0.7.6 — 2026-10-01

- **DSH Desktop 0.2.x 上 WSL 工作区里每一次 `bash` 调用都失败（issue #51），修的是三件事。**
  (1) *shell 接缝*：0.2.x 走 `ctx.shell.execute(spec)` 再 await `result()`，本插件实现的是 0.1.x 的
  `resolve`/`run`/`start`——所以**常驻和回退两条路一起断**，不是一条。现在一份原语喂三个面，
  `onExpiry` 与 `observed` 补齐；一直放着它没管的闸门是 typecheck 的**错误计数预算**（那行 `TS2515`
  本来就在输出里），现在改成"禁用错误码出现即红"、自带哨兵，且基线只准下调（212 → 209）。
  (2) *就绪契约*：宿主把 `PS1`/`PROMPT_COMMAND` 作为 Windows 变量注入，而 WSL 不在 `WSLENV` 里具名
  就不会带进发行版，于是常驻 shell 用的是发行版默认提示符、宿主认不出来——中继里加一道桥即可，
  真 ConPTY 上验过（改前：默认提示符；改后：`prompt=[dsh> ]` 且带 `133;D;` 标记）；契约值现在与装着的
  宿主包做对照，不再手抄。(3) *持久 shell 本身*：宿主的 PTY 工具判定"跑完"的方式是在终端文本里找哨号行，
  并要求退出码后面紧跟换行；而交互式 Linux shell 用 `ESC[<n>X` 重绘，会把哨号之后的格子填成空格——
  在真实 Desktop 会话里量到**连续三次调用各挂 303.8 秒**，之后宿主把 shell 重置。现在这个世界挂的是本插件
  自己的 `bash`：一只长命的 `bash --norc -i`，**经管道**驱动，完成信号是带着本次调用独有 nonce 的 NUL
  分隔记录；登录环境静默 source、history expansion 关闭（顺带把 `!` 那一类失败在这条路上关掉）、被读到"正在等输入"的命令会拿到一只属于自己的伪终端（`script -qec`，由读进程决定而不是由命令名决定，
  `tty: true` 可一上来就要）、命令卡住时重建会话并回放 `cd` 与 export 的变量，而**只是跑得久**的命令不会被第二次执行。
  本机两档构建平面实测：
  首发含启动约 0.5 秒，其后**中位 8 毫秒**（2026-10-06 实测：答案不再等那份状态记录；同样一条命令走"每条起一次 `wsl.exe`"是 222-236 毫秒，人在开着的终端里敲是 16 毫秒），`cd`/`export`/退出码/中文/`!`/`sed -i`/`tar`/`git commit`/`sudo` 全部验证通过，而同一条命令走 PTY 那一档
  仍然超时——这个对照是新闸 `bash-session-real` 的最后一格，所以被换掉的行为不能悄悄回来。端到端是在**真宿主
  工具派发**上验的（宿主的 `bash` 工具调我们的执行器，见 `tool-bash-real`）；`DSH_WSL_PTY_SHELL=1` 保留旧档可挂载。
  **已把这个构建装进 DSH Desktop 点过**，点击查出两处离线闸门看不见的缺陷：宿主加载器会剥掉 `exports.default`，
  于是模块级 `inject` 到不了 fiber，每次调用都报 `cannot get property "subprocess" without inject`；shell 对帧的
  echo 只有**行尾**会到 stderr，于是每次调用的正文里都带着我们自己的协议字节。两处都已修，且都由"走产品真正用的那条通道"的新格子中住。

- **第二轮把这只会话 `bash` 修到与宿主的 `bash` 逐字段同形。** 34 行常见命令矩阵抓到四件"不像日常 bash"的行为，全部改掉：`run_in_background: true` 原本是被静默忽略的参数（现在转交 `bash_background` 用的同一枚生产者）；相对 `workdir` 原本解析成空、就在上一次调用留下的目录里跑（现在按会话目录拼接，目录不存在时让 bash 自己的 `cd` 报错，与宿主 `resolveWorkdir` 同形）；超过上限的输出原本只留一个布尔、头部丢掉（现在整条流入库，并写 `[output truncated; full output: …]`，文案与目录和一次性路径一致，且**每条命令一个文件**）；重建时脱离父进程的子命令会留下（现在按会话令牌精确收尸，另配一枚"必须活下来"的对照进程）。journal 除 `cd` 与 export 外还回放 `set`/`shopt`/别名/函数——**分帧回放**，因为 `eval` 会先把整串解析完再执行，第 50 行的 `shopt` 救不了第 1623 行需要 extglob 才能解析的补全函数（症状：重建报告成功、91 个 rc 函数回来了、用户两轮前定义的函数没了）。差异现在是一张被两枚闸读的表：`tests/wsl-bash-parity.test.ts` 对着装着的宿主包比参数与输出字段，`scripts/compatibility/bash-parity-real.mjs` 用同一份探针脚本在真发行版上把两个工具各问一遍再逐字段对答案——没写进台账的差异、或写了却已消失的差异，都是构建红（见 `docs/bash-parity.md`）。占用实测：每只会话约 9.1 MB Windows 工作集（两枚 `wsl.exe`）加发行版内 3.4 MB，`vmmem` 不随会话数变化，运行期在输出溢出前不落任何文件。

- **一只 agent 的 shell 现在随这只 agent 一起结束。** 会话 `bash` 原先只在插件作用域上登记清理，于是凡是调用过 `bash` 的 agent 都留下一只 shell——两枚 `wsl.exe`、约 9 MB Windows 工作集——直到整个世界被 dispose。发现它的格子正是用同一枚注册好的工具驱动第二只 agent，然后问"其中一只停下来会发生什么"。其余隔离边界本来就已成立、只是从没被测过：第二只 agent 不继承第一只的目录、export 与别名；同时发出的两次调用各自带回各自的答案；重建时的进程清扫只停携带本会话令牌的那些进程。`sudo` 现在也说明它缺什么——发行版要密码时，正文补一句"这只 shell 没人替它敲密码"并给出两条出路，而不是把 sudo 自己那行字留给模型重试。别名在定义它的那一行里被使用会返回 127，这与同一发行版上 `bash -ic` 的表现一字不差——量过，并记成 bash 的规矩而不是我们的缺陷。

- **伪终端这一档有三处接缝，是把它真开出来跑出来的，不是推出来的。** 不会上色的程序拿到终端时用"重打"表示强调，实测 `man` 一整页以 `N\bNA\bAM\bME\bE` 到达模型——人坐在真终端前读到的 `NAME` 在那里是乱码；折叠规则现在按终端自己的做法处理这台发行版**实测出现**的两种形状（`X\bX`、`_\bX`）。升级判定原先只读命令的第一个词，于是 `bash -c 'sudo true'`（模型非常爱写的形状）耗到期限、返回 `(no output)` 外加一次会话重建，而裸 `sudo true` 46 毫秒就答；现在会往里读一层 `bash`/`sh`/`zsh`/`dash` 的 `-c` 包装，读不动内容的包装就**不**升级，而不是猜一个。`tty: false` 原先什么都不做：只认 `true` 时，`man ls` 照样从伪终端回来，模型没有任何办法回到普通管道，现在 `false` 是否决。有两件事**没修**，因为它就是终端的样子：升级后的调用只有一条流，所以普通路径写的 `[stderr]` 段在那里不可能出现（宿主自己的 PTY 档同样——这条已进 `docs/bash-parity.md` 台账并配了探针）；而帧给伪终端的输入是 `/dev/null`，不能让程序去吃下一条命令的字节——这一点不但保留，还正是第二次尝试能让程序把自己的话讲完的原因。需要一块永远等不到的键盘的程序，现在由"读进程"那一档处理（见下面关于读数的那条），不再由程序的名字决定谁算等待。

- **等键盘的命令现在靠读发行版来诊断，不再靠对名字——它拿到的是答案，不是期限。** 这一档在本版本里走过的路是：
  一张首个词的白名单 → 三个"类别"（凭据 / 键盘 / 分页器）并给其中一类加 8 秒上限 → 全部删掉，换成在调用进行中
  从会话外面看第二眼。每一步都留在账上，因为每一步都是被一次测量逼出来的：白名单在连字符处停住，于是
  `ssh-copy-id`/`ssh-keygen`/`redis-cli` 永远匹配不上；只读第一个词在真会话里花掉 **121 703 毫秒**——模型发的就是
  `{"command":"printf x; vim note.txt","timeoutMs":15000}`，两分钟默认期限烧完，交给模型一屏原始转义；尊重调用写的
  期限在那种"永远等不到"的等待上一分钱也不省，因为 agent 不会把 16 889 毫秒的沉默读成"这个程序需要手指"，它读成
  "这个环境很慢"，然后拿这个结论去规划后面每一次调用——而 `tar -cf /dev/null /usr` 确实要 15 秒、`vim -es` 处理
  **100 万行** 只要 1 秒，所以任何"安静就是卡住"的规则都必须能把这两种分开。
  现在每次采样（200–280 毫秒、约 2 Hz、且只在静默 1.2 秒之后）读的是：进程状态、这个作业是不是终端的前台进程组、
  `/proc/<pid>/wchan`、它的描述符里有没有终端、以及它的 CPU 有没有在涨（`/proc/<pid>/schedstat`）。`sleep`、网络等待、
  正在编译的程序各被其中一列排除掉；"睡在终端读上"的程序排除不掉。于是先把它停下——先发 `SIGCONT`，因为被停住的进程
  会无视 `SIGTERM`——再在**同一次调用里**用属于它自己的伪终端重跑一遍；在那里那次键盘读会撞上文件尾，程序把自己的话讲完。
  真会话实测（`D:\Temp\issue51-s0\v5-run.txt`）：`sh -c 'read x < /dev/tty'`——程序名是 `sh`，过去任何一份名单里都没有它——
  628 毫秒被停下、1 760 毫秒答话；同样安静的 `sleep 4` 一步没被碰；要密码的 `sudo`（它清掉 dumpable 标志，因此把
  `/proc` 条目藏起来）改由发行版 root 权限读同一枚探针（只读 `/proc`、每次调用最多跑一遍，root 不可用的发行版退回"无法确认"那一档并如实说明），2 412 毫秒带回 sudo 自己的话；一条为键盘等待写了
  60 000 毫秒期限的调用 1 733 毫秒就返回了。两件事是说出来而不是悄悄做掉的：**这条命令已经跑了两次**（"它在提示之前
  已经做过的事情，现在做了两遍"），因为不声明的第二次执行正是本票早前抓到过的那类缺陷；以及如果那趟 `/proc` 行走
  一次都没回答，正文会写"这项检查没能运行"，而不是留下一段没有理由的期限——消失的前提不许伪装成一个结论。
  `tty: true` 一上来就要终端，`tty: false` 否决第二次尝试；分页器与实时画面那些类别名单原本要编码的行为，就是管道
  自己的样子（`man` 吐出整页、`top: failed tty get` 687 毫秒拒画），哪句症状属于哪一层写在
  [docs/tty-triage.md](docs/tty-triage.md)（该件为英文）。

- **重复失败会被点名，但仍然照跑。** 同一串命令字节在同一只 shell 里第二次失败时，正文加
  `[this exact command has failed 2 times in this shell with nothing succeeding in it since: …]`，
  而**任何**一次成功都会清空全部计数——那句话讲的是"这之后什么都没成过"的 shell，所以两次 `npm test`
  之间夹一次成功的 `npm install` 不能被说成死循环。**故意不做拒绝**：一个"不执行被告知的命令"的工具正是这张 ticket 要修的形态，而最常见的
  第三种情形——装完依赖后 `npm test` 第三次通过——恰好是拒绝会打断的那个。

- **`sudo` 那句说明把"人"排在第一条出路。** 产品在右栏有面向人的交互终端标签
  （`dsh-client-ui-sidebar-terminal`，走宿主自己的 PTY，本插件不碰），人在那里能正常输密码；
  配 NOPASSWD / `DSH_WSL_USER=root` 退居第二条，含义是"让 agent 能自己跑"而不是"先救现场"。

- **"这条命令在等一次没人敲的键盘"这句说明只看读数，不看"上限是不是我们施加的"。** 装机桌面端第一发真会话并没有发
  `vim note.txt`，模型发的是 `{"command":"printf x; vim note.txt","timeoutMs":15000}` —— 它自己写了期限，而旧规则下
  "调用自己写了期限"就换不到那句解法，只拿到一句通用说明。现在说明挂在"看见了什么"上：调用写多长的期限都不改变
  它是不是一场等键盘的等待。第二格让超时文案自己互相对账：只有会话真的重建过时才允许声称"已重启"，而那一格的实测是——
  `tty: true` 的 `sleep` 超时确实会重建会话。

- **常用命令清单是真跑进了一枚真 dsh 会话，121 703 毫秒就是这么抓到的。** 真 DSH 0.2.0-rc.2 实例（自己的
  `DSH_HOME`、自己的端口、本地脚本化提供方，因此没有买任何一次推理）：27 行日常命令，读数取自这枚会话自己的落盘
  日志，而不是需要谁转述的界面。多数行按设计答——要密码的 `sudo` 带回它自己的判断和那句说明、分页器 73 毫秒出内容、
  `man`/`less` 吐出整份文档。两行没答对：上面那条"前面加个 `printf` 的编辑器"，以及一格把期望写在了错的介质上。
  同一趟还抓到工具说明里一句假承诺：实时画面在管道上并不吐出文档，它是直接拒画（实测 `top: failed tty get`，退出码
  1，687 毫秒），所以说明现在照实写，并让模型去要 `top -bn1`。

- **一个本工具没预料到的失败现在会自己报是哪一层。** 走了伪终端、又不落在已知形状（要密码、要按键）里就收尾失败的调用，会补一行
  `[this call ran on a pseudo-terminal (script -qec, one stream): re-run the same command with "tty": false to rule this layer out before looking anywhere else]`，
  同一个决策还以 debug 级写进宿主日志（`wsl-bash: pseudo-terminal for class=… deadline=…ms`），使 `dsh web`/`headless`
  的日志也能回答"这发是不是 pty"（装机桌面端把子进程 stdout 只留在内存，所以那一档可读的一半仍是转录正文）。哪种症状属于哪一层的对照表（含宿主 PTY 档自己的哨号——issue #51 最初就是冲着它提的）在
  [docs/tty-triage.md](docs/tty-triage.md)，那张表点名的每一行都由 `bash-session-real` 的一格钉住（现在 47 格，两档平面都跑）。

- **一个真模型跑出了我们的格子没能覆盖的形状：读终端的 *builtin* 卡住的是 shell 自己。** 用真凭据被真模型端到端驱动时（四条命令全部由模型自己选），它写的是 `read -r line < /dev/tty`，而本仓所有格子写的都是 `sh -c …`：子进程阻塞能被"走后代"找到，*builtin* 没有子进程，于是一个都没分类到、那一发挂满 30 秒期限且没有说明（模型自己在总结里点出了这一点）。实测那一刻 shell 自己的行是 `Ss+ pgid==tpgid wchan=wait_woken fd0=/dev/tty` 且 CPU 不涨——同一枚签名，只高了一层——所以 shell 现在也在走路列表里，并带标记（命令之间的它在管道上等待，不能当成"在等键盘"）。解放它靠的是测量而不是想当然：`kill -INT` **不生效**（bash 接住信号后 read 系统调用被重启，实测信号已送达而调用仍跑到期限），所以它和任何卡死的进程一样被停掉、会话按 journal 重建、再由同一条重试路径把命令放到终端上重跑。同一句提示的第二趟：那一发 **3 104 毫秒**回来，正文 `read-exit=1 x=''` 加"第一次是靠重启 shell 结束的"那句说明，模型的收尾总结原文引用了它。落地过程中又被格子咬出三处缺陷：停机集合原本点名了样本里的每一行（样本现在永远包含 shell）、特权那一档的停机集合取自读不到的用户面行而不是 root 面见证的、以及被看门狗停掉的一发被报成了"调用方取消"——后者让真机闸把自己的这一轮中止了。

- **终端由一次读数给出，不由名单给出，而且第二次尝试会声明。** 三集合（凭据、键盘、分页器）曾经决定一发调用要不要伪终端、以及它被允许等多久，现在它们全部不存在：这一档的维护成本来自它们，两处真缺陷也来自它们，任何一枚发行版都可以和它们意见不同，而它们替我们"提前判断"的那件事本来就可以直接观测。替代它们的是一个函数（`src/host/wsl-bash-starve.ts`）在调用进行中从会话外面读发行版，外加一次"停下并重跑"。每一枚阈值背后的测量、三种读数各自能说什么、以及调用方可用的门，都写在上面那条读数条目里和 [docs/tty-triage.md](docs/tty-triage.md)（该件为英文）。


- **DSH Desktop 上一个 WSL 变体都生成不出来（issue #47）**。生成器在调用时向宿主借两样东西：条目清单的方言，和解析它的 YAML 引擎；前提写的是"宿主和插件共用一棵 `node_modules`"。Desktop 把宿主打在归档包里，而 Node 找裸包名是沿文件系统一层层往上走，这条路永远走不到宿主里面。于是第一个健康的源预设就抛错，抛出循环，循环之后的一切——包括对已退役机制残留物的清扫——一起被跳过。界面上只剩"未找到健康的 wsl preset"这一句，原因躺在宿主控制台里被 `catch` 吞掉。这一条在本机用**真包**复现，不是推断：按伞形依赖提升的那个版本建好方言、再经兄弟插件提升的那个版本去加载，会失败在加载器内部，报出的话既没有包名也没有版本和路径。
- **方言现在由插件自己构建**（`src/index.ts`），并且和 `load()` 出自同一个引擎命名空间，规则与引擎不可能再分属两个大版本。那份对外导出的 schema 我们只用得到"读"的一半，另一半服务的是本插件不走的那条写出路径。六行，不新增依赖。
- **引擎改成本包的正式依赖**（`js-yaml: ^4.1.0`，解析到 4.3.2，正是宿主伞形包自己提升的那个版本）。把它声明成可选同伴依赖、范围写 `*`，等于把版本决定权交给 profile 里恰好躺着哪一个；而 `autoInstallPeers` 关闭时，可选同伴依赖根本不会被安装。同一个 profile 里照常工作的那个兄弟插件，恰恰是因为它声明的是正式依赖——现在两边形状一致。已经没人 import 的两条 peer 声明一并删除，清单不再描述一段不存在的引用。
- **一个源失败只算它自己那一个变体的失败**。生成改成逐源容错，退役目录的清扫无条件执行，并把结果作为一行计数写出来——`WSL preset variants: n/m registered`——因为"路由能答"从来证明不了"生成了东西"。这行在 `dsh web` 上进启动日志、兼容矩阵已把它当成判据；**在 Desktop 上它不落任何地方**：实机量到宿主日志目录里只有 crash 包，而那些包只收渲染进程的 console 与非零退出的子进程 stderr，主进程的 `console.error` 没有落点。所以"把失败原因显示到界面上"（报告者的建议 #3）从"锦上添花"改判成单独一票，依据是量出来的，不是审美。改之前还有一处是靠事故成立的：源目录中途消失时，上一次完整发布的变体之所以还在，是因为中断让那趟清扫没跑；现在契约保留，事故拿走，`tests/host-materialize.mjs` 在第一跑就把这个差别咬了出来。
- **方言相关的失败会报出它实际站在哪一份上**——包名、版本和路径。版本这件事由用户机器上的安装器决定；那一格后来用真安装器量过了（见下条），但失败文案仍然自报包名、版本与路径，好让在别种安装器上出问题时日志本身就带得走结论。
- **新增闸门** `tests/host-profile-isolation.mjs`（`npm run test:profile`）：在临时目录里搭出与真实 profile 同形状的树，逐臂启动插件自己那份拷贝——借来的 schema 不在、提升到的引擎是错的大版本、两者同时、以及健康源里夹一个读不到的源。它的对照臂、对照伞形包里钉住的那份宿主 schema 做的方言等价校验，以及"声明里每条 provider 路径都能真的被 import"的探针，与它写出来就该亮的八枚红**出现在同一帧**；对修复做的三次变异彩排各自拧红的是不同的子集，这正是把两个缺陷分开报的依据。`ci/install-pinned.mjs` 额外物化第二棵树放那个敌对版本，且**永不**链进仓根。
- **两道旧闸门问错了问题**。`scripts/verify-install.mjs` 现在还断言装好之后的运行面：每条正式依赖都要从安装位置的 `lib/` 可达、且在声明的那条版本线上；`dependencies` 为空本身就是拒绝——它以前的绿是"引擎缺席"这件事**造出来的**，而那正是本 issue 报告的形态。`scripts/verify-dsh-compat.sh` 对矩阵里每个版本断言那行计数：少于可供的源数判 `VARIANTS_FAIL`，行没出现或 `0/0` 判 `VARIANTS_NOT_VERIFIED`，不许算通过。
- **本机定得了的和确实定不了的**：用真 pnpm、`nodeLinker: hoisted`、`autoInstallPeers: false`（报告者环境表里那套设置）量过了——已发布的 0.7.5 装进"兄弟插件把 `js-yaml` 顶到 5.x"的 profile 树里，生成数为零；本构建在同一形状里拿到属于自己的那份引擎嵌套，并把交给它的源全部注册出来。同一对随后在这台机器**自己那份 Desktop profile 的形状**里又跑了一遍，结果发现真件就在这台机器上：`C:\Users\<机主>\AppData\Local\Programs\DeepSeek Harness` 是装着的，`.dsh/profiles/desktop` 里是 0.7.5、用的正是那两个设置、它的上溯路径上既没有引擎也没有 include 包——报告里那份"缺料"一直摆在维护机自己的目录里。**仍未测到的是宿主进程本身**：读那个 profile 零成本，而在机主正在用的机器上起一个 GUI 加它的自动更新器不是，那一格等点头再走。报告者那行宿主控制台输出也不再是能让他去 grep 的东西——健康的 Desktop 启动不落宿主 stdout（见上条），所以那条判据只有带 shell 的维护者侧取得到；回帖改成请他报**能观测的那件**：升级后对话框里有没有 `WSL · *`。限度与支撑它的帧都写在 `docs/compatibility-evidence.md`，没有折成覆盖。
- **WSL 会话里的文件引用又能预览了（issue #49）**。会话里的文件链接、工具行的行号引用、回合末尾的「已改动文件」都走右侧栏的导航控制器，而地址里带的是模型原样写下的 **Linux 路径**；宿主用 `node:path.resolve(cwd, path)` 解析它，POSIX 绝对路径在 Windows 上是「当前盘根目录下的相对路径」——`/mnt/d/x` 落到工作区所在的盘（`D:\mnt\d\x`），发行版内的路径落到 cwd 共享的根下，而 UNC cwd 下的 `/mnt/<盘符>` 引用会变成 `\\wsl.localhost\<发行版>\mnt\<盘符>\…`，9P 对它报 `EPERM`。修复前在真 DSH Desktop 上两种注册方式都复现到了：`write` 工具刚写成功的文件点开显示「文件不存在，可能已被移动或删除」，UNC 工作区里同类引用显示 `EPERM`。
- **修复落在客户端半边，因为宿主平面没有插件能用的钩子**：`fs` 与 `workspaceFiles` 属于别的插件，cordis 不允许第二个 `provide` 抢别人 fiber 持有的名字，两边也都没有发布路径解析的缝。客户端半边在地址交给侧栏之前翻译——`/mnt/<盘符>/…` 换回 `X:\…`，其余 Linux 路径走该发行版的 UNC 共享——挂在 `openResource` / `openResourceIn` 这个所有引用入口都经过的地方，于是 tab 的内容与同一地址下的元数据一并修好；落在工作区内的翻译结果会变成与文件面板一致的相对地址，所以是揭示已打开的 tab 而不是多开。
- 新增宿主路由 `listWorkspaceRecords`（客户端会缓存）：发行版内的路径需要知道发行版，UNC 工作区自带，`/mnt/<盘符>` 工作区只在 `wsl-workspaces.json` 里有。`host-api.mjs` 覆盖它，探针地板从 12 抬到 13。
- 地址语法是**镜像**的而不是 import 的——十一个已声明版本里有六个不带 `@deepseek-ai/dsh-util-workspace-path`、或带了却没有这套语法——只要那个包能被解析到，就有一条单测把镜像与它逐字节对齐。逐字节重建不出来、发行版未知、或插件不认定为 WSL 会话的地址，一律原样透传，不做猜测。
- 只有 `0.1.5-rc.1` 及以后才有右侧栏、文档预览与资源模型；六个更早的已声明版本没有可修的引用面，钩子不安装。
- 本条目的实测依据：十一个已声明版本在 harness 上 14/16（与既有两项基线相同）、`host-api` 在真 0.2.0-rc.2 前端上 13/13、真实浏览器里在 `0.1.5-rc.1` / `0.1.5-rc.2` / `0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.2` 上端到端点开引用，以及真 DSH Desktop 上四种组合（盘符与 UNC 工作区 × `/mnt/<盘符>` 与发行版内路径）。
- **agent 现在能在一个属于自己的终端里敲键**（`wsl_terminal`，issue #51 的最后一块缺口）。管道无法被敲键，所以凡是会提问的程序——`sudo` 要密码、`ssh` 首次连接的指纹、REPL、编辑器、TUI——都只能被诊断、停下、改用一次性伪终端重跑，让模型读到程序自己的抱怨，剩下的由人接手；而本票的合同是**人能跑的，agent 都要能跑到**，于是这一类补上了一扇门。这个工具是宿主自己的 PTY 注册表与 `dsh-terminal-bash` 后端（指向本插件的中继）之上的模型面形状——没有任何新的伪终端机械，与右栏终端标签背后那套完全同一——动作为 `open`/`send`/`read`/`signal`/`close`/`list`，挂在管道 `bash` 旁边（管道仍是默认：它给的是每个字节，终端屏幕只是 160 列渲染加有限滚动缓冲）。有两个事实是读宿主代码才拿对的：shell 跑在**工作区配置的用户**下——宿主自己构造 PTY 子进程的环境、会把 `DSH_*` 全部丢掉，所以中继改从工作区存储里读回来（同一个修法也补给了会话 `bash`：它此前只从环境解析用户）；后端的静默窗口从默认 3000 毫秒下调到 1200 毫秒（来源注在 `src/host/variants.ts`），于是宿主没认出提示符的那一发约 1.2–1.8 秒返回、而不是约 3.0–3.6 秒——一发 `send` 会说明自己落在哪一档，而不是把安静的屏幕说成提示符。真发行版、两档平面、`root` 与 `ruler` 实测：`bash-session-real` 现在带着这扇门自己的格（66/66），其中包含**敲键能到达阻塞在 `/dev/tty` 上的程序**（`GOT=…`）、`submit: false` 只打字不执行而下一次回车执行、`SIGINT` 结束 `sleep 30` 且 shell 存活、`close` 之后不留 `bash -i`——`open` 实测 477–490 毫秒。顺带发现：`tests/host-profile-isolation.mjs` 只在 Windows 上红（它把一条启动**诊断**当成失败，于是那两个「健康帧不说话」的格在 CI 上绿、在本插件真正面向的平台上红）；这两格现在把诊断与失败分开，并写明了原因。

## 0.7.5 — 2026-09-30

- **DSH Desktop 上持久 shell 又能用了（issue #40）**。Desktop 的宿主进程**本身就是**打包后的 Electron 可执行文件、以 node 模式运行（`ELECTRON_RUN_AS_NODE=1`；Desktop 自己的代码是 `new DesktopHostProcess(resources.node, …)`，而 `resources.node = process.execPath`），插件却把 PTY 后端的 `shellPath` 指向 `process.execPath`、`shellArgs[0]` 指向 `lib/wsl-relay.js`。Electron 二进制在 **ConPTY** 下不输出任何字节：中继的 `wsl.exe` 子进程继承到一条死流，中继 0 字节退出 0，后端的就绪探测永远看不到提示符，于是**每一次** `bash` 都以 `PTY shell exited during startup` 失败；而 `0.1.0-rc.7` 那条一次性 bash 回退路径不受影响，故障正好被一个能用的模式盖住了。用宿主自己的 node-pty 实测：同一份中继、同一个 `\\wsl.localhost\…` cwd、同一份环境，真 node 给出 bash 提示符，Electron 是 0 字节并干净退出。
- **中继的解释器改为显式解析**（`src/shared/relay-node.ts`）：先取 Desktop 传给宿主进程的 runtime payload 路径（`process.argv` 里的 `…/resources/runtime/primary-runtime`，那份 payload 里带着它自带的真 node），再退到可执行文件旁的同一路径（macOS 包内是 `Contents/Resources/…`）、`DSH_DESKTOP_NODE_EXECUTABLE`、`PATH` 上的 `node`，最后才回到 `process.execPath`。每个候选都要被**问一次"你到底是什么"**（`-e` 打印 `process.versions.electron`）：只看 `--version` 分不出来——继承 `ELECTRON_RUN_AS_NODE` 时 Electron 回答的是 node 版本号（实测 `v24.18.1`），任何 `^v\d+\.\d+\.\d+` 判断都会选中那个坏的。非 Electron 宿主（`dsh web`）直接返回 `process.execPath`、不启动任何探测进程，行为与 0.7.4 完全一致；Desktop 上则把选中的解释器与被拒绝的候选写进启动日志。
- 同方向的 PR #39 诊断是对的（根因确实是 Electron 解释器），但它的候选链第 1 项 `DSH_DESKTOP_NODE_EXECUTABLE` **指向的就是 Electron 可执行文件**——Desktop 自己的 `resources/runtime/bin/node.cmd` 就是 `set ELECTRON_RUN_AS_NODE=1` 后运行这个变量——而它的 `--version` 校验分不出两者。本修复采用同样的方向，但把 payload 路径放在最前，并用真正的判别器把 Electron 挡掉。
- `tests/relay-node.test.mjs`：候选推导（argv / 可执行文件旁 / 环境变量，含去重与排序）与"是不是 Electron"的判定，包括 `--version` 那种形似版本号、但必须被拒的输出。
- `scripts/compatibility/conpty-relay.mjs`：**新的常驻门禁**——在真实 ConPTY 下用宿主自己的 node-pty 跑中继，要求解析出的解释器给出活的 bash 提示符。这正是 #40 破坏的那条不变量，此前没有任何检查覆盖它。它注册进 `Run-Checks.ps1` 与 harness，每个已声明版本都跑。
- **顺带修掉了 issue #40 里的第二个报错**：`bash_background` 交给 jobs 注册表的 `owner` 形状不对，在 `0.1.7` 及以后每次都报 `session "[object Object]" has no live agent`。实测这条契约**在 `0.1.7-rc.1` 变过**：之前 `start()` 收 agent 对象本身（注册表读 `owner.id` 与 `owner.ctx`），之后收**会话 id**（用 `agents.get(id)` 解析）——宿主自己的生产者也是同时从 `owner: parent` 改成 `owner: parent.id`。现在按注册表是否提供 `resolveOwner` 选择该传哪种形状；`tests/wsl-jobs.test.ts` 原本把错误的那一半当成正确行为断言了下来，现在两种契约都钉住了，十一个已声明版本也逐一实测过。
- `dsh.compatibility.dshReleases` 增加 `0.2.0-rc.2`（DSH Desktop 0.2.0-rc.2 自带的 DSH 版本），这份构建声明的版本从十个变成十一个；README 也新增「兼容性」一节列出这十一个版本，并有单测保证它和 `package.json` 的声明不会各说各话。
- **顺带修掉了 issue #40 里的第二个报错**：`bash_background` 把 agent 对象当成 job 的 owner 交给 jobs 注册表，而注册表要的是**会话 id**——它用 `ctx.agents.get(owner)` 去找活着的 agent，拿到对象必然找不到，于是每次都报 `session "[object Object]" has no live agent`（宿主自己的生产者传的是 `agent.id`）。`tests/wsl-jobs.test.ts` 原本把这个错误契约当成正确行为断言了下来，现在改成断言会话 id。
- **验证**：十一个已声明版本各跑十六项 harness 检查（一律 14/16，两项失败是既有基线：`typecheck`，以及需要**运行中前端**的 `host-api`——对着真实实例单独跑是 12/12）；十一个版本各跑一遍 runbook 的六项前端验收（发行版下拉、创建并打开、写、读、一次性/持久 bash、skills、前端重开），`web.err` 全为 0 字节，文件在 Linux 侧独立复核。
- **另外在真的 DSH Desktop 里跑了完整一遍**（把官方安装包解包后直接启动那个 Electron 应用，用 CDP 驱动窗口，并走桌面版自己的插件面板安装/启用插件，`DSH_HOME` 指向隔离目录）：装 **0.7.4** 时 `bash` 每次都报 `PTY shell exited during startup`、`bash_background` 报 `session "[object Object]" has no live agent`，而对话框、发行版列表、技能都正常；换成 **0.7.5** 后 `bash` 返回 `6.18.33.2-microsoft-standard-WSL2` / `/home/mille/fx-3381` / `mille`，第二次独立 `pwd` 仍是 `/tmp`（持久性成立），`bash_background` 返回 `bash-1`、`job_list` 报 `bash-1 [bash] running`、`bg.txt` 里确实是 `BG_3381_OK`，刷新窗口后工作区仍能重开；启动日志里是 `persistent shell: relay interpreter is …\runtime\primary-runtime\dependencies\node\bin\node.exe — node 24.21.0 from the runtime payload named in argv`。完整过程记在 `docs/compatibility-evidence.md`。

## 0.7.4 — 2026-09-28

- **在 DSH Desktop 上对话框又能用了（issue #35、#36）**。Desktop 宿主会在插件加载**之前**包装 `child_process`：它装上普通的 `exec`/`execFile` 包装函数，再用 `syncBuiltinESMExports()` 把它们回写到内建模块。这份 `execFile` 上没有 `util.promisify.custom`，于是 `promisify(execFile)` 退回通用实现——它只用回调的**第一个**参数 resolve，也就是 stdout 字符串——结果每次调用拿到的 `result.stdout` 都是 `undefined`。发行版查询去读 `.stdout`，抛出 `Cannot read properties of undefined (reading 'includes')`，前端把它吞掉、渲染出一个空的发行版列表：对话框能打开、下拉框里却一个发行版都没有，「创建并打开」走不完；而同一台机器上 `wsl.exe -l -q` 在终端里列得好好的。三处调用现在都改用 `execFile` 的**回调**形式，任何包装都改不了这个签名。
- **`wsl.exe` 的查找改成候选列表**。先试 `PATH` 上的 `wsl.exe`，再试绝对路径 `%SystemRoot%\System32\wsl.exe`；查找失败时报出它试过的每一个候选以及各自的原因，而不是从解码器里冒出一个类型错误。
- 新增 `tests/exec-shape.mjs`：它复刻 Desktop 的包装方式（普通包装 + `syncBuiltinESMExports()`），分别带与不带 `--import` 起一个探针进程，断言被包装的形态确实是坏的、新助手是对的，并把真实的 `listDistros`/`defaultDistro`/`resolveLinuxSymlink` 在两种形态下各跑一遍。它注册为 `scripts/compatibility/Run-Checks.ps1` 里的 `exec-shape` 检查，避免以后有人又把它改回 promisify 写法。
- `dsh.compatibility.dshReleases` 也声明了 `0.1.7-rc.2`，这份构建声明的版本从九个变成十个。
- **验证**：十个已声明版本各跑十五项 harness 检查（一律 13/15，两项失败是既有基线：`typecheck`，以及需要**运行中前端**的 `host-api`——对着真实实例单独跑是 12/12）；十个版本各跑一遍 runbook 的六项前端验收（发行版下拉、创建并打开、写、读、一次性 bash、持久 bash、skills），`web.err` 全为 0 字节，文件在 Linux 侧独立复核。Desktop 包装的复现过程、pack 一致性哈希与纯 npm 安装门禁都记在 `docs/compatibility-evidence.md`。

## 0.7.3 — 2026-09-23

- **插件在 DSH `0.1.7-rc.1` 上重新可加载，模式也回来了**。`0.1.7` 这条线改了宿主预设接口——`read()` 变为 `readDocument()`，返回的是文档（`{agentPreset, content, name, description}`）而不是组合文本，且 `AgentPreset` 不再有 `path`——于是变体生成器每次启动都抛 `agentPresets.read is not a function`，选择器里一个 `wsl-*` 模式都不会出现。现在改按**能力探测** roster 接口，两代都服务：有 `readDocument()` 就用它，否则回退 `read()`。
- **在这条线上，变体是一条声明行**。`0.1.7` 不再扫描 `$DSH_HOME/.agent-presets/`——那里的预设是一条声明式的 `@deepseek-ai/dsh-agent-preset` 行，而插件原先写变体的那个目录已经**没有任何代码会读**。生成器现在把组合好的变体展开回 entry list，通过 `ctx.agentPresets.register()` 发布；注销器由插件的 effect 持有，因此卸载或热重载会注销这些变体，而不是留下下一次 apply 无法替换的孤儿（`Duplicate agent preset: wsl-<mode>`）。更早的版本仍走原来的目录通道，行为不变。
- **该通道下，世界自己的提供者要以 `file:` URL 命名**。由声明挂载的预设由注册表自己的 entry tree 导入，而它——与启动期的 Include 不同——不会把绝对路径翻译成 `file:` URL。没有这层改写时那些提供者行根本不会启动，审计会逐条报 `never started`，整个变体被判为不可用而拒绝。
- **`0.1.7` 上 PTC 变体重新有名字了**。给已发布模式拼双语 `WSL · …` 名字的那张表里，PTC 这个模式只登记了旧 id（`code`），没有 `0.1.1` 起在用的 `ptc`。只要版本自己发布了显示名就看不出来——查不到会落到那个名字上——但 `0.1.7` 根本不发布显示名，于是模式以 `WSL · ptc` 和通用描述 `WSL execution world for ptc: …` 进了选择器。现在两个 id 都登记了，变体在各条通道上都显示为 `WSL · PTC mode（PTC 模式）`，与其余三个已发布模式一致。
- `dsh.compatibility.dshReleases` 增加 `0.1.7-rc.1`。声明通道需要的两个模块（`@deepseek-ai/cordis-plugin-include`、`js-yaml`）在调用时动态解析，并声明为**可选**同伴依赖：万一某个版本没有它们，只让一个变体失败，而不是让整个插件无法加载。

## 0.7.2 — 2026-09-21

- **WSL 技能目录不再在请求路径上重走（issue #25）**。宿主会在请求期间重建技能目录并等待每个 provider 的 `list()`，而本插件只把答案保留 10 秒——于是每次重新收集（新会话、新作用域，或距上次查询超过 10 秒）都会让那个请求付一次整棵工作区的走查，而且是逐个目录：每目录两次 `stat` 加一次 `readdir`。本机 `\\wsl.localhost\…` 9P 共享的单次 `readdir` 实测 3~16 毫秒，走查预算固定 4096 个目录，所以大工作区那次走查是 20.4 秒、并且付在请求路径上。现在已发布的目录直接照原样返回，只有插件自己的变更探针能丢弃它：重复查找 1~3 毫秒、完全不碰文件系统。新鲜度契约不变——新增的嵌套技能目录仍在 30 秒内出现，新增、删除或改写技能仍在 3 秒内生效。
- 走查本身也变便宜了：BFS 同一层并发探测（有上限）、按 frontier 顺序发布以保证目录顺序确定，且只在目录自身的清单里出现 `.dsh` / `.agents` 时才探测对应 `skills`。同机实测命中预算的走查从 20.4 秒降到 4.8 秒；真正的并行度由 node 的文件系统线程池决定。

## 0.7.1 — 2026-09-20

- **`npm install dsh-wsl-workspace` 不再失败**。校验已发布产物时发现了这次发布自己引入的回归：npm 会自动安装缺失的同伴依赖，而 0.6.0 新加的 `@deepseek-ai/dsh-tool-fs-search` 同伴自己又依赖 `@deepseek-ai/dsh-retention`，后者**并未公开发布**——于是纯 `npm install` 直接以 `E404 … @deepseek-ai/dsh-retention` 失败（0.4.3 装得没问题，所以是我们引入的）。`dsh plugin add` 走 pnpm，对未满足的同伴依赖**只警告**，这正是所有门禁与真实安装都没抓到的原因。十个宿主同伴依赖现在都在 `peerDependenciesMeta` 里标为 optional：包仍然声明宿主必须提供什么，但 npm 不再尝试去下载它们。

## 0.7.0 — 2026-09-20

WSL 世界现在在"会话能察觉到的每一处"都与宿主一致，最后两条已知问题也关掉了。以下内容一起发布：WSL 变体拿到 Linux 符号链接、会话的访问模式、发行版内的搜索、实时的技能目录、有状态的 shell，以及可跟踪的后台任务。

- **把宿主 `bash` 的契约写进工具描述**：持久工具把每条命令包成 `eval -- $'…'`，所以命令以 `&` 结尾会把**整条**包装命令后台化——调用立刻返回 exit code 0、没有输出，真正的输出晚到，甚至落进下一次调用的输出里；而整轮会话只有这一只 shell，`cd` 会带到下一次调用。宿主默认描述两条都没提，DSH 自己的极简模式还建议危险写法（`sleep 10 &`）。世界现在覆盖 `description`（八个已声明版本都支持这个键），写明这两点与安全写法。
- **`0.1.0-rc.7` 回退到能用的无状态 shell**：那个版本的 `dsh-subprocess-local` 没有 Windows 进程检查器，宿主的 PTY 持久 shell 在 Windows 上根本起不来——每次 `bash` 都报 `subprocess-local: terminal inspection is unsupported on platform win32`（宿主自己也有这个缺口：它那个版本的极简模式挂 `persistent-bash` 时没有 Windows 守卫）。插件改为在启动时**探测**底座——把一个不存在的程序交给 `spawnTerminal`，只会走到检查器那一步——答案是否就保留一次性的 `dsh-tool-bash` 行：一个能用的无状态 shell，而不是每次调用都报错。
- **可跟踪的后台任务回来了**：用持久 shell 取代一次性 bash 工具时，也把唯一会启动注册表任务的东西去掉了，于是 `job_list` 永远回答"没有后台任务"，而传给 `bash` 的 `run_in_background: true` 被静默忽略（参数 schema 允许额外属性，没人报错）。世界现在挂 `bash_background`（`src/host/wsl-jobs.ts`），一个架在宿主 `ctx.jobs.start` 与本插件 `ctx.shell.start` 之上的薄生产者：返回 job id，`job_list`/`job_output`/`job_kill` 照常工作。只在源模式本身挂了 `job_*` 工具、且持久 shell 存在时才挂载。
- **按最坏输入复查新代码抓到六个缺陷**：显式点名的隐藏文件被守卫排掉（`grep path=.env` 返回 0 条）、`find` 退出码被丢弃（`glob path=/nope-missing` 看起来像空目录）、glob 头部按行结尾（名字含换行的根被截断）、Windows 路径没翻译（`grep path='D:\proj'` 失败而 `read` 能读）、落盘 schema 闭合（会让每次"超限且有落盘后端"的调用在返回时校验失败）、技能变更探测会叠加慢 pass。外加新生产者里的两个：它曾被挂在没有 `job_*` 工具的模式里、并且把任务的工作目录默认成了宿主进程而不是会话工作区。
- **验证**：八个已声明版本（`0.1.0-rc.7` … `0.1.5-rc.2`）各跑十三项门禁，`search-real` 用真实发行版夹具驱动真实工具，只剩既有的两项基线失败（`typecheck` 与需要在线服务的 `host-api`）。152 例单测，含"每个渲染器与宿主套件自己的格式化函数逐字节对比"的平价检查。五个版本的浏览器真实会话覆盖工具行为，另外**八个版本全部做了前端验证**（入口按钮、对话框、路径检查、创建并打开、模式选择器、含 v0.7.0 与 8 个版本标签的帮助面板），并以会话日志为证据覆盖工具集、搜索结果、目录替换、shell 回退与后台任务生命周期。

## 0.6.0 — 2026-09-19

- **WSL 会话补上了 `grep` 与 `glob`**：宿主的搜索套件跑的是打包的 Windows ripgrep，而模型给的路径全是 Linux 路径，于是生成的世界干脆丢掉了 `tool-fs-search`，让模型自己在 shell 里搜——这正是面板已知问题里的最后一条。现在世界挂上发行版内的同类实现，并保留宿主套件的契约：同样的工具名、参数 schema、条数上限（250 条命中 / 100 个路径）、输出 schema、`Line N:` 分组、命中数表头、超限尾部提示、搜索卡片与超限结果落盘；渲染直接调用 `@deepseek-ai/dsh-tool-fs-search` 自己导出的格式化函数，只有该包未导出的两处投影（卡片元数据与 glob 分页）在本插件里复刻，并有单测与它逐字节对比。`grep` 在发行版内跑 GNU grep（`-rnIEH -Z`、POSIX ERE、像 ripgrep 默认那样跳过隐藏项与 `node_modules`、不读 `.gitignore`），`glob` 用 GNU `find` 列文件并在插件内按 gitignore 风格匹配、按 ripgrep 的"最旧优先"修改时间排序。模型给的每个值都作为独立 argv 传给固定脚本，任何输入都不会被 shell 解析。
- **技能目录现在能感知"改写"，而不只是"新增"**：模型的目录消息只在注册表修订号变化时重建，而旧的探测只比对目录列表——所以改写一个已有的 `SKILL.md`（比如描述）它看不见，模型会一直用旧文案直到下个会话。轻量档现在额外给每个技能文件记修改时间与大小，并且从 10 秒改成 3 秒一次；完整重新发现——唯一能发现"此前不存在的技能目录"的一遍——挪到自己的 30 秒节奏。于是检测既更快，也比被它取代的"10 秒一遍"更省。
- **`lib/` 现在确定性重建**：`tsdown` 的产物是提交进仓库的，而 `clean: false` 加两个配置共用一个输出目录，导致早先构建留下的分包块每次都活下来。本地构建工具现在先清空目录，并补声明了三个运行时同伴依赖（`@deepseek-ai/dsh-tool-fs-search`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）——这同时是它们保持 external、不把 DSH 工具栈再打包一份进本插件的原因。
- **验证**：八个已声明版本（`0.1.0-rc.7` … `0.1.5-rc.2`）各跑十三项门禁，新增 `search-real`——用真实发行版上的固定夹具驱动真实工具（记录框定、include 与 `{}` 展开、上限与尾部提示、落盘、卡片、错误码、argv 安全性、显式点名的点文件、读不了的根、名字含换行的根、`/mnt` 路径、超时中断与输出溢出、glob 排序与剪枝）——只剩既有的两项基线失败（`typecheck` 与需要在线服务的 `host-api`）。单测新增 `tests/wsl-search.test.ts`（33 例）与两例刷新用例；`skills-real` 现在也证明"改写技能文件"能通过共享自己的修改时间让目录失效。五个版本的浏览器真实会话端到端确认。
- **按"最坏输入"复查新代码抓到的四个缺陷**：隐藏文件守卫连"显式点名的文件"一起排掉（`grep path=.env` 返回 0 条）、`find` 的退出码被丢弃（`glob path=/nope-missing` 看起来像空目录）、glob 头部按行结尾（根目录名里带换行时被截断）、Windows 路径没做翻译（`grep path='D:\proj'` 失败，而 `read` 能读）。另外把落盘 schema 收紧成了闭合对象——那会让每次"超限且有落盘后端"的调用在返回时校验失败；技能变更探测也加了在飞行中守卫，一次慢 pass 不会再叠出多层 `wsl.exe` 调用。
- **宿主 `bash` 包装命令的行为写进了工具描述**：持久工具把每条命令包成 `eval -- $'…'`，所以命令末尾的 `&` 会把整条包装命令后台化——调用立刻返回、exit code 0、没有输出；而这只 shell 是整轮会话一个进程，`cd` 会带到下一次调用。宿主默认描述两条都没提，DSH 自己的极简模式还建议 `sleep 10 &`；世界现在覆盖描述，写明这两点与安全写法。
- **`0.1.0-rc.7` 不再拿到一个坏掉的 shell**：那个版本的 `dsh-subprocess-local` 没有 Windows 进程检查器，宿主的 PTY 持久 shell 在 Windows 上根本起不来（宿主自己也有这个缺口：它那个版本的极简模式挂 `persistent-bash` 时没有 Windows 守卫）。世界改为在启动时探测底座，答案是否就保留一次性的 `bash` 行——一个能用的无状态 shell——而不是每次都报错。已在真实会话里验证。
- **WSL 会话重新有了可跟踪的后台任务**：用持久 shell 取代一次性 bash 工具时，也把唯一会启动注册表任务的东西一起去掉了，于是 `job_list` 永远回答"没有后台任务"，而传给 `bash` 的 `run_in_background: true` 被静默忽略（参数 schema 允许额外属性，没人报错）——正是运营方会话里暴露出来的缺陷。世界现在挂 `bash_background`（`src/host/wsl-jobs.ts`），一个架在宿主 `ctx.jobs.start` 与本插件 `ctx.shell.start` 之上的薄生产者：工具返回 job id，`job_list`/`job_output`/`job_kill` 照常工作。真实会话已验证：`started background job bash-1` → `job_list` 显示 `running` → `job_output` 增量读到 `tick 1`、`tick 2`，再读 `tick 3` → `[status: completed, exit code: 0]`，并附带运行时推送的完成通告。

## 0.5.0 — 2026-09-19

- **文件工具现在跟随 Linux 符号链接**：`\\wsl.localhost` 共享只列得出链接条目、描述不了它——对链接的 `lstat`、`stat`、`readFile` 全部失败，而 `resolve()` 会回一个词法身份——于是链接路径被当成不存在的文件，链接进来的项目**根本读写不了**。现在只要这份共享描述不了该路径，`resolve`/`lstat` 就向发行版问一次（`wsl.exe … readlink -f`，与技能扫描同一个实现）并从真实路径继续。链接不会被普通文件替换；向悬空链接写入会创建它的目标并保留链接。
- **访问模式重新约束 WSL 会话**：变体在预设的 isolate realm 里挂自己的 `fs` 提供者，宿主的 `fs-sandbox` 包装层不在调用路径上，所以 `workspace-write` 拦不住工作区外写入（修复前实测：Linux 路径与 `D:\...` 路径都能写）。现在 `writeText`/`editText` 完全按 `@deepseek-ai/dsh-fs-sandbox` 的方式围栏：`ctx.sandboxPolicy`（工具层按次传入的优先，否则服务自解析）、同一份 `writableRoots` 白名单加发行版 `/tmp`、同样的 `FS_SANDBOX_DENIED`，并提供工具读取的 `sandboxMode` 以便声明升级。围栏在链接解析之后执行，判定的是真实路径——链接指向工作区外就按工作区外拒绝。
- **技能目录实时刷新**：此前对 UNC 固定 `watch: false`，会话中途加入的技能只能等下个会话。现在 provider 为每个服务过的扫描根维护一个变更探测，每 10 秒重查已发布的目录形状（技能根 + 条目名与类型，**不重读技能文件**），有变化就调 `control.invalidate()`，目录中间件会在会话下一个回合重新收集。
- **`bash` 换成有状态的 WSL shell**——逐模式矩阵反复暴露的那个缺口（每条 `bash` 都是新进程）。DSH 的 PTY 注册表支持替换后端，而 `@deepseek-ai/dsh-terminal-bash` 是配置驱动的，于是世界把它挂进自己的 `persistent-shell` 组（注册表是 agent 级服务），用 `backendType: wsl` 指向本插件的中继脚本（`src/host/wsl-relay.ts` → `lib/wsl-relay.js`），由宿主自己的 node 运行。中继解析发行版（会话 UNC cwd → `DSH_WSL_DISTRO` → 宿主默认）与可选用户名（`DSH_WSL_USER`），然后把自己的 stdio——也就是那个 PTY——交给 `wsl.exe -d … --cd … -e bash -lc 'cd … && exec bash -i'`：登录环境、交互式、且保留会话目录。`@deepseek-ai/dsh-tool-bash-persistent` 注册的工具名就是 **`bash`**，所以它取代了一次性的 `dsh-tool-bash` 行（同时挂载会让整个预设挂载失败——DSH 自己的极简模式正是用"只给持久 shell"来避开这个冲突）。世界还隔离并提供自己的 no-op `sandbox` 能力：PTY 后端在启动前会调 `ctx.sandbox`，而宿主的 Windows 运行器读不了 `\\wsl.localhost\…` 工作区根的安全描述符（`GetNamedSecurityInfoW failed (Win32 1)`），所以 WSL 会话声明 `enforcement: 'partial'`，把策略留在真正有意义的地方——文件工具里。
- **验证**：八个已声明版本（`0.1.0-rc.7` … `0.1.5-rc.2`）跑十二项门禁——新增 `fs-real`（真实后端上的链接解析、经链接与链接链读取、悬空链接创建、链接保留、出工作区链接的围栏、发行版 `/tmp` 允许）与 `relay-real`（真实 WSL 上的有状态 shell、发行版与用户名解析、干净退出）——仅剩既有的两项基线失败（`typecheck` 与需要在线服务的 `host-api`）。单测：`tests/fs-policy.test.ts`（7 例围栏）+ 技能 provider 的刷新用例，叠加在原有套件之上。

## 0.4.5 — 2026-09-19

- **链进 WSL 工作区的项目现在能被发现了**：`\\wsl.localhost` 9P 共享会把 Linux 符号链接当作条目列出来，却解析不了它的目标，于是技能扫描（本来就会在能解析链接的底层上跟随目录链接）直接跳过所有链接进来的项目，连带跳过它下面的嵌套项目（即 [#10](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/issues/10) 描述的那种布局）。现在只要共享报出一个它跟随不了的链接，插件就回头问发行版本身（`wsl.exe -d <发行版> -- readlink -f <Linux 路径>`），拿到真实路径后从那里继续走。这条回退是有意加了上限的：每次查找最多 32 条链接、最多 4 个调用并发、单次超时 10 秒，原有的深度 / 已访问目录 / 技能目录预算不变。由于继续扫描的位置是解析后的真实路径，同一项目既被直接访问又被链接访问时只会走一次，指回工作区根目录的链接环也会被已访问集合吸收，不会打转。
- **这条回退不覆盖什么**：`read/write/edit` 仍然走 `WslFileSystem` 的路径解析，它不跟随 Linux 链接，因此直接读写链接路径会报路径不存在——请用真实路径。帮助面板的「已知问题」现在如实写这一点，而不再是"可以用 readlink 补，但尚未实现"。
- **为什么一条链接一个 `wsl.exe`**（实测记录）：`wsl.exe` 会**丢掉**命令之后的参数（`sh -c 'echo $#' sh a b c` 返回 0），而且它的命令行解析会把含双引号的参数截断，所以批量的 `sh` 循环没法可靠地透过它工作。直接 `readlink -f a b c` 也不行：GNU `readlink` 遇到第一个解析不了的路径就停下（仍以非零退出），批次里后面的链接会被无声地饿死。把每个路径作为进程参数交给一次短调用，就完全绕开了引号问题——带空格、引号、反斜杠的路径都能解析——代价是每条链接一个进程（热态约 35 ms；本机上 6 条链接端到端 179 ms；没有链接的工作区则完全不会启动发行版进程）。
- **验证**：八个已声明版本（`0.1.0-rc.7` … `0.1.5-rc.2`）跑通与 0.4.4 相同的 8/10 项检查（仅剩既有的 `typecheck` 基线与一项需要在线服务的检查）。真实 9P 检查现在会构造"只能靠符号链接进入"的 fixture，断言链接进来的项目、它下面的嵌套项目以及 `get()` 取正文；同一次运行里把回退能力摘掉再走一遍，两者都找不到，即修复前的行为在原位复现。在真实 WSL fixture 上（`/home/mille/symprobe/ws`：链到工作区外的目录、链接链、指向文件的链接、悬空链接、指回根目录的环）技能目录从 2 个变成 5 个，`get()` 也都能通过解析后的定位读回正文。

## 0.4.4 — 2026-09-19

- **在 WSL 变体基础上改出来的自定义模式完全用不了**：本插件靠 id 前缀（`wsl-`）识别自己的产物，于是「把生成的 `wsl-standard` / `wsl-cordis` 复制改名再改」得到的用户预设会被当成普通源预设，被**再追加一个世界组**。DSH 拒绝含两个 `wsl-world` 行的组合，选中该模式时直接失败：`无法切换到「WSL · <名称>」：duplicate loader entry id: wsl-world`；在"先挂载组、后校验行 id"的版本上，同一处重复会晚一步表现为 `tool "str replace editor" is already registered in this scope`（即 [#24](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/pull/24) 报告的现象）。现在生成器会**替换**它找到的世界组（按挂载的 `shell-wsl` / `fs-wsl` provider id 识别，改过组名也能认出），每个变体最终只挂一个世界，且指向本机安装的 provider。源里重复出现的顶层行 id 也只保留第一处——DSH 遇到重复 id 是**整个预设**不可用，而不是只丢那一行。
- **`tool-str-replace-editor` 行与旧的 `str-replace-editor` 行一样被替换**（[#24](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/pull/24)）：较新的名单用这个 id，而它注册的工具名与注入世界组里那个编辑器行相同，所以源里的那行会被丢弃，变体注入的、走 WSL 文件系统的编辑器保留。
- **变体显示名不再多出一层引号**：变体的 `preset.yml` 原先逐字复制源里的 `name:` 标量，于是 `name: 'Data mode'` 到了模式选择器里变成 `WSL · ''Data mode''`；现在会先去掉一层 YAML 引号再写出。
- **未采纳 [#24](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/pull/24) 的做法**：禁用 `tool-cordis` 行来规避 inspect provider 重复注册。`disabled` 的行根本不会 apply，结果是 WSL 创造模式**直接丢掉** `cordis_inspect_list` / `cordis_inspect_query`（已与 0.4.3 对照：0.4.3 里两个工具都在，且能返回 host 与 client 两侧的 provider）；PR 描述里"模型仍能在工具目录看到、只是不能用"与实际不符。其报告中的重复注册需要该行被 apply 两次，而这在"由复制预设引起"的情形下已由上面的行 id 去重解决。
- **帮助面板整理**：面板最前面是一句问候语与仓库链接，新增「本次更新」一节，已知问题只保留仍然成立的条目——历史上的「0.4.3 已修复」说明与按版本讲旧 API 的段落已删除。兼容性 chips 保持原样：它们是本构建声明的清单，不是历史。
- **逐模式矩阵（真模型）**：在 `0.1.0-rc.7`、`0.1.1-rc.2`、`0.1.3-alpha.2`、`0.1.5-rc.2` 上，四个 WSL 变体（标准 / PTC / 极简 / 创造）各自跑一遍：用文件工具写文件、用 bash 执行 `uname -r; pwd; whoami` 并把输出重定向落盘、再读回文件。每个模式都在 `/home/mille/<工作区>/notes/` 里留下了 `MODE-<模式>-OK` 与 WSL2 内核输出，零 loader 报错；随后单独一次 bash 调用又回到工作区目录，即文档所写的「按次 shell」（PTY 组仍然不注入）。`0.1.2-rc.1` 与 `0.1.5-rc.1` 只做了四模式切换与真实回合，没有文件/bash 断言。
- **验证**：八个已声明版本（`0.1.0-rc.7` … `0.1.5-rc.2`）跑通与 0.4.3 相同的 8/10 项检查（仅剩既有的 `typecheck` 基线与一项需要在线服务的检查）；17 个已安装运行时里全部 shipped 预设共 136 次变换，除本次修复外结果不变；68 个"复制变体"场景全部收敛为单一新世界组。另做浏览器 + 真模型验证：复制变体模式本身、创造模式（检查工具完整）以及 `0.1.0-rc.7` 的标准流程。

## 0.4.3 — 2026-09-11

- **persona 文本位置变更**（[#22](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/issues/22)）：DSH 把 persona 面向模型的字段从 `text` 改为内联 `suffix` + 折叠 `prefix`，而变体生成器只识别 `text: >-`，于是 WSL 环境说明从未追加（会话仍在发行版内运行，但模型不知道自己的 cwd 是 Linux 路径）。现在按 `suffix` → `text` → `prefix` 依次补写（内联标量会先折成块标量，句子落在原 `text` 块的位置），带 `complete: true` 的 persona 依旧不动。
- **帮助面板**：对话框新增「?」按钮，就地展示本构建声明的 DSH 版本（直接从 `package.json` 经宿主路由读取，不会与清单脱节）、插件的用法与特性，以及无法修复的已知限制。
- **UNC 工作区终于能收到技能目录**：宿主技能提供者用 `fs.watch` 监视工作区，对 `\\wsl.localhost\...` 会抛 `EISDIR`，该次观测被判为不完整，而 `dsh-tool-skill` 在快照不完整时会丢弃**整条**目录消息，于是 WSL 会话的模型一个技能都看不到。现在生成预设时把 `skill-filesystem` 行的 `watch` 固定为 `false`（若该行已有 `config:` 就并入，源里自己声明了 `watch` 则不动），目录改为在会话启动时扫描一次。代价是不再实时刷新：会话运行中途加入的技能要等下一个会话（技能正文仍实时读取）。
- **`verify-lib` 加固**：其注释/字符串剥离器会把注释里的孤立单引号与后面的引号配对、吞掉剩余 bundle，使所有 `node:*` 导入看起来都被 tree-shake 掉；现在引号规则遇换行即终止，与 JavaScript 字符串一致。

## 0.4.2 — 2026-09-10

- **在 `0.1.2-rc.1` 工作区里「创建并打开」**：会话启动器改为在对话框写入时解析——本插件 apply 早于发布 `uiWorkspace` 的 UI 域注册服务，apply 时缓存的值整页都是 `undefined`，于是「创建并打开」只建了工作区、没开会话，而对话框仍报成功。两种 API 都不存在的版本现在会在写入前直接失败，不再留下孤立工作区。
- **技能正文完整性**：`findFrontmatterEnd` 返回的就是正文首字符下标，此前的偏移会把首字符吃掉；同时**带 UTF-8 BOM 的 `SKILL.md` 不再被丢弃**（BOM 会在围栏检查前剥离）。
- **绑定收敛于迟到输入**：agent preset 名单与已注册的 `/mnt/<drive>` 工作区集都是绑定的输入且都异步到达，现在各自到达后重跑一遍，而不是等一个可能永远不来的会话存储事件。
- **兼容性清单修正**：`0.1.3-alpha.1` 并未发布（`npm view` 为 404），替换为已发布的 `0.1.3-alpha.2`。
- **可复现发布**：新增 `.gitattributes`（`* text=auto eol=lf`、`lib/** -text`）。`core.autocrlf=true` 会在检出时把文本文件改写成 CRLF，而 `lib/` 是提交并原样发布的，导致同一提交在不同机器上产出不同的 npm 包。
- **闭环测试**：`tests/client-lifecycle.test.mjs` 用发布出去的 `lib/client.js` 跑通新旧两种服务形态（`connection.api.agentPresets` + `workspaces.startSession` 与 `remote.agentPresets` + `uiWorkspace`），并断言「创建并打开」的正常、迟到注册与无启动器三种情况。

## 0.4.1 — 2026-09-03

- **DSH `0.1.2-rc.1` 兼容**：运行时按特性检测自动选用新旧 API——`uiWorkspace.startSession()`（`0.1.2-rc.1+`）/ `workspaces.startSession()`（`0.1.1-rc.2` 及更早）、`summary.projectionValues?.agentPreset`（`0.1.2-rc.1+`）/ `summary.agentPreset`（`0.1.1-rc.2` 及更早）；兼容性清单加入 `0.1.2-rc.1`。
- **修复 `0.1.2-rc.1+` 上的 `without inject` 崩溃**：agent preset 名单改经 `ctx.get('remote.agentPresets')` 读取（拓扑无关的服务查找），不再走 `remote` 聚合上的 `agentPresets` 属性——Cordis 的 associate 代理会拒绝未在 `inject` 声明的点号属性。`inject` 仍只保留两代 DSH 共有的服务（`slots`、`locale`、`sessions`、`workspaces`）。

## 0.4.0 — 2026-08-29

- **查询缓存**：已完成的技能目录查询按扫描根缓存 10 秒，避免在慢速 9P 共享上反复重扫；`get()` 仍实时读正文，新技能在 TTL 窗口内出现。
- **符号链接项目**：0.4.0 时显式识别目录符号链接并安全剪枝（不崩、不循环），并实测出"光靠共享本身跟不了"——Windows 侧无法解析 Linux 符号链接（`readlink` → `EISDIR`，`stat`/`readdir` → `ENOENT`）；0.4.5 改为交给发行版解析，链进来的项目因此可被发现（见该版本说明）。另加"名称 + 正文"指纹去重，保证能解析链接的平台上别名技能不会被发布两次。
- **块标量 frontmatter**：`description:` / `whenToUse:` 写成 YAML 块标量（`|`、`>`）现在能解析，此前这类技能会被静默丢弃。
- **兼容性清单**：`dsh.compatibility.dshReleases` 逐版本声明兼容性，并附可复现的一次性 Profile 安装/启动/卸载证据；`engines` 声明 Node.js 下限。
- **门禁脚本**：`scripts/check-rank-parity.mjs` 在项目等级常量与宿主 `dsh-skill-filesystem` 漂移时让发布失败。

## 0.3.2 — 2026-08-29

- **WSL 会话注入嵌套项目的技能目录**（[#10](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/issues/10)）：注册工作区之下的嵌套项目里的 `.dsh/skills` / `.agents/skills` 会带宿主的项目等级与来源一并发布，模型看到的目录与会话 cwd 就在项目里时一致；发现过程有深度与预算上限，会剪掉 `node_modules` 与点目录，且不改动非 WSL 会话。
- **扫描根对齐宿主**：从项目子目录发起查询先就近解析 `.git` 祖先，深层 cwd 也能看到所属项目的技能，且不会泄漏该祖先之上的技能。
- **加固**：技能根预算按次强制，`skills.registerProvider` 调用加了保护，宿主 `skills` 服务形状不同时不再拖垮插件加载。
- **清理**：移除历史预构建 `lib/` chunk 中残留的死 vendor 代码（含内联的 schemastery 副本），并补充嵌套技能目录的回归测试与 TESTING.md 章节。

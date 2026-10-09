# 上线前的行为矩阵（WSL 工作区插件）

**这份文件是什么**：每次要发新版本，在真 dsh 里用他的订阅把这批提示词逐条跑完，**三条判据全通过才上线**。
它管的是"行为"，不是"用例数量"：一条命令在**没有故障的原生 bash** 里是什么结果，在我们这层就必须是什么结果。

**基准线（这条决定一切）**：参照物是"一台正常机器上的交互式 bash"。
**不准拿 dsh 里坏掉的 bash 当基准**——宿主自己的持久 bash（issue #51 的 303.8 s 那一族）、
或任何"我们这层本来就答不对"的现状，都不算期望值。写期望时先问："人在终端里敲这行会看到什么？"

## 0. 三态判决

每一行只能落在三格里之一，且必须写清落在哪格、凭什么：

| 判决 | 含义 | 后果 |
|---|---|---|
| **MATCH** | 我们与原生无故障行为一致（含退出码、两条流、耗时量级、副作用次数） | 通过 |
| **PARITY-NOT-DEFECT** | 原生也这样（bash 的语义本身），我们照抄 | 通过；但**必须留原生那一侧的实测凭据**，否则不许用它当挡箭牌 |
| **DEFECT** | 原生能正常完成/正常报错，我们改变了结果、丢了字节、多做了副作用、或答了个说不清的话 | **不上线**；要么本版修，要么写进已知债并有出口（不允许"下次再说"） |

一行没跑到 = DEFECT（漏跑不是通过）。**未定**＝那一行跑过、但原生那侧把写好的期望打脸了、判决还没重写——它和 DEFECT 一样挡住上线，不许当"已通过"读。工具不存在（没装 python3/docker/systemd）记 **SKIPPED**，
且 SKIPPED 不算 MATCH——矩阵里每组的 SKIPPED 数要写在结论里。

## 1. 怎么跑（规程）

1. **环境**：真实产品实例。允许两种，结论等价：(a) 他本人 Desktop（真模型、花订阅），(b) 驱动起的独立实例
   （独立 `DSH_HOME`、自有端口、脚本化 provider，¥0）。**发行版两侧都要过**：`Ubuntu`（本机 WSL2）与 CI 的
   `Ubuntu-24.04`（WSL1/WSL2）；WSL1 上有一格"内核读不到睡眠位置"的已知差异，按第 3 节的行判。
2. **一次一条**，命令原样发（不加 `printf MARKER` 之类前缀——改前缀会改变被测组件看到的第一个词，
   10-06 就是这么把 `needsTty` 的判断从 `vim` 变成 `printf`、白烧 121 703 ms）。
3. **读数不靠人转述**：从产品自己落的会话转录取
   （`~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`，多帧 zstd；`tool/call`↔`tool/result`
   按 `callId` 配对，耗时＝两条顶层 `time` 相减）。
4. **原生那一侧同日同机现测**：`wsl.exe -d <distro> -u <user> -- bash -lc '<同一行>'`，
   期望值从这一发抄，不从记忆抄、不从文档抄。
5. **产出物**：一张四列表（命令 / 我们这层回来的原文 / 原生回来的原文 / 判决+理由），
   连同实例版本号、chunk 名、`package.json#version`、git 头一起写进发版记录。任何 DEFECT 未清，不发。

## 2. 矩阵

约定：`原生命令` 就是发给 dsh 的那一行（提示词里逐条列出，见 §4 的话术模板）；
"必须看到"写的是**判决条件**，不是文案模板——文案会变，字节数和退出码不会。

### G1 流与退出码

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 1.1 | `echo out; echo err >&2; exit 3` | 两条流各自到位，`$?`=3 | stdout=`out`、stderr 字段含 `err`、`[exit code: 3]` | 已入 census + live gate |
| 1.2 | `bash -c 'echo out; echo err >&2; exit 3'` | 同上，且**不结束会话 shell** | 同上，且没有"结束 shell"那句 | 已入 census |
| 1.3 | `set -o pipefail; (exit 3) \| cat; echo CODE=$?` | `CODE=3` | `CODE=3`（不许被管道的 0 吞掉） | 已入 census |
| 1.4 | `false; echo STILL=$?` | `STILL=1`，shell 不死 | 同 | 已入 live gate |
| 1.5 | `echo hi \| head -n1; echo PIPE=$?` | 无 SIGPIPE 噪声 | 不许出现 `Broken pipe` 之类我们加的字 | 已入 census |
| 1.6 | `exit 0` | 单独敲这一行，终端会退出 | "这行结束了 shell"那句 + 下一发可用 | 三形之一，已入 |
| 1.7 | `sh -c 'echo A; kill -9 $$'; echo K=$?` | 原生（脚本文件路线）`A` 后 `K=137`，stderr 里有 bash 的 `Killed` 作业消息，退出 0 | `K=137`，会话 shell 不受影响（若被重建，答案要自己说明） | 实测（本机隔离实例，两侧同日） |
| 1.8 | `bash -c 'trap "echo TR" EXIT; exit 7'` | `TR` 在退出码之前出现 | 顺序与原生一致 | 已入 census |

### G2 文本编码与二进制

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 2.1 | `printf 'a\x00b\xff\xfe' \| wc -c` | **5** 字节（`a`、NUL、`b`、0xff、0xfe；今天实测 5，原先写的 6 是错的） | `5`，不许因解码翻倍或减半 | 已入 census |
| 2.2 | `printf 'a\x00b\xff\xfe' \| od -An -tx1 \| tr -d ' \n'` | 十六进制串 | 逐字节相同 | 已入 census（形状类） |
| 2.3 | `find . -name '*.txt' -print0 \| xargs -0 grep -l alpha` | 命中文件名列表 | NUL 分隔不许变乱码（0.7.7 修过这一族） | 已入 census + 回归 |
| 2.4 | `git ls-files -z \| head -c 40 \| cat -v` | 带 `^@` 的字面 | 同上 | 实测（本机隔离实例，两侧同日） |
| 2.5 | `printf '中文 \r\n CJK\r' \| od -c \| head -3` | `\r\n` 原样 | 不许被"修好"成 `\n` | 已入 census |
| 2.6 | `LC_ALL=zh_CN.UTF-8 date 2>/dev/null \| head -1` | 中文月份（若 locale 在） | 字节一致；locale 缺 ⇒ SKIPPED 并注明 | 实测（本机隔离实例，两侧同日） |
| 2.7 | `printf 'x\x1b[31mRED\x1b[0m\n'` | ANSI 序列原样 | 不许被吃掉或重复着色 | 已入 live gate |
| 2.8 | `base64 <<< hello \| base64 -d` | `hello` | 往返无损 | 实测（本机隔离实例，两侧同日） |

### G3 路径与 Windows 互操作

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 3.1 | `wslpath -u 'C:\Program Files\node\node.exe'` | 带空格的 `/mnt/c/...` | 逐字符相同 | 实测（本机隔离实例，两侧同日） |
| 3.2 | `ls -ld "$(wslpath -u 'C:\Program Files')"` | 目录存在 | 不许因空格断开成两条命令 | 实测（本机隔离实例，两侧同日） |
| 3.3 | `cd /mnt/d && pwd && ls \| head -3` | 跨盘挂载可读 | 同 | 已入（search/fs real） |
| 3.4 | `mkdir -p "/tmp/带 空格 与中文 目录" && ls -d /tmp/带*` | 创建并列出 | 文件名不许被规范化 | 实测（本机隔离实例，两侧同日） |
| 3.5 | `printf 'x\n' > "/tmp/nl$(printf '\n')file" && ls /tmp \| grep -c nl` | 换行在文件名里也成立 | 原生什么样就什么样（原生若报错，我们也报错且同句） | 实测（本机隔离实例，两侧同日） |
| 3.6 | `cmd.exe /c ver 2>&1 \| head -2` | 输出 Windows 版本（带 `\r`） | CRLF 噪声不许被我们放大 | 未定 |
| 3.7 | `node.exe --version 2>&1 \| head -1`（若 PATH 里有） | Windows node 版本 | 同一 PATH 形状下与原生一致 | 未定 |
| 3.8 | `ls /mnt/c/\$Recycle.Bin 2>&1 \| head -2` | EPERM/拒绝的**原生**报错句 | 报错句子来自系统，不来自我们猜 | 实测（本机隔离实例，两侧同日） |

### G4 文件系统与 9P（写路径与链接）

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 4.1 | `ln -s /etc/hostname /tmp/l41 && readlink -f /tmp/l41 && cat /tmp/l41` | 解析成功 | 链接不许被当"不存在"（#10/#44 修过） | 已入回归 |
| 4.2 | 工作区里一个 Windows 侧看不见的 Linux 符号链接：`ls -l` 后经 `readlink -f` | 用发行版解析 | 同上，走我们 fs 时也要对 | 已入（skills/fs real） |
| 4.3 | `mkdir -p /tmp/d43/a/b/c && (cd /tmp/d43/a/b && rmdir /tmp/d43/a/b && pwd)` | `getcwd` 失效时的原生句子 | 同句、同退出码 | 已入 live gate 族 |
| 4.4 | `touch /mnt/c/Windows/system32/drivers/x 2>&1 \| head -1` | 系统的拒绝句 | 拒绝要像拒绝，不许变"不存在" | SKIPPED（产品侧未跑） |
| 4.5 | `du -sh /mnt/c/Users` | 原生就是慢（实测 8 分 38 秒未完，状态 `D`） | **PARITY-NOT-DEFECT**；但期限到了必须报名字、留下已产出字节 | 已定案 |
| 4.6 | `find /usr -name '*.h' \| wc -l`（冷缓存） | 与热缓存同答案，只耗时不同 | 答案稳定；耗时不设判据 | 实测（本机隔离实例，两侧同日） |
| 4.7 | `dd if=/dev/zero of=/tmp/f47 bs=1M count=64 status=none && wc -c < /tmp/f47 && rm /tmp/f47` | 67108864 | 二进制写不许截断 | 实测（本机隔离实例，两侧同日） |

### G5 权限、用户与 sudo

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 5.1 | `sudo true; echo SUDO_CODE=$?` | 要密码则失败（无 tty 时 sudo 自己说） | 系统原句 + 出路（人用右栏终端标签 / `wsl_terminal` / NOPASSWD / `DSH_WSL_USER`），**不许干等 deadline** | 已入 census（608 ms 档） |
| 5.2 | `sudo -n true 2>&1 \| head -1; echo RC=$?` | 非交互拒绝句 | 同句同码 | 实测（本机隔离实例，两侧同日） |
| 5.3 | `id -u; whoami` | 会话用户 | 与 `DSH_WSL_USER` 声明一致 | 已入（provenance 行） |
| 5.4 | `su - -c 'echo SU_OK' 2>&1 \| head -2` | 要密码就失败 | 不许静默 | 实测（本机隔离实例，两侧同日） |
| 5.5 | `chmod 000 /tmp/f55 2>/dev/null; ls -l /tmp/f55; cat /tmp/f55 2>&1 \| head -1` | `Permission denied` | 拒绝≠不存在（0.7.7 修过 `stat` 折叠） | 已入回归 |
| 5.6 | 以 root 用户跑同一子集（`DSH_WSL_USER=root`） | 同上各行 | 至少 G1/G2/G4 全通过（CI 两用户都跑） | 规程 |

### G6 终端、键盘与分页器

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 6.1 | `sh -c 'read x < /dev/tty; echo GOT=$?'` | 终端里能等；无键盘的管道里立刻 1 | 被识别成"等键盘"→ 停掉 → 同一次调用内改用自己的 PTY 再跑，且**说明副作用做了两遍** | 已入 live gate |
| 6.2 | `git log --oneline -n 5`（大仓库） | 分页器开或输出全给 | 分页类不自动升级；`tty: true` 才要终端 | 已入 live gate |
| 6.3 | `vim -c 'q' /tmp/x 2>&1 \| head -2` | 无终端时报错 | 按"进程在做什么"判，不看命令名（历史上名单错过 `ssh-copy-id`/`vim`） | 实测（本机隔离实例，两侧同日） |
| 6.4 | `top -bn1 \| head -3` | 一次性输出 | 不许被判成等键盘 | 实测（本机隔离实例，两侧同日） |
| 6.5 | `timeout 3 cat` | 3 秒后 124 | 期限句由 `timeout` 自己出，我们不叠 | 实测（本机隔离实例，两侧同日） |
| 6.6 | `ssh -o BatchMode=yes localhost true 2>&1 \| head -2` | 无密钥就拒绝并给原句 | 同 | 实测（本机隔离实例，两侧同日） |
| 6.7 | `read -t 2 x < /dev/tty; echo RC=$?` | bash 自己的 `-t` 先到 | 不许被"提前止损"覆盖掉原生 RC | 已知敏感（#51 记录），必跑 |
| 6.8 | `stty -a \| head -2` | 交互式终端才有 | 管道里原生也报错 ⇒ PARITY-NOT-DEFECT，留凭据 | 实测（本机隔离实例，两侧同日） |
| 6.9 | 终端三步（先 open，再 send，再 read），不是单条命令 | 屏上出现 `TERM_21` | 同；且终端里 PATH 噪声（`bash: export: …`）要如实暴露 | 已跑（17 发那轮） |

### G7 进程与信号

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 7.1 | `pkill -f 'sleep 40'; echo RC=$?` | 命中则 0 | 不许顺手把会话 shell 自己带走（带走就要说） | 实测（本机隔离实例，两侧同日） |
| 7.2 | `kill -INT -$$`（在子 shell 里） | 该进程组收 SIGINT | 会话存活 | 已入 live gate（SIGINT 格） |
| 7.3 | `(setsid sleep 37 & disown); echo DETACHED=$!` | 脱离 | 作业表不许谎报数量 | 已入 live gate |
| 7.4 | `jobs -l \| wc -l`（上一条之后） | 原生数字 | 与原生同数或解释差异 | 已入 live gate |
| 7.5 | `exec bash --norc` | shell 被替换、随后退到 EOF 退出 | "结束了 shell + 被重跑一次"那句；下一发正常 | 实测 1162 ms |
| 7.6 | `nohup sleep 5 > /tmp/n76.log 2>&1 & sleep 6; cat /tmp/n76.log` | 无输出但文件在 | 副作用可核实 | 实测（本机隔离实例，两侧同日） |

### G8 持久 shell 的状态（这是"我们这层"最容易变的地方）

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 8.1 | `cd /tmp && export V81=kept && pwd` → 下一发 `pwd; echo V81=$V81` | 同一 shell 才延续 | 延续；且**跨重建**要说明重放了什么、没恢复什么 | 已入 census + live gate |
| 8.2 | `alias zzz='echo ALIAS_OK'; zzz` | **原生同一行也 not found(127)** | 与原生同结果 ⇒ PARITY-NOT-DEFECT（凭据：`printf … \| bash -i`） | 实测两侧一致 |
| 8.3 | `alias yyy='echo YYY_OK'`（一行）→ 下一发 `yyy` | 生效 | 生效 | 已入 census |
| 8.4 | `f84(){ echo FN_OK; }; export -f f84; bash -c f84` | 子 shell 能用 | 同 | 已入 census |
| 8.5 | `set -e; false; echo NEVER` | 终端被结束 | 同 7.5 那句 + 退出码 | 已定案（见 §3） |
| 8.6 | `IFS=: read a b <<< 'x:y'; echo "[$a][$b]"` | `[x][:y]` | IFS 不许泄漏到下一发 | 实测（本机隔离实例，两侧同日） |
| 8.7 | `echo '!历史' ; echo 1!2` | history expansion 关着才安全（我们已显式关） | 不许出现 `event not found`（原生交互默认也关？以原生为准，写清） | 已入（10-05 那格） |
| 8.8 | 两个会话并发各自 `cd` | 互不污染 | 一 agent 一 shell 的边界 | 已入 live gate（双 owner） |

### G9 输出体量、截断与落盘

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 9.1 | `seq 1 200000 \| wc -l` | 200000 | 不许因截断把计数改错 | 已入 census |
| 9.2 | `seq 1 5000 \| tail -40` | 4961..5000 | 原文完整 | 已入 census |
| 9.3 | 大输出+溢写文件（`seq 1 200000` 直出） | 全量在 spill 里 | **spill 文件不许在被写时就报行数/被读**（#56/WSL1 竞态修过），报的路径真存在 | 已入回归 |
| 9.4 | `python3 -c "print('x'*300000)"` | 一块大块无换行 | 截断声明与实际字节数一致 | 实测（本机隔离实例，两侧同日） |
| 9.5 | `yes \| head -c 100000 \| wc -c` | 100000 且无 SIGPIPE 噪声 | 同 | 实测（本机隔离实例，两侧同日） |
| 9.6 | 期限打断长命令：`echo BEFORE; sleep 6; echo AFTER`（给 1500 ms） | 原生无期限概念 | `BEFORE` 必须在、`AFTER` 必须不在、要报 `timed out after …` 并指出后台出路；不断言快慢 | 已入 live gate |

### G10 真工具、真网络（最接近"日常开发"）

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 10.1 | `git init -q /tmp/r101 && cd /tmp/r101 && git commit -q --allow-empty -m wip; git log --oneline \| wc -l` | 1 | **不许因为超时重放而变 2**；若真做了两遍，必须自己说明（#68 的披露条款） | 必跑（有副作用，夹具在 /tmp） |
| 10.2 | `npm install --no-audit --prefix /tmp/r102 js-yaml 2>&1 \| tail -3` | 装成 | 进度条/ANSI 不污染结果句；退出码对 | 已跑（用户轮） |
| 10.3 | `npx --yes tsc --version` | 版本行 | 同 | 未定 |
| 10.4 | `python3 -m venv /tmp/r104 && source /tmp/r104/bin/activate && which python` | venv 内 | 激活状态是否跨发延续，按原生"同一 shell 才延续"判 | 实测（本机隔离实例，两侧同日） |
| 10.5 | `curl -sS -N --max-time 4 <流式地址> \| wc -c` | 字节数 | 流式期不许被误判成等键盘 | 已跑 |
| 10.6 | `docker run --rm alpine echo DOCKER_OK 2>&1 \| head -2` | 装了才判 | 没装 ⇒ SKIPPED（不算过） | 实测（本机隔离实例，两侧同日） |
| 10.7 | `systemctl is-system-running 2>&1 \| head -1` | 取决于是否 systemd | 与原生同句 | 实测（本机隔离实例，两侧同日） |
| 10.8 | `make -C /tmp 2>&1 \| head -2` | 原生报错句 | 同 | 实测（本机隔离实例，两侧同日） |

### G11 发行版与内核差异（两枚内核都得过）

| # | 检查 | 已知事实 | 必须看到 | 状态 |
|---|---|---|---|---|
| 11.1 | WSL1 上 `cat /proc/<pid>/wchan` | 全为 `not-reported` | 等键盘检测不能靠"读到空"就宣布没有等待；note 要写它读了什么 | 已入（#169/#172 族） |
| 11.2 | WSL1 上 9P 分片与大输出 | 与 WSL2 不同碎 | 截断/溢写在两内核都成立 | 已入 |
| 11.3 | 两行对照：发行版里 `uname -r`，Windows 侧 `wsl.exe -l -v`，比的是同一枚内核 | 两枚内核 | 会话在声明的那枚里 | 已入（provenance） |
| 11.4 | 期限类格子（G1/G6/G9）在 WSL1 重跑 | 非 acting 那侧 | 不许用"等更久"糊过去；判决要写在哪侧测的 | 已入 CI（两平面两内核） |

### G12 拒绝与失败路径（工具必须诚实的地方）

| # | 原生命令 | 原生无故障行为 | 必须看到 | 状态 |
|---|---|---|---|---|
| 12.1 | `grep -E '*' /etc/hostname` | bash 里报正则错 | 分类器要认出"无效模式"，且预算按字符不按字节 | 已入回归 |
| 12.2 | `cat /etc/shadow 2>&1 \| head -1` | 拒绝 | 拒绝句原样 | 实测（本机隔离实例，两侧同日） |
| 12.3 | 超大 `stdin` 参数（>32 KiB） | 无对应原生 | 按名拒绝且**什么都不执行**（半口输入比失败更像程序的错） | 已入 |
| 12.4 | `timeoutMs` 填 0 / 负数 | 无对应原生 | 拒绝或夹紧，不许静默变 0 秒即死 | 未定 |
| 12.5 | 同一命令连败 3 次 | 终端不管 | 只提示"这已连败 N 次"，仍照跑，不禁止 | 已入 live gate |
| 12.6 | 取消（`AbortSignal`） | 用户按停 | 报"被取消"，**不许**把取消报成 `[exit code: …]` | 已入 |

## 3. 本轮（2026-10-09，构建 = main + #68）已定案的行

| 行 | 判决 | 凭据（同日两侧） |
|---|---|---|
| 4.5 `du -sh /mnt/c/Users` | PARITY-NOT-DEFECT | 原生 `bash -lc` 跑 8 分 38 秒未完，进程状态 `D`；我们这层按模型自填的 600 s/180 s 报期限并留下已产出字节 |
| 8.2 alias 同一行 | PARITY-NOT-DEFECT | 原生 `printf "alias zzz='echo A'; zzz\n" \| bash -i` → 同样 `not found`；换行则 `YYY_OK` |
| 8.5 / 7.5 结束 shell 两形 | MATCH（经 #68 修复） | 原生终端会关掉；我们 1163/1162 ms 回答带退出码与自述，`isError=false` |
| 9.6 期限打断长命令 | MATCH | 已产出的 `BEFORE_SLOW` 保留、`timed out after 1500ms`、指向 `run_in_background`/`bash_background` |
| G1 全组（1.1–1.8） | 八行 MATCH | 本机隔离实例（自有端口＋独立 DSH_HOME＋脚本化 provider，装配 main `ae1ef72`+`0356fc2`+`ce5b807`）八发：1.1 `out`＋`[stderr] err`＋`[exit code: 3]`，并自述“结束了会话 shell、它做过的事做了两遍”；1.2 两条流＋`[exit code: 3]`；1.3 `CODE=3`；1.4 `STILL=1`；1.5 `hi PIPE=0` 且无 `Broken pipe`；1.6 自述“结束了 shell”；1.7 `A K=137`＋`[stderr] Killed`；1.8 `TR`＋`[exit code: 7]`。原生同日同机（命令写成脚本文件再 `bash <file>`）逐条相符：exit 3／exit 3／CODE=3／STILL=1／`hi PIPE=0`／退出 0／`A`＋`K=137`＋`Killed`／`TR` 退出 7。**1.7 原先的“未定”撤销**：`K=` 读不到是我探针把复合命令交给 `wsl.exe … bash -c <文本>`（多一层解析，`;` 被拆开）造成的假读数，不是产品行为 |
| 2.4–12.2（本轮待跑的 32 行，跑了 31） | 27 行 MATCH，4 未定，1 产品侧 SKIPPED | 同一台隔离实例（main `ce5b807`）一个会话 32 发，原生侧同日同机用同一用户（`ruler`）、命令写成脚本文件后 `bash <file>` 逐条重测：2.4 `a.txt^@b.txt^@`；2.6 两侧同格式日期；2.8 `hello；3.1 `/mnt/c/Program Files/node/node.exe`；3.2 同一目录行；3.4/3.5 带空格与中文的名字都成立（`ls /tmp \| grep -c nl` 两侧都是 2）；3.8 两项 SID；4.6 `3006`；4.7 `67108864`；5.2 `sudo: a password is required` + `RC=0`；5.4 `su: Authentication failure`；6.3 vim 的两行警告；6.4 top 首行形状；6.5 无输出；6.6 `Connection refused`；6.8 `stty: ‘standard input’: Inappropriate ioctl for device`；7.1 `RC=1`；7.6 nohup 后 `cat` 两侧都无输出；8.6 `[x][y]`；9.4 300000 个 x；9.5 `100000`；10.4 两侧同句 `ensurepip is not available`；10.6 两侧都说 docker 不在；10.7 `offline`；10.8 两侧 `make: command not found`；12.2 `Permission denied`。**四个开口在下一条** |
| 本轮的四个开口（3.6/3.7、10.3、12.4、4.4） | 未定 / 待重跑 | **3.6/3.7**（`cmd.exe /c ver`、`node.exe --version`）：会话里报 `command not found`；而原生的非交互形（`bash -c`/`bash -lc`）两条都能找到并输出 Windows 版本与 `v24.21.0`；交互形（`bash -ic`）会因主机上的 dotfiles 报 `export: … not a valid identifier` 而不同定（两次读数不一致）。“正常机器上的交互式 bash”会有互操作 PATH，所以这两行不能算 MATCH，也还不能定罪：需先看会话进程自己的 `PATH` 里有没有 `/mnt/c/WINDOWS/System32`。**10.3**：产品侧 `npx --yes tsc --version` 在 120 s 到期被截（答案自己说了到期与背景出路），原生同一行几秒内输出 `Version 5.9.3`（登录形 `bash -lc`）。是“冷 npx 超过默认期限”还是“会话拿不到网络”还没分开：需用更长的 `timeoutMs` 重跑一次。**12.4**：本轮把它当命令发了（文档那格写的是参数，不是命令），两侧都回 `timeoutMs: command not found`——这不是这行要测的东西，需改成一次带 `timeoutMs: 0` 的调用。**4.4**：产品侧按护栏未跑（目标是写入 Windows 系统目录）；原生侧已有读数 `touch: cannot touch ‘/mnt/c/Windows/system32/drivers/x’: Permission denied`。**（前两小时的 G1 八行不在此列）** |
| 1.5 管道早退不许我们加字 | MATCH | 原生今日实测 `hi` + `PIPE=0`、退出 0、无 SIGPIPE 句；我们这层同一行进了 census（`forbid: ["Broken pipe"]`），30/30 CENSUS-CLEAN |
| 1.8 子 shell 的 EXIT trap | MATCH | 原生今日实测 `TR` 先出、退出码 7；同一行进 census |
| 2.1 NUL 与两个高位字节 | MATCH | 原生今日实测 `5` 字节（本文原先写 6，按原生改成 5）；同一行进 census |
| 2.5 CRLF 与孤立 CR 不许被"修好" | MATCH | 原生今日实测 `0000000   x  
  
   C   J   K  
`；会话侧返回逐字节相同的 dump，差异只出现在我第一版格子的空格上 |

## 4. 发给 dsh 的话术模板（逐条一次调用，不许合并）

```
在这个 WSL 工作区里逐条执行下面这些命令，一条一次工具调用，不要合并、不要加前缀、不要改写成别的工具。
每条执行完，把工具原样返回的内容贴回来：stdout、stderr、退出码，以及方括号里的任何说明，
一个字都不要重写、不要总结。跑完一条再跑下一条，全部跑完再收口。有副作用的我都放在 /tmp 里了。
<把 §2 各表"原生命令"列按需要的小组粘进来；一轮建议一个组，10–15 条>
```

那串命令不是手抄的：`node scripts/check-release-matrix.mjs --commands G1,G2` 会按文档顺序打印这些行的原生命令（表格里的 `\|` 会还原成 `|`），一轮贴一条组，跑完再取下一组。

分组轮次的建议顺序：G1+G2（编码/流）→ G8+G7（状态与进程）→ G6+G9（终端与大输出）→ G3+G4（路径与 9P）→ G5+G12（权限与拒绝）→ G10+G11（真工具与两内核）。

## 5. 与机器化测试的关系（哪些行不许只靠人跑）

一条一旦人跑通过，就要下沉成格子；**留在人跑清单里的行就是还没有回归保护的行**。现在：

- **census**（`tests/support/w51-command-census.mjs`，真宿主 + 真 WSL，CI 每帧跑）：G1、G2(2.3)、G8、G9(9.1/9.2) 与"结束 shell 三形"。
- **live gate**（`scripts/compatibility/bash-session-real.mjs`；格子数以该帧的 `n/N checks passed` 行为准，别在这里抄数）：G1、G6、G7、G8、G9(9.6)、G12。
- **parity-real**（14 探针，同一脚本经两条 shell 比字节）：跨 bash 实现的一致性。
- **对照臂**（`test:host-probe`，#71）：boot 失败归因，保证红能说是谁的。

SKIPPED 与未下沉的行必须写在发版记录里，不许用"CI 绿了"代替这张表。

**谁读这份文件**：`npm run test:matrix`（`scripts/check-release-matrix.mjs`）逐行解析这张表——十二组在不在、每行五格齐不齐、id 是否归在本组下、同一命令有没有写两遍、状态列是否在词表内、第 3 节的判决是否点得到表里真实存在的行、判成 DEFECT 的行有没有账本指针。它每帧还自测四次（把这份文件改坏四种形状，要求每种都变红），所以"这道闸只会亮绿"这件事本身也被盯着。

## 6. 增补规则

1. 本版 diff 若触及：帧协议/编码解码/溢写与截断/等键盘检测/信号与重建/`stdin`/新工具面 ⇒ 本轮必须**新增或修改**至少一行，并在 PR 里指出是哪一行。
2. 新行先写"原生那一侧今天跑出来的数"，再写期望；没有原生数就不许写期望（这条防的是把现状当基准）。
3. 判决为 DEFECT 且本版不修的，必须落进 `tests/*` 的账本（故意红台账或 census 的 `SKIPPED`），不许只写在这里。

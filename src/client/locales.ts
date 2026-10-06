/**
 * Bilingual dictionaries for the `wslWorkspace` locale namespace. Product copy
 * is Chinese; English is the parallel export for the standalone bundle.
 */

/**
 * The `wslWorkspace` translations (Chinese, the primary product copy).
 */
export const zh: Record<string, string> = {
  'action.add': 'WSL 工作区',
  'action.title': '添加 WSL 工作区…',

  'dialog.title': '添加 WSL 工作区',
  'dialog.distro': '发行版',
  'dialog.path': '路径',
  'dialog.pathPlaceholder': '/home/',
  'dialog.username': '用户名',
  'dialog.usernamePlaceholder': '留空则使用发行版默认用户',
  'dialog.loading': '正在加载…',
  'dialog.browseEmpty': '此目录没有子文件夹',
  'dialog.upLevel': '..（返回上级）',
  'dialog.browse': '浏览',
  'dialog.check': '检查',
  'dialog.confirm': '创建并打开',
  'dialog.cancel': '取消',
  'dialog.retry': '重试',

  'error.loadDistros': '无法获取 WSL 发行版列表，请确认已安装 WSL 且插件宿主端可用',
  'error.rateLimited': '操作过于频繁，请稍后重试',
  'error.loadDir': '无法浏览该目录',
  'error.presetMissing': '未找到健康的 wsl preset，请确认插件宿主端已安装并配置该 preset',
  'error.presetPending': 'wsl 变体还在生成中，请稍后重试；若长时间没有变体请查看宿主端日志',
  'error.presetBroken': '部分 wsl 变体没有发布出来：',
  'error.presetBrokenOne': '• ',
  'error.presetBrokenMore': '…… 未列出的失败变体数：',
  'error.invalidPath': '请输入以 / 开头的 Linux 绝对路径',
  'error.invalidUsername': '用户名无效：需以字母或下划线开头，仅含字母、数字、_、.、-',
  'error.pathNotFound': '该路径不存在或是文件，请选择一个文件夹',
  'error.createFailed': '创建工作区失败',
  'help.button': '插件说明',
  'help.greeting': '当你看到这句话的时候，说明你的插件已经Cia进来llo～(∠・ω< )⌒★，star一下吗？',
  'help.greeting.repo': 'github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace',

  'help.compat.title': '兼容性',
  'help.compat.versionLabel': '插件版本',
  'help.compat.unknown': '未能读取版本与兼容声明（宿主端没有响应）',
  'help.compat.body': '上方是这份构建声明兼容的 DSH 版本，每一条都在隔离实例上实测过（独立 DSH_HOME、依赖固定到该版本、跑满整套门禁，含真实 ConPTY 下的持久 shell）。\n插件在运行时自动识别 DSH 版本并选用对应的 API；两边都不支持时会明确报错，而不是留下一个空工作区。\n版本不在列表里通常仍然可用，但未经验证。',
  'help.news.title': '本次更新（0.7.6）',
  'help.news.body': 'DSH Desktop 上「未找到健康的 wsl preset」、一个 WSL 变体也生成不出来的问题修好了（issue #47）。\n原因是生成器在调用时向宿主借方言和 YAML 引擎；Desktop 把宿主打在归档包里，而 Node 找裸包名只沿文件系统往上走，这条路走不进去。\n引擎改成本包的正式依赖（4.x 那条版本线），方言也由插件自己构建、与加载它的那个引擎出自同一份命名空间；profile 里别人把 js-yaml 顶到哪个大版本，都不再决定生成能不能跑。\n一个源读不到只算它那一个变体失败，退役目录的清扫照常执行；引擎相关的失败会报出实际解析到的包名、版本与路径。\n新增 npm run test:profile：在临时目录里搭出与真实 profile 同形状的树来验这件事；安装闸门也改成同时断言运行面是否在场。\n文件引用又能预览了（issue #49）。会话里的文件链接、工具行的行号引用、回合末尾的「已改动文件」都走右侧栏，而地址里带的是模型原样写下的 Linux 路径；宿主用 node:path.resolve(cwd, path) 解析它，POSIX 绝对路径在 Windows 上是「当前盘根目录下的相对路径」，所以 /mnt/d/x 落到工作区所在的盘、发行版内的路径落到 cwd 共享的根下，UNC cwd 下的 /mnt/<盘符> 引用还会变成 9P 服务不了的路径（EPERM）。\n客户端半边现在先把地址翻译好再交给侧栏：/mnt/<盘符>/… 换回 X:\\…，其余 Linux 路径走该发行版的 UNC 共享（发行版取自会话的 UNC 工作区，或 /mnt/<盘符> 工作区注册时存下的记录——为此新增了宿主路由 listWorkspaceRecords）。\n不是 WSL 会话、逐字节重建不出来、或发行版未知的地址一律原样透传。只有 0.1.5-rc.1 及以后才有右侧栏与文档预览，更早的六个已声明版本不安装这个钩子。',
  'help.usage.title': '用法与特性',
  'help.usage.body': '点击侧边栏底部的 W 按钮 → 选发行版 → 输入或浏览 Linux 路径 → 检查 → 创建并打开。\n创建出的会话里，bash 与文件工具都落在该发行版内，模型看到的路径全是 Linux 路径；Windows 盘可从会话内通过 /mnt/<盘符> 访问。\n四种模式（标准 / PTC / 极简 / 创造）各有 WSL 变体，在模式选择器里直接选即可，名字形如 WSL · Standard mode（标准模式）。\n用户名可选，等价于 wsl.exe -u <用户名>，只改变 bash 与 persistent-bash 的运行身份；文件工具走 Windows 侧共享，不受它影响。\n技能目录从会话 cwd 最近的 .git 祖先开始向下扫描 .dsh/skills 与 .agents/skills（含嵌套项目），上限 4 层目录 / 64 个技能目录 / 4096 个已访问目录，并按扫描根缓存 10 秒。9P 解不开的符号链接交给发行版 readlink 解析出真实路径（每次查找最多 32 条）后继续扫描，链接进来的项目与它下面的嵌套项目都能扫到。\n目录不再冻结：对 UNC 关闭文件监视之后，插件每 3 秒重查一次已发布的技能目录、并比对每个技能文件的修改时间与大小，所以新增、删除与改写都会在下一个回合生效；完整重新发现每 30 秒一次，用于找到此前不存在的技能目录（技能正文始终实时读取）。\n文件搜索由发行版内的 grep / glob 提供，源预设没有这两个工具的模式（极简）不会多出来：grep 用 GNU grep -E（\\d、\\w、(?i) 可用，环视与反向引用不支持），跳过隐藏项与 node_modules，不读 .gitignore；glob 用 GNU find 列文件、按 gitignore 风格匹配（* 不跨目录、** 跨、{a,b}、前导 ! 取反），按修改时间从旧到新排序。\n文件工具在链接处按真实路径工作，并按真实路径判策略：链接指向工作区外就等于工作区外。\nbash 由 PTY 承载的持久 shell 提供：登录环境、起始目录就是会话工作区，cd / export / venv / 后台任务跨调用保留（它取代了原先一次性 bash）。\n需要可跟踪的后台任务时用 bash_background：它立刻返回 job id，job_list / job_output（增量读取）/ job_kill 都作用于它；bash 本身没有 run_in_background 参数，传了会被忽略。job id 只在本次 DSH 进程内唯一，重启后会重新编号，引用前先用 job_list 确认。\nbash 与文件工具的 shell 都在发行版内运行、不受 DSH 文件策略约束；文件工具（read/write/edit）受策略约束，工作区内修改模式下只能写工作区内。',
  'help.known.title': '已知问题',
  'help.known.body': 'grep 用的是发行版自带的 GNU grep：方言是 POSIX ERE（环视与反向引用不支持），且不读 .gitignore，被 git 忽略的文件照样会被搜到；只有隐藏项、node_modules 与版本库目录会被跳过。发行版没有 GNU grep（如 Alpine 的 busybox）时会明确报错，而不是给出错位的结果。\nglob 的"按修改时间排序"依赖 GNU find -printf，busybox 会退化成路径排序；含 / 的 include 在插件进程里过滤，因此那种调用会先扫描全部文件再筛。\n技能目录刷新仍是轮询：已发布目录内的增删改约 3 秒生效，而一个新项目里第一次出现的技能目录要等下一次完整重新发现（最多 30 秒）。\n0.1.0-rc.7 的宿主没有 Windows 进程检查器，PTY 持久 shell 无法启动（宿主自己也这样），插件回退到一次性 bash：能正常用，但 cd / export 不跨调用保留。\n极简模式本身不挂 job_* 工具，所以那个模式里也没有 bash_background（与宿主的极简模式一致）。\n在 DSH Desktop 上，持久 shell 跑的是 Desktop 自带的那个 node（`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`）——Desktop 自己在启动时会 stat 这个文件，缺了就直接 `DesktopHostFatalError`，所以这条路径不是猜的。\n实测把它改名后，解析链会退到 PATH 上的 node（日志里写 `"node.exe" on PATH`）；只有连 PATH 也没有 node 时才退回 Electron 可执行文件，那时 bash 会以 PTY shell exited during startup 失败，启动日志里写明选中的解释器与被拒绝的候选。\n文件引用的翻译只认插件自己认定为 WSL 的会话：工作区必须注册成 WSL 工作区（对话框创建的都会注册），否则地址原样不动。\n发行版内的绝对路径还需要知道发行版：UNC 工作区自带，/mnt/<盘符> 工作区取自 wsl-workspaces.json 的记录；那条记录删掉后这类引用不再翻译。/mnt/<盘符> 不受影响——盘符就是盘符。',
  'help.footer.npm': 'npm 包',
  'help.footer.repo': 'GitHub 仓库',
}

/**
 * The `wslWorkspace` translations (English).
 */
export const en: Record<string, string> = {
  'action.add': 'WSL Workspace',
  'action.title': 'Add WSL workspace…',

  'dialog.title': 'Add WSL workspace',
  'dialog.distro': 'Distro',
  'dialog.path': 'Path',
  'dialog.pathPlaceholder': '/home/',
  'dialog.username': 'Username',
  'dialog.usernamePlaceholder': 'Leave empty to use the distro default user',
  'dialog.loading': 'Loading…',
  'dialog.browseEmpty': 'No subdirectories here',
  'dialog.upLevel': '.. (up)',
  'dialog.browse': 'Browse',
  'dialog.check': 'Check',
  'dialog.confirm': 'Create & open',
  'dialog.cancel': 'Cancel',
  'dialog.retry': 'Retry',

  'error.loadDistros': 'Could not list WSL distros; confirm WSL is installed and the plugin host side is reachable',
  'error.rateLimited': 'Too many attempts; retry in a moment',
  'error.loadDir': 'Could not browse this directory',
  'error.presetMissing': 'No healthy "wsl" preset found; confirm the plugin host side installed and configured it',
  'error.presetPending': 'The wsl variants are still being generated; retry in a moment, and read the host log if none appear',
  'error.presetBroken': 'Some wsl variants did not publish:',
  'error.presetBrokenOne': '• ',
  'error.presetBrokenMore': '… further failures not listed: ',
  'error.invalidPath': 'Enter an absolute Linux path starting with /',
  'error.invalidUsername': 'Invalid username: start with a letter or underscore; only letters, digits, _ . -',
  'error.pathNotFound': 'The path does not exist or is a file; choose a folder',
  'error.createFailed': 'Failed to create the workspace',
  'help.button': 'About this plugin',
  'help.greeting': 'If you can read this, the plugin has already Cia~llo\'d its way in～(∠・ω< )⌒★ Care to star the repo?',
  'help.greeting.repo': 'github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace',

  'help.compat.title': 'Compatibility',
  'help.compat.versionLabel': 'Plugin version',
  'help.compat.unknown': 'Version and compatibility declaration unavailable (the host side did not answer)',
  'help.compat.body': 'The chips above are the DSH releases this build declares, each verified on an isolated instance (own DSH_HOME, dependencies pinned to that release, full check suite).\nThe plugin detects the DSH generation at runtime and picks the matching API; a release exposing neither fails loudly instead of leaving an empty workspace.\nA release outside the list usually still works, but is unverified.',
  'help.news.title': "What's new in 0.7.6",
  'help.news.body': 'Fixed DSH Desktop reporting no healthy wsl preset while generating not a single WSL variant (issue #47).\nThe generator used to borrow the entry-list dialect and its YAML engine from the host at call time. Desktop ships the host inside an archive, and Node looks for a bare specifier by walking the filesystem upward, so that walk never reaches it.\nThe first source preset threw, the throw left the whole generation loop, and the leftovers of the retired mechanism stayed where they were.\nThe engine is now a real dependency of this package, on the 4.x line, and the dialect is built inside the plugin from that same engine namespace, so schema and loader can no longer come from different majors. Which release a sibling plugin hoisted into the profile no longer decides whether variants can be generated.\nOne unreadable source is now one variant\'s own failure: the other variants still publish, the stale-directory sweep still runs, and an engine problem reports the package, version and path it actually resolved.\nNew gate npm run test:profile builds profile-shaped trees under the temp dir and boots the plugin\'s own copy inside them, including the release the host umbrella does not carry; the install gate now asserts that the runtime surface is present rather than certifying that it is absent.\nFile references preview again (issue #49). The conversation\'s file links, a tool row\'s line reference and the turn tail\'s changed files open through the right Sidebar, and the address carries the path exactly as the model wrote it - a Linux path.\nThe host resolves that with node:path.resolve(cwd, path), where a POSIX absolute path is root-relative: /mnt/d/x landed on the workspace drive, and an in-distribution path under the cwd share\'s root.\nThe client half now translates the address first: /mnt/<drive>/... back to X:\\..., and every other Linux path through the distribution\'s UNC share.\nThe distribution comes from the session\'s UNC workspace, or from the record stored for a /mnt/<drive> workspace (a new host route, listWorkspaceRecords).\nA session the plugin does not treat as WSL-bound, an address it cannot rebuild byte-for-byte, or one whose distribution is unknown, is passed through untouched.\nOnly 0.1.5-rc.1 and later ship a right Sidebar and a document preview; the six earlier declared releases get no hook.',
  'help.usage.title': 'Usage and features',
  'help.usage.body': 'Click the W button at the sidebar foot, pick a distribution, type or browse to a Linux path, press Check, then Create & open.\nIn that session the bash tool and the file tools run inside the distribution, so every path the model sees is a Linux path; Windows drives stay reachable as /mnt/<drive>.\nEach mode (Standard / PTC / Minimal / Creator) has a WSL variant in the mode picker, named like WSL · Standard mode.\nThe optional username behaves like wsl.exe -u <user> for bash and persistent-bash; the file tools go through the Windows-side share and are unaffected.\nThe skill catalog is discovered from the nearest .git ancestor of the session cwd downwards (.dsh/skills and .agents/skills, nested projects included), bounded to 4 levels / 64 skill directories / 4096 visited directories, and cached per scan root for 10 seconds.\nA link the share cannot follow is resolved through the distribution (wsl.exe readlink, at most 32 per lookup) and the scan continues at the real path, so a linked-in project and its own nested projects are found too.\nThe catalog is not frozen: published skills directories are re-checked every 3 seconds (skill file mtime + size), so an add, remove or edit appears on the next turn; a 30-second walk finds a skills directory that did not exist before.\nFile search comes from grep / glob inside the distribution, and a mode that mounts no search suite (Minimal) gains none. grep is GNU grep -E (no lookaround or backreferences), skips hidden entries and node_modules, and does not read .gitignore; glob matches gitignore-style patterns here, oldest first.\nThe file tools work at the resolved real path of a link, and the policy is judged there too: a link out of the workspace is an outside write.\n`bash` is a PTY-backed stateful shell: login environment, starting directory the session workspace, and cd / exports / background jobs survive between calls.\nFor a tracked background job use bash_background: it returns a job id immediately, and job_list / job_output (incremental) / job_kill act on it.\n`bash` itself has no run_in_background parameter and ignores one; job ids are unique within this DSH process, so confirm with job_list before acting on one.\nBoth it and the file tools\' shell run inside the distribution, outside the DSH file policy; read/write/edit are inside it, and workspace-write only writes inside the workspace.',
  'help.known.title': 'Known issues',
  'help.known.body': 'grep is the distribution\'s GNU grep: POSIX ERE (no lookaround or backreferences), and it does not read .gitignore, so git-ignored files are searched too; only hidden entries, node_modules and VCS directories are skipped.\nglob\'s modification-time order needs GNU find -printf (busybox falls back to path order), and an include containing "/" is filtered in this process, so that call scans every file first.\nThe catalog refresh is still a poll: an add, remove or edit inside a published skills directory lands within about 3 seconds, while a new project\'s first skills directory waits for the next full re-discovery (up to 30 seconds).\n0.1.0-rc.7 has no Windows process inspector, so its PTY persistent shell cannot start (the host has the same gap) and the plugin falls back to a one-shot bash: it works, but cd / exports do not survive.\nMinimal mode mounts no job_* tools, so it gets no bash_background either - the same as the host\'s own Minimal mode.\nOn DSH Desktop the persistent shell runs on the node bundled with the Desktop (resources/runtime/primary-runtime/dependencies/node/bin/node.exe). The Desktop stats that file at boot and dies with DesktopHostFatalError without it, so the path is not a guess.\nRenaming it away made the resolution fall through to a node on PATH ("node.exe" on PATH, in the log); only with no node anywhere does it fall back to the Electron executable, where bash fails with "PTY shell exited during startup" and the log names every rejected candidate.\nReference translation only applies to sessions the plugin itself recognizes as WSL ones: the workspace must be registered as a WSL workspace (everything the dialog creates is), otherwise addresses are left alone.\nAn in-distribution absolute path also needs the distribution: a UNC workspace carries it, a /mnt/<drive> workspace takes it from the record in wsl-workspaces.json, and deleting that record stops those references from being translated. /mnt/<drive> paths are unaffected - the mount name is the drive.',
  'help.footer.npm': 'npm package',
  'help.footer.repo': 'GitHub repository',
}

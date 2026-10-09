# dsh-wsl-workspace

[![dsh.so security](https://www.dsh.so/badge/dsh-wsl-workspace.svg)](https://www.dsh.so/artifact/dsh-wsl-workspace)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-wsl-workspace.svg)](https://www.dsh.so/artifact/dsh-wsl-workspace)

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md)

![alt text](https://raw.githubusercontent.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/HEAD/image-3.png)
DeepSeek Harness Web GUI에서 WSL 워크스페이스를 추가하고 에이전트 세션 전체(bash 명령과 파일 읽기/쓰기)를 로컬 WSL 배포판 안에서 실행합니다. 모든 경로는 Linux 형식이며, WSL 내부에 별도로 설치할 것이 없습니다. 세션에서 WSL과 Windows 양쪽에 동시에 접근할 수 있습니다. bash 명령은 WSL 배포판 안에서 실행되고, Windows 파일은 `/mnt/<drive>`(예: `/mnt/c/Users/...`)로 언제든 접근할 수 있습니다.

지원하는 DSH 버전 목록은 [README.md](README.md)의 Compatibility 섹션을 참고하세요.

## 설치

아래 세 가지 방법 중 하나를 선택한 뒤 `dsh web`을 다시 시작하세요:

```powershell
# 1) npm 패키지
dsh plugin --profile web add dsh-wsl-workspace

# 2) GitHub 저장소(사전 빌드된 lib/ 포함, 로컬 빌드 불필요)
dsh plugin --profile web add https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

# 3) 로컬 디렉터리(개발/개인용)
dsh plugin --profile web add D:\path\to\dsh-wsl-workspace
```

`dsh web`을 다시 시작하면 사이드바 하단 Settings 옆에 W 버튼이 나타납니다.

## 사용법

사이드바 하단 Settings 옆의 W 버튼을 클릭해 "Add WSL workspace" 대화상자를 엽니다. 배포판을 선택하고 디렉터리 트리를 탐색하거나 Linux 절대 경로(예: `/home/me/proj`)를 입력하세요. Check 버튼으로 경로 존재 여부를 확인할 수 있습니다. 대화상자 언어는 DeepSeek Harness UI 언어를 따릅니다. 사용자 이름 필드는 선택 사항입니다. 비워 두면 배포판의 기본 사용자로 실행되고, 입력하면 해당 사용자로 실행됩니다(`wsl.exe -u <사용자 이름>`과 동일). 사용자 이름은 bash 도구의 실행 사용자에게만 영향을 주며, 파일 도구는 Windows 쪽 WSL 공유를 거치므로 영향을 받지 않습니다. 워크스페이스별 사용자 이름은 `<dshHome>/wsl-workspaces.json`에 저장됩니다. 항목을 삭제하거나(또는 대화상자에서 워크스페이스를 다시 만들면) 기본 사용자로 돌아갑니다.

"Create & open"을 클릭하면 새 세션이 WSL에서 시작됩니다. 세션에서 bash 도구는 선택한 배포판 안에서 명령을 실행하고 `read`/`write`/`edit`는 WSL 파일을 다루므로 모델이 보는 모든 경로는 Linux 형식입니다. 모드 선택은 평소와 같이 작동합니다. Standard, PTC, Minimal, Creative는 각각 해당하는 WSL 변형으로 자동 연결됩니다(선택기의 WSL 변형 항목은 이중 언어로 표시, 예: `WSL · Standard mode（标准模式）`). 세션 안에서도 Windows 파일은 `/mnt/<drive>`(예: `/mnt/c/Users/...`)로 접근할 수 있습니다.대화상자 우측 상단의 '?' 버튼은 이 빌드가 선언하는 DSH 릴리스, 플러그인 사용법, 그리고 우회할 수 없는 알려진 제한을 보여주는 패널을 엽니다.

![alt text](https://raw.githubusercontent.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/HEAD/image-2.png)
## 동작 참고

- **bash 도구**: 설정된 사용자 이름으로 WSL 배포판 안에서 실행됩니다(비움 = 배포판 기본 사용자, 대개 `root`). 배포판 어디든 읽고 쓸 수 있습니다. Windows ACL 샌드박스는 `wsl.exe`를 감쌀 수 없으며(자식 프로세스는 Linux 커널 쪽에서 실행됨), WSL 자체가 격리 경계가 되어 DSH 파일 정책은 bash에 적용되지 않습니다.
- **파일 도구(`read`/`write`/`edit`)**: Windows 쪽 WSL 9P 공유를 통해 동작하며, 사용자 이름 필드는 이들에 영향을 주지 않습니다. 호스트가 보통 제공하던 두 이음매가 WSL 세계 안에서 다시 성립합니다. **심볼릭 링크**: 공유는 Linux 링크를 나열할 수 있지만 해석하지 못하므로, `resolve`/`lstat`이 배포판에 실제 경로를 묻고(`wsl.exe … readlink -f`) 거기서 계속 진행하며, 링크가 일반 파일로 대체되는 일은 없습니다. **접근 모드**: `write`/`edit`는 `ctx.sandboxPolicy`로 가로막히는데, 호스트 백엔드와 완전히 같은 방식입니다 — 같은 `writableRoots` 허용 목록(여기에 배포판의 `/tmp` 추가), 도구 층이 거절로 렌더링하는 같은 `FS_SANDBOX_DENIED`, 그리고 권한 상승을 위해 읽는 같은 `sandboxMode`. 가로막기가 해석 뒤에 수행되므로 실제 경로를 판단합니다 — 워크스페이스 밖을 가리키는 링크는 밖으로 쓰는 것과 같고, `workspace-write`에서는 거절됩니다. 정책 서비스를 마운트하지 않은 배포에서는 가로막기도 일어나지 않습니다. 호스트와 동일합니다.
- **파일 검색(`grep`/`glob`)**: 호스트의 검색 스위트는 함께 번들된 *Windows* ripgrep을 실행하므로 Linux 경로를 열 수 없습니다. 그래서 WSL 세계는 자기 짝(`src/host/wsl-search.ts` → `lib/wsl-search.js`)을 마운트하고 검색을 **배포판 안**에서 수행합니다. 도구 이름, 파라미터 스키마, 상한, 출력 스키마(`Line N:` 그룹화, 검색 건수 헤더, 상한 도달 표시), 검색 카드와 넘친 결과의 파일 담기는 전부 `@deepseek-ai/dsh-tool-fs-search`가 직접 export하는 부품을 사용하며, 모델이 보는 것이 호스트와 일치합니다. `grep`은 배포판의 GNU grep(`-rnIEH -Z`, POSIX ERE: `\d`, `\w`, `(?i)` 사용 가능, 앞뒤 찾기·역참조 불가)을 쓰고, ripgrep 기본값처럼 숨김 항목과 `node_modules`을 건너뛰며, `.gitignore`는 **읽지 않습니다**. `glob`은 GNU `find`로 나열하고(`-printf`가 파일마다 stat 없이 수정 시간을 알려 줌) gitignore 스타일 패턴(`*`는 구분자를 넘지 않음, `**`는 넘음, `?`, `[...]`, `{a,b}`, 선두 `!` 부정)을 플러그인 프로세스에서 매칭하며, `rg --sort=modified`와 똑같이 오래된 것부터 정렬합니다. 둘 다 9P 공유가 아닌 Linux 트리를 직접 검색하고, 재귀 중 발견한 심볼릭 링크를 따르지 않습니다(역시 ripgrep 기본값). 원본 프리셋에 검색 스위트가 없는 모드(Minimal)에는 두 도구가 생기지 않습니다.
- **스킬 카탈로그**: 세션 cwd에서 가장 가까운 `.git` 조상(없으면 cwd 자체)에서 시작해 `.dsh/skills` / `.agents/skills`을 아래로 훑으며 중첩 프로젝트도 포함하고, 4개 디렉터리 층·스킬 디렉터리 64개·방문 디렉터리 4096개로 제한합니다 — 실제로 작업하는 프로젝트 최상위에 워크스페이스를 등록하세요. 등록한 워크스페이스 자체가 더 큰 git 저장소 안에 있으면 훑기는 그 저장소 최상위에서 시작되어(호스트의 규칙과 동일) 형제 프로젝트가 보일 수 있습니다. Windows 쪽 공유가 해석하지 못하는 Linux 심볼릭 링크는 배포판으로 해석하고(`wsl.exe … readlink -f`, 검색당 최대 32건, 4건 병렬) 실제 경로에서 계속 훑기 때문에, `ln -s`로 링크된 프로젝트와 그 아래 중첩 프로젝트도 발견되고 실제 경로로 중복 제거됩니다. UNC 경로의 파일 감시는 실패하므로 생성된 preset은 `skill-filesystem` 행에 `watch: false`를 고정하고, 플러그인이 대신 폴링합니다. 3초마다 이미 게시한 스킬 디렉터리를 확인해 스킬 파일의 수정 시각과 크기를 재계산하므로, **추가·삭제·수정**된 스킬이 모델의 다음 턴에 반영됩니다. 30초마다 전체 재탐색 훑기가 돌는데, 이전에 없던 스킬 디렉터리는 훑어야만 발견되기 때문입니다. 스킬 본문은 항상 실시간으로 로드됩니다.
- **셸 수명**: `bash`는 **상태 유지** 셸입니다 — `cd`, export한 변수, 활성화한 virtualenv, 백그라운드 작업이 호출 사이에 유지됩니다. WSL 세계는 호스트의 PTY 레지스트리와 config로 구동되는 백엔드(`@deepseek-ai/dsh-terminal-bash`)를 마운트하고 이를 이 플러그인의 relay(`src/host/wsl-relay.ts` → `lib/wsl-relay.js`, 호스트의 node가 실행)로 향하게 하며, relay는 PTY를 `wsl.exe … bash`에 넘깁니다. 배포판은 세션의 UNC cwd에서(없으면 `DSH_WSL_DISTRO`), 선택적 사용자 이름은 `DSH_WSL_USER`에서 얻고, `bash -lc 'cd … && exec bash -i'`를 실행해 로그인 환경을 불러들이면서 세션 디렉터리를 보존합니다(plain `bash -l`은 profile이 `$HOME`으로 보낼 수 있음). 이 도구는 `bash` 이름을 등록하므로 non-WSL preset의 일회성 `dsh-tool-bash` 행을 대체하고, 세계는 자기 no-op `sandbox` 역량(`src/host/wsl-sandbox.ts`)도 제공합니다 — Windows ACL runner는 `\wsl.localhost\…` 경로의 보안 기술자를 읽을 수 없고 PTY 백엔드는 생성 전에 그것으로 격리하기 때문입니다. 두 셸 모두 배포판 안에서 실행되며 DSH 파일 정책 밖에 있습니다 — WSL이 격리 경계입니다. **호스트의 감싸기에서 나오는 두 결과는 도구 설명에 명시**했습니다: 셸은 에이전트 전체에 하나의 프로세스이므로 어떤 호출의 `cd`가 다음 호출의 시작을 결정합니다 — 절대 경로나 명시적 `cd`를 쓰세요. 그리고 호스트는 각 명령을 `eval -- $'…'`로 감싸므로, `&`로 끝나는 명령은 **감싸진 명령 전체**를 백그라운드로 돌려 호출은 즉시 exit code 0·출력 없이 반환되고 진짜 출력은 늦게(다음 호출 출력 안일 수도) 도착합니다. 백그라운드 작업은 한 줄에 `( long-job > log 2>&1 ) &` 형태로 쓰거나 백그라운드 작업 도구를 쓰세요.
- **터미널에 입력하기(`wsl_terminal`)**: 파이프에는 입력할 수 없으므로, 질문을 하는 프로그램 — 비밀번호를 원하는 `sudo`, 첫 연결 지문을 묻는 `ssh`, REPL, 편집기, TUI — 에게 에이전트가 줄 답이 없었습니다. 대기를 읽어 멈추고 일회성 의사 터미널로 다시 실행해 프로그램의 불평까지만 읽을 수 있었고, 나머지는 사람이 넘겨받아야 했습니다. 이제 세계는 에이전트가 입력할 수 있는 문을 함께 마운트합니다: `open`이 대화형 터미널을 열고, `send`가 글자를 입력하며(기본 Enter, `submit: false`면 입력만), `read`가 보존된 화면을 넘겨 보고, `signal`이 `SIGINT`/`SIGTERM`/`SIGKILL`/`SIGTSTP`/`SIGHUP`(`SIGINT`가 Ctrl-C)을 보내고, `close`가 닫고, `list`가 열린 터미널을 알려 줍니다. 이것은 호스트의 PTY 레지스트리와 `dsh-terminal-bash` 백엔드를 이 플러그인의 relay에 연결한 것 — 오른쪽 사이드바 터미널 탭 뒤의 바로 그 기계이며, 키보드에 사람 대신 에이전트가 앉을 뿐입니다. 그 셸은 **워크스페이스에 설정된 사용자**로 실행됩니다(호스트가 PTY 자식의 환경을 직접 만들어 `DSH_*`를 모두 떨어뜨리므로, 사용자는 워크스페이스 저장소에서 되읽습니다). 나머지는 위의 파이프 `bash`가 기본입니다: 파이프는 모든 바이트를 나르고, 터미널 화면은 160열 렌더링과 한정된 스크롤백일 뿐입니다. 세 가지 비용을 숨기지 않고 적습니다: 백엔드의 무음 창을 기본 3000 ms에서 1200 ms로 낮췄고(출처 주석은 `src/host/variants.ts`), 프롬프트를 인식하지 못한 전송은 약 1.2~1.8초에 돌아옵니다(기본이면 약 3.0~3.6초); `send`는 어느 경로로 끝났는지 말하며 조용한 화면을 프롬프트라고 하지 않습니다; 입력한 내용은 대화 기록의 일부이므로 비밀번호는 사용자에게서 받아야 합니다. 실제 배포판 측정(두 빌드 평면 × `root`/`ruler`, `bash-session-real` 66/66 셀): `open` 477~490 ms, 입력한 명령이 답하고, `/dev/tty`에서 막힌 프로그램에 **키 입력이 도달하며**(`GOT=…`), `submit: false`는 실행하지 않고 다음 Enter가 실행하고, `SIGINT`가 `sleep 30`을 끝내고 셸은 살아남고, `close` 뒤에 `bash -i`가 남지 않습니다.
- **추적 가능한 백그라운드 작업**: `bash_background`는 명령 하나를 백그라운드로 시작해 레지스트리 job id를 즉시 반환하고, 이후 호스트의 `job_list`, `job_output`(증분 읽기·상태 전이·완료 공지), `job_kill`가 그대로 작용합니다. 이 행이 존재하는 이유는 영속 셸의 스키마가 `command`만 선언하기 때문입니다 — 만드는 쪽이 없으면 `job_list`는 항상 'no background jobs'로 답하고, `bash`에 넘긴 `run_in_background: true`는 조용히 무시됩니다(파라미터 스키마가 추가 속성을 금지하지 않아 아무도 오류를 알리지 않았습니다). 실제 세션이 바로 그 결함을 찾아냈습니다. 이 도구는 영속 셸과 함께 마운트될 때만 존재하며, 일회성 bash 행을 유지하는 세계는 그 도구 자체에 `run_in_background`가 있습니다.
- **오래된 호스트는 일회성 셸로 폴백**: 영속 스택은 **호스트** 코드이고, Windows에서는 `0.1.0-rc.8`부터 존재하는 플랫폼 프로세스 검사기가 필요합니다. `0.1.0-rc.7`에서는 `spawnTerminal`이 어떤 프로세스도 시작하기 전에 `subprocess-local: terminal inspection is unsupported on platform win32`를 던져 해당 릴리스의 **모든 `bash` 호출이 실패**합니다(PTY를 타지 않는 grep/glob는 계속 동작). 따라서 플러그인은 가정 대신 시작 시 받침대를 **탐지**합니다. 존재할 수 없는 프로그램을 `spawnTerminal`에 넘기면 검사기 확인에만 도달하고 그 외에는 닿지 않으며, 어느 쪽이든 프로세스는 생성되지 않고 거부 사유가 어느 절반이 실패했는지 알려줍니다. 답이 '검사기 없음'이면 생성된 세계는 일회성 `dsh-tool-bash` 행(이 플러그인 자신의 `ctx.shell`, PTY 경유하지 않음)을 유지하고, 모델은 매 호출 오류 대신 동작하는 무상태 셸을 받습니다. 선언된 릴리스 중 그런 상태인 것은 `0.1.0-rc.7` 하나이고, 이후 릴리스는 모두 영속 셸을 받습니다.
- 배포판이 아직 시작되지 않았을 때 `wsl.exe`가 stderr로 출력하는 `localhost` 포트 포워딩 깨진 배너는 무해합니다.

## 변경 이력

전체 릴리스 이력(최신순)은 [CHANGELOG.md](CHANGELOG.md)에 있습니다(중국어: [CHANGELOG.zh.md](CHANGELOG.zh.md)). 이 README는 위에 설명한 현재의 동작만 다룹니다.

## 문서

어떤 문서가 어디에 어떤 언어로 놓였고 어디까지 최신인지의 목록은 [docs/README.md](docs/README.md)(영어 색인)에 있습니다 — [설계 기록(zh)](docs/design.zh.md), `dsh.compatibility.dshReleases` 선언을 뒷받침하는 [릴리스별 호환성 근거](docs/compatibility-evidence.md), 그리고 대체되어 [docs/archive/](docs/archive/)에 보존된 과거 결론. 변경·출시 전 검증 절차는 [TESTING.md](TESTING.md).

## 라이선스 및 출처

MIT — [LICENSE](LICENSE)와 [NOTICE](NOTICE)를 참고하세요. NOTICE에 정확한 목록이 있습니다:

- **개작/계승한 소스 코드**: DeepSeek Harness(MIT) — `dsh-bash-local`(실행 메커니즘), `dsh-fs-local`(`WslFileSystem`이 서브클래싱), 번들 agent presets(변형 생성에서 읽고 변환);
- **설계 참조(코드 복제 없음)**: [dsh-bash-terminal](https://github.com/MAXeaglet/dsh-bash-terminal)(MIT, wsl argv/WSLENV 방식), [dsh-side-panel](https://github.com/ccq1/dsh-side-panel)(BSD-3-Clause, 호스트 라우트 패턴), [vpshub](https://github.com/Sdongmaker/vpshub)(MIT, 로드맵 참고).

재배포 시 `LICENSE`와 `NOTICE`를 유지하세요.

## 감사의 말

[dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale)(DSH Web 鲸鱼娘 스킨 시리즈 · 深海女仆工坊 maid-atelier, CC BY-NC-SA 4.0)에 특별히 감사드립니다. 고래 소녀 스킨 플러그인은 DeepSeek Harness Web UI에 귀여운 스킨 세트를 제공하며 DSH 사용을 더 따뜻하게 만들어 줍니다.

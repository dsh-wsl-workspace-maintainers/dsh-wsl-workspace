# dsh-wsl-workspace

[![dsh.so security](https://www.dsh.so/badge/dsh-wsl-workspace.svg)](https://www.dsh.so/artifact/dsh-wsl-workspace)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-wsl-workspace.svg)](https://www.dsh.so/artifact/dsh-wsl-workspace)

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md)

![alt text](https://raw.githubusercontent.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/HEAD/image-3.png)
DeepSeek Harness Web GUI から WSL ワークスペースを追加し、エージェントセッション全体（bash コマンドとファイルの読み書き）をローカルの WSL ディストリビューション内で実行します。パスはすべて Linux 形式です。WSL 内への追加インストールは不要です。セッションから WSL と Windows の両方に同時にアクセスできます。bash コマンドは WSL ディストリビューション内で実行され、Windows のファイルは `/mnt/<drive>`（例：`/mnt/c/Users/...`）経由でいつでもアクセスできます。

対応する DSH バージョンの一覧は [README.md](README.md) の Compatibility を参照してください。

## インストール

次のいずれかの方法でインストールし、`dsh web` を再起動してください：

```powershell
# 1) npm パッケージ
dsh plugin --profile web add dsh-wsl-workspace

# 2) GitHub リポジトリ（事前ビルド済みの lib/ を含むためローカルビルド不要）
dsh plugin --profile web add https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

# 3) ローカルディレクトリ（開発・自用）
dsh plugin --profile web add D:\path\to\dsh-wsl-workspace
```

`dsh web` を再起動すると、サイドバー下部の Settings の隣に W ボタンが表示されます。

## 使い方

サイドバー下部の Settings の隣にある W ボタンをクリックして「Add WSL workspace」ダイアログを開きます。ディストリビューションを選択し、ディレクトリツリーを閲覧するか Linux の絶対パス（例：`/home/me/proj`）を入力します。Check ボタンでパスの存在を確認できます。ダイアログの言語は DeepSeek Harness の UI 言語に追従します。ユーザー名フィールドは任意です。空欄の場合はディストリビューションのデフォルトユーザーで実行され、入力した場合はそのユーザーで実行されます（`wsl.exe -u <ユーザー名>` と同等）。ユーザー名は bash ツールの実行ユーザーのみに影響し、ファイルツールは Windows 側の WSL 共有経由のため影響を受けません。ワークスペースごとのユーザー名は `<dshHome>/wsl-workspaces.json` に保存されます。エントリを削除する（またはダイアログからワークスペースを作り直す）とデフォルトユーザーに戻ります。

「Create & open」をクリックすると、新しいセッションが WSL で起動します。セッション内では bash ツールが選択したディストリビューション内でコマンドを実行し、`read`/`write`/`edit` は WSL のファイルを操作するため、モデルが見るすべてのパスは Linux 形式です。モード選択は従来どおり機能します。Standard・PTC・Minimal・Creative はそれぞれ対応する WSL バリアントに自動的に割り当てられます（選択肢の WSL バリアントは二言語表示、例：`WSL · Standard mode（标准模式）`）。セッション内から Windows のファイルは `/mnt/<drive>`（例：`/mnt/c/Users/...`）経由でアクセスできます。ダイアログ右上の「?」ボタンは、このビルドが宣言する DSH のリリース、プラグインの使い方、そして回避できない既知の制限を表示するパネルを開きます。

![alt text](https://raw.githubusercontent.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/HEAD/image-2.png)
## 動作メモ

- **bash ツール**：設定されたユーザー名で WSL ディストリビューション内で実行されます（空欄＝ディストリビューションのデフォルトユーザー、多くの場合 `root`）。ディストリビューション内のどこでも読み書きできます。Windows の ACL サンドボックスは `wsl.exe` を包み込めません（子プロセスは Linux カーネル側で実行されるため）。WSL 自体が分離境界となり、DSH のファイルポリシーは bash には適用されません。
- **ファイルツール（`read`/`write`/`edit`）**：Windows 側の WSL 9P 共有経由で動作し、ユーザー名フィールドは影響しません。宿主が通常用意する 2 か所の仕組みは、WSL ワールドの中で再確立されています。**シンボリックリンク**: 共有は Linux のリンクを列挙できますが解決はできないため、`resolve`/`lstat` はディストリビューションに実パスを問い（`wsl.exe … readlink -f`）、そこから処理を続けます。リンクが通常ファイルに置き換えられることはありません。**アクセスモード**: `write`/`edit` は `ctx.sandboxPolicy` によって、宿主バックエンドとまったく同じ方式で囲い込まれます — 同じ `writableRoots` 許可リスト（加えてディストリビューションの `/tmp`）、同じ `FS_SANDBOX_DENIED`（ツール層が拒否として描画）、同じ `sandboxMode`（ツールがエスカレーションのために読む事実）。囲い込みは解決の後に走るので実パスを判定します — ワークスペース外を指すリンクはワークスペース外への書き込みであり、`workspace-write` では拒否されます。ポリシーサービスをマウントしないデプロイでは囲い込みも行われません。宿主と同じです。
- **ファイル検索（`grep`/`glob`）**：宿主の検索スイートは同梱された *Windows* 版 ripgrep を起動しますが、それは Linux パスを開けません。そこで WSL ワールドは自前の対応物（`src/host/wsl-search.ts` → `lib/wsl-search.js`）をマウントし、検索を**ディストリビューションの内側**で実行します。ツール名・スキーマ・上限・出力フォーマットは `@deepseek-ai/dsh-tool-fs-search` がエクスポートする部品をそのまま使うため、モデルが見るものは宿主と一致します。`grep` はディストリビューションの GNU grep を使います（POSIX ERE — `\d`、`\w`、`\b`、`(?i)` は利用可、先読みと後方参照は不可）、隠しファイルと `node_modules` を飛ばし、`.gitignore` は**読みません**。`glob` は GNU `find` で列挙し、gitignore 風パターンにマッチします（`*` は区切りを跨がない、`**` は跨ぐ、`{a,b}`、先頭の `!` は否定）、古い順に並びます。どちらも再帰中に見つけたシンボリックリンクをたどりません。元のプリセットが検索スイートを持たないモード（Minimal）には、これらのツールは現れません。
- **スキルカタログ**：セッションの cwd に最も近い `.git` の祖先（なければ cwd 自体）から下方向に `.dsh/skills` と `.agents/skills` を走査し、入れ子プロジェクトも拾います。上限はディレクトリ 4 階層・スキルディレクトリ 64 個・訪問ディレクトリ 4096 個なので、ワークスペースは実際に作業するプロジェクトのルートに登録してください。Windows 側共有が解決できない Linux シンボリックリンクはディストリビューション経由で解決するため、`ln -s` でリンクされたプロジェクト（とその配下の入れ子プロジェクト）も発見されます。`\\wsl.localhost\…` パスの監視は失敗するので、プラグインは代わりにポーリングします。軽い方は 3 秒ごとに公開済みのスキルファイルの更新時刻とサイズを確認し直すため、**追加・削除・書き換え**のいずれもモデルの次のターンに届きます。完全な再走査は 30 秒ごとに実行されます — これまで存在しなかったスキルディレクトリを見つけられるのは走査だけだからです。スキル本文は常にリアルタイムで読み込まれます。
- **シェルの寿命**：`bash` は**ステートフル**なシェルです — `cd`、export した変数、有効化した virtualenv、バックグラウンドジョブが呼び出しをまたいで生き残ります。ワールドは宿主の PTY レジストリと設定駆動バックエンド（`@deepseek-ai/dsh-terminal-bash`）をマウントし、本プラグインの中継（`src/host/wsl-relay.ts` → `lib/wsl-relay.js`）へ向けます。中継は PTY を `wsl.exe … bash` に引き渡します。両方のシェルはディストリビューションの内側で動き、DSH のファイルポリシーの及ばない場所で実行されます — つまり WSL 自体が隔離境界です。宿主のラップによる 2 つの帰結はツールの説明に明文化されています。シェルはエージェント全体で 1 プロセスなので、ある呼び出しでの `cd` が次回の開始位置を決めます（絶対パスを使ってください）。また宿主は各コマンドを `eval -- $'…'` に包むため、`&` で終わるコマンドは**包まれたコマンド全体**をバックグラウンドに回し、呼び出しは出力なしで即座に exit code 0 で返ります。バックグラウンド作業は `( 長いジョブ > log 2>&1 ) &` を独立した 1 行として書くか、バックグラウンドジョブツールを使ってください。
- **端末への入力（`wsl_terminal`）**：パイプには打ち込めないため、質問するプログラム — パスワードを求める `sudo`、初回接続の指紋を尋ねる `ssh`、REPL、エディタ、TUI — にはエージェントが与えられる答えがありませんでした。待ちを読んで停止し、使い捨ての擬似端末で再実行してプログラム自身の文句を読むところまでで、あとは人に渡すしかありませんでした。いま世界はエージェントが打ち込める扉をマウントします：`open` で対話端末を開き、`send` で文字を打ち（既定で Enter、`submit: false` なら打つだけ）、`read` で保持された画面をページングし、`signal` が `SIGINT`/`SIGTERM`/`SIGKILL`/`SIGTSTP`/`SIGHUP`（`SIGINT` は Ctrl-C）を送り、`close` で閉じ、`list` が開いている端末を報告します。これは宿主の PTY レジストリと `dsh-terminal-bash` バックエンドを本プラグインの中継に向けたもの — 右サイドバーの端末タブの背後にあるのと同じ機構で、キーボードに人が座る代わりにエージェントが座るだけです。そのシェルは**ワークスペースに設定されたユーザー**で動きます（宿主は PTY 子プロセスの環境を自分で組み立て `DSH_*` をすべて落とすため、ユーザーはワークスペースストアから読み戻します）。それ以外は上記のパイプ `bash` が既定のままです：パイプは全バイトを運び、端末画面は 160 列の描画と有限のスクロールバックにすぎません。3 つのコストは隠さず書きます：バックエンドが無音を許す窓は既定 3000 ms から 1200 ms に下げ（出典注は `src/host/variants.ts`）、プロンプトを認識できない送信は約 1.2〜1.8 秒で戻ります（既定なら約 3.0〜3.6 秒）；`send` はどちらの経路で確定したかを述べ、静かな画面をプロンプトとは呼びません；打ち込んだ内容は会話の記録に残るため、パスワードはユーザーから受け取る必要があります。実ディストリビューションでの実測（両ビルド平面 × `root`/`ruler`、`bash-session-real` 66/66 セル）：`open` 477〜490 ms、打ち込んだコマンドが答える、`/dev/tty` でブロックしたプログラムに**打鍵が届く**（`GOT=…`）、`submit: false` は実行せず次の Enter が実行する、`SIGINT` が `sleep 30` を終わらせシェルは生き残る、`close` 後に `bash -i` が残らない。
- **追跡可能なバックグラウンドジョブ**：`bash_background` は 1 つのコマンドをバックグラウンドで開始し、レジストリの job id を即座に返します。その後、宿主の `job_list`、`job_output`（増分読み取り、状態遷移、完了通知）、`job_kill` がそのまま作用します。この行が存在するのは、永続シェルのスキーマが `command` だけを宣言しているためで、`bash` に渡された `run_in_background: true` は黙って無視されます（パラメータスキーマは追加のプロパティを禁止していません）。産む側がいなければ `job_list` は常に「バックグラウンドジョブはありません」と答えていました。実セッションでまさにその欠陥が見つかりました。このツールは永続シェルと一緒にマウントされる時だけ存在します。
- **古い宿主は一回限りのシェルにフォールバック**：永続スタックは*宿主*のコードであり、Windows では `0.1.0-rc.8` 以降にしかないプラットフォームのプロセス検査器を必要とします。`0.1.0-rc.7` では `bash` の呼び出しがすべて失敗します。そこでプラグインは起動時に土台を**プローブ**します。存在し得ないプログラムを `spawnTerminal` に渡すと、検査器のチェックにだけ到達し、プロセスはどちらの場合も生成されません。回答が「検査器なし」のとき、生成されたワールドは一回限りの `dsh-tool-bash` の行（本プラグイン自身の `ctx.shell`、PTY を経由しない）を保ち、モデルは毎回エラーではなく、使えるステートレスなシェルを得ます。
- ディストリビューションがまだ起動していないときに `wsl.exe` が stderr に出力する `localhost` ポート転送の文字化けバナーは無害です。

## 変更履歴

完全なリリース履歴（最新が最初）は [CHANGELOG.md](CHANGELOG.md) にあります（中国語: [CHANGELOG.zh.md](CHANGELOG.zh.md)）。この README が扱うのは上記の現時点の動作のみです。

## ドキュメント

どの文書がどこに、どの言語で置かれ、どこがまだ最新かは [docs/README.md](docs/README.md)（英語の索引）を参照してください — [設計記録（zh）](docs/design.zh.md)、`dsh.compatibility.dshReleases` の宣言を支える[バージョン別互換性エビデンス](docs/compatibility-evidence.md)、そして置き換えられて [docs/archive/](docs/archive/) に退避済みの文書。変更・リリース前の検証手順は [TESTING.md](TESTING.md)。

## ライセンスとクレジット

MIT — [LICENSE](LICENSE) と [NOTICE](NOTICE) をご覧ください。NOTICE に正確なリストがあります：

- **改変・継承したソースコード**：DeepSeek Harness（MIT）— `dsh-bash-local`（実行機構）、`dsh-fs-local`（`WslFileSystem` がサブクラス化）、同梱の agent presets（バリアント生成で読み取り・変換）；
- **設計参照（コードの複製なし）**：[dsh-bash-terminal](https://github.com/MAXeaglet/dsh-bash-terminal)（MIT、wsl argv/WSLENV の手法）、[dsh-side-panel](https://github.com/ccq1/dsh-side-panel)（BSD-3-Clause、ホストルートパターン）、[vpshub](https://github.com/Sdongmaker/vpshub)（MIT、ロードマップ参考）。

再配布の際は `LICENSE` と `NOTICE` を保持してください。

## 謝辞

[dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale)（DSH Web 鲸鱼娘 スキンシリーズ · 深海女仆工坊 maid-atelier、CC BY-NC-SA 4.0）に感謝します。クジラ娘スキンプラグインは DeepSeek Harness Web UI に可愛いスキン一式をもたらし、DSH の日常利用をより温かみのあるものにしてくれます。

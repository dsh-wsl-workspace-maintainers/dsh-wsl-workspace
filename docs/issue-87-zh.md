# 修复记录：#87 —— `PERSONA_APPEND` 中的 `{{cwd}}` 未被注册

本文是 [issue #87](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/issues/87) 的中文修复记录：根因、改动、验证矩阵与复核方法。面向维护者的版本说明见 [CHANGELOG.zh.md](../CHANGELOG.zh.md)。

## 现象

所有 `wsl-*` 变体会话（`wsl-standard` / `wsl-ptc` / `wsl-cordis`）在 turn 1 step 1 直接失败，一次模型请求都发不出去：

```
Error: unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix"; registered variables: provider, model
    at interpolate (…/@deepseek-ai/dsh-system-prompt/lib/index.js:171:10)
    at renderPrompt (…/@deepseek-ai/dsh-system-prompt/lib/index.js:115:27)
    at ReactLoopAgent.step (…/@deepseek-ai/dsh-agent-loop/lib/index.js:1049:26)
```

`wsl-minimal` 不受影响——原因见下文「为什么只有三个变体中招」。

## 根因

`src/host/variants.ts` 的 `PERSONA_APPEND` 是：

```ts
const PERSONA_APPEND = ' Your working directory {{cwd}} is inside a WSL …'
```

`transformPresetForWsl()` → `appendPersona()` 把这句话写进 persona 面向模型的那个标量（按 `PERSONA_TARGET_FIELDS = ["suffix", "text", "prefix"]` 顺序探测）。

persona 是一份**模板**。`@deepseek-ai/dsh-system-prompt` 的 `interpolate()` 对每个 `{{name}}` 组都要求本次组装注册过同名变量，否则直接抛错：

```js
if (!Object.hasOwn(variables, name)) {
  throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: …`)
}
```

而 DSH 0.2.x 的 `system-prompt/assemble` 只注册 `provider` 与 `model`：

```js
variables: { ...assembled.variables, provider: selected.provider, model: selected.model }
```

工作目录已经移交给 working-directory 服务，由它把路径作为**字面用户上下文**给出——上游文档对此有明确要求：

> Custom persona templates must not depend on a built-in `{{cwd}}` variable: the loop does not register it, so unresolved references fail prompt assembly before any model request. … The working-directory service supplies directory text as literal user context.

于是本插件追加的那一个从句，恰好就是解析不了的那一个从句。persona 段位于 order 0，所以它不是「少一句话」，而是**整个变体在第一次模型请求之前就死了**。

### 这个变量是从哪来的

它继承自旧版 persona 原文 `Your working directory is {{cwd}}.`（见 [#22](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/issues/22)）。当时 `{{cwd}}` 还是已注册变量，插件只需在它后面接一句 WSL 说明。0.2.x 撤销注册后，上游 preset 自己删掉了那个从句，本插件没跟上——**这是插件与宿主的一次版本竞态，不是用户的配置错误**。

### 为什么只有三个变体中招

`wsl-minimal` 的 persona 带 `complete: true`，`appendPersona()` 不往里追加任何东西，所以它从头到尾没碰到那个组。这也是为什么 issue 里描述的「四个变体全挂」需要精确一点：**同中招的是共享同一套 transform 的三个变体**。

## 改动

一句话版本：**把组删掉，保留断言。**

```diff
-const PERSONA_APPEND = ' Your working directory {{cwd}} is inside a WSL …'
+const PERSONA_APPEND = ' Your working directory is inside a WSL …'
```

并补了注释，写明这里为什么不能出现 `{{…}}`——这个坑很容易被后人「顺手」加回来。

对模型来说，这句话传达的信息没有减少：它知道的仍然是「工作目录在 WSL 发行版里，bash 与文件读写用 Linux 路径，Windows 文件系统在 `/mnt/<drive>` 可达」。路径本身仍由拥有它的服务给出。

同时更新的配套文件：

| 文件 | 改动 |
| --- | --- |
| `src/host/variants.ts` | 源改动 + 因果注释 |
| `tests/variants.test.ts` | 5 处期望值（原断言「追加句里有 `{{cwd}}`」→ 改为断言它**不在**） |
| `tests/host-materialize.mjs` | 1 处正则 |
| `lib/index.js`、`lib/index.js.map` | `npm run build` 重建（仓库要求 `lib/` 与源码同步） |
| `CHANGELOG.md`、`CHANGELOG.zh.md` | 各一条 `Unreleased` / `未发布` |

测试夹具里的 `{{cwd}}` 一律**保留**：它们模拟的是旧版源 preset 的 `suffix` 字段，那是合法的模板输入，不该跟着改。

## 验证

没有停在单元测试上。我从本机安装的 `app.asar` 里解出**真实的四个 preset 组合**（standard / ptc / cordis / minimal），喂给修好的 `apply()`，再把每个生成的 `wsl-*` 变体里 persona 那个标量，交给 `@deepseek-ai/dsh-system-prompt` 自己的 `renderPrompt()`，且只带 `provider` / `model` 去渲染——即复现线上失败现场，而不是模拟它。

| 被测构建 | 结果 |
| --- | --- |
| 修复前的 `lib/`（pinned HEAD） | **3/4 失败**，报错与 issue 逐字相同 |
| 本分支 | **4/4 通过** |
| 本机已部署的那份 | 4/4 通过 |

负向对照能复现原始报错、正向全绿——这个对照才算数。

其余门：

| 检查 | 结果 |
| --- | --- |
| `verify-lib-sync --check-only` | OK，33 个文件全匹配 |
| `npm run build` 后 `git diff --quiet -- lib` | 通过，重建与提交**逐字节相同** |
| `npm run test:unit` | 224 tests / 223 pass / 0 fail / 1 skip |
| `variants.test.ts` 单跑 | 32/32 |
| `host-materialize.mjs` | PASSED |
| `npm run test:win32` | 48/48 |
| `npm run test:docs` | 11 项全绿 |

那个 skip 是仓库原有的（本机解析不到可选的 `@deepseek-ai/dsh-util-workspace-path`），与本次无关。

## 自己复核

仓库外留有一个可复用的验证器（不随 PR 提交）：

```
node verify-issue-87.mjs
```

它会用 `asar-presets/` 里的四个真实组合重放上述对照。以后插件升级、或 DSH 再改版撤掉某个变量时，一条命令就能确认 persona 还能正常插值——「上游悄悄撤销注册」这类坑还会再来。

## 生效方式

变体是插件在 DSH 启动时生成的（`agentPresets.register()`，内存注册，不落 `.agent-presets/` 目录）。**重启 DSH Desktop 后新会话即生效**，不需要重装插件。

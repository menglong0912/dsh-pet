# 脱离上游任务书：只留独立应用（2026-10-27）

给开发 agent 的任务书：每个任务写清现状、改法、测试和验收，主会话负责核验。

- **基线**：`custom` 分支 `8c0a60e`。2026-10-27 主会话跑过 `npm test`，1405 个全过。开工前先自己跑一遍确认。
- **路径**：下文代码路径都相对包目录 `dsh-pet/`；仓库根是它的上一级（本文就在根目录的 `docs/` 下），根目录的文件写成「根 `xxx`」。 2026-10-27 D11 把包目录摊平到了仓库根，下文的路径现在直接对应仓库根（`dsh-pet/` 这一层已经没有了）。
- **编号**：D（detach），和其他任务书的 T、X、Y 不重。

## 0. 用户已定（2026-10-27）

- **脱离上游**：不再合并 `PC2005-cloud/dsh-pet` 的新功能，也不再维护 DSH 插件版本，只留独立应用（`lib/app.js`，Electron 单进程）。
- **名字不改**：产品名 `dsh-pet`、appId `com.pc2005.dsh-pet`、数据目录 `Application Support/dsh-pet/dsh-pet`、路由前缀 `/dsh-pet-7340`、环境变量 `DSH_HOME` 都不动。改了要么旧数据读不到，要么 mac 的屏幕录制授权要重给。
- **只自己用**：
  - 不签名（继续 ad-hoc）、不公证、不做安装包（dmg / nsis）、不做自动更新。
  - mac 继续出 `.app` 目录装进 `/Applications`；Windows 继续出 zip 绿色版。
- **没有 Windows 机器**：
  - Windows 只保证 CI 上能装依赖、测试全过、打出包、冒烟截图。
  - 只在 mac 上有的功能不做 Windows 版：前台应用采样（`lsappinfo`）、`dsh-pet` 命令行、Claude Code hook。README 写明。
- **删两个功能**：「余额」和「显示位置」整个删掉，包括右键菜单里的「查看余额」「显示位置」（D2、D3）。
  - 应用里的余额本来就是随机数（`src/standalone/balance.ts`）。
  - 应用里只有桌面一端：宠物一律显示在桌面上，不能再按宠物设成「不显示」。
  - 用户现在只有一只宠物，配置是 `display: desktop`、`balanceEnabled: false`，删完表现不变。
- **碎碎念并入看屏幕**（D9，用户后加）：两个功能合成一个，以看屏幕为准——到点先看屏幕吐槽一句；模型不支持看图时，降级成原来碎碎念的效果（按人设、时间和「主人此刻」随口说一句，不截图）。
  - 用户现在 AI 设置里的自动碎碎念是关着的（`automaticWhispers: false`），看屏幕开着、每 3 分钟一次，合并后日常表现基本不变。

## 1. 范围

现在的独立应用是把插件的宿主半边套在一个伪 Cordis 上下文里跑：`src/standalone/context.ts` 造上下文，三个 `@deepseek-ai/*` 包换成 `src/standalone/shims/` 里的替身。项目里因此有三层只为插件存在的东西，本轮按层删掉，中间顺带删掉余额和显示位置：

1. **网页版**：`src/client`（约 6.6k 行，含测试）和 React。
2. **余额、显示位置**：用户点名要删的两个功能。在应用里一个是随机数，一个只剩桌面一个取值。
3. **插件外壳**：
   - `cordis.patch.yml`、`package.json` 的插件字段、prepack 发布链、OpenAPI 文档；
   - 命令行独立模式；
   - 在 DSH 里拉起 Electron 子进程、下载 Electron、bridge 管道。
4. **伪上下文**：DSH 事件、斜杠命令、`@deepseek-ai` 替身。

| 做                                                       | 不做                                              |
| -------------------------------------------------------- | ------------------------------------------------- |
| 删网页版（D1）                                           | 改名、签名、安装包、自动更新                      |
| 删余额（D2）、删显示位置（D3）                           | Windows 功能对齐                                  |
| 删插件包装（D4），删旧运行方式（D6），去掉伪上下文（D7） | 拆 `features.ts`（历练还在改它，见 §5）           |
| 打包一条命令到位，不再借 DSH 的 Electron（D5）           | 根目录素材流水线（python 脚本、`prompts/`），保留 |
| Windows CI 冒烟，代替真机（D8）                          |                                                   |
| 碎碎念并入看屏幕（D9）                                   |                                                   |
| 设置页分页、右键「设置」（D10）                          |                                                   |
| 摊平目录：包目录 `dsh-pet/` 的内容搬到仓库根（D11）      |                                                   |

## 2. 任务总览

| 编号 | 任务                     | 依赖 | 主要文件                                                                                                                                                     | 规模 |
| ---- | ------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| D0   | 仓库切换（主会话做）     | 无   | git                                                                                                                                                          | 小   |
| D1   | 删网页版                 | 无   | `src/client/`、`tsdown.config.mjs`、`eslint.config.js`、`tsconfig.json`、`package.json`、`scripts/tests/settings.test.mjs`                                   | 中   |
| D2   | 删余额                   | D1   | `src/host/balance/`、`src/shared/balance/`、`src/standalone/balance.ts`、`src/host/index.ts`、`state.ts`、`config.ts`、`runtime/electron-helper/`、`assets/` | 大   |
| D3   | 删显示位置               | D2   | `src/shared/types.ts`、`config.ts`、`menu.ts`、`src/host/config.ts`、`surface.ts`、`index.ts`、`runtime/electron-helper/`、`src/standalone/settings-page.ts` | 中   |
| D4   | 删插件包装与文档         | D3   | `package.json`、`cordis.patch.yml`、`electron-builder.yml`、`tsdown.config.mjs`、`scripts/`、根 `openapi.yaml` / `API.md` / `CORDIS.md` / `README.md` 等     | 中   |
| D5   | 打包一条命令到位         | D4   | `package.json`、`.npmrc`（新）、`pnpm-workspace.yaml`、`scripts/dist.mjs`、`scripts/start-app.mjs`、`electron-builder.yml`                                   | 中   |
| D6   | 删旧运行方式             | D5   | `src/host/helper-process.ts`、`src/host/index.ts`、`src/standalone/cli.ts`、`check.ts`、`runtime/electron-helper/main.js`、`scripts/`                        | 中   |
| D7   | 去掉伪上下文             | D6   | `src/host/index.ts`、`src/standalone/context.ts`、`src/standalone/shims/`、`src/app/main.ts`、`tsdown.config.mjs`、`package.json`                            | 大   |
| D8   | Windows CI 冒烟          | D5   | 根 `.github/workflows/`、根 `README.md`                                                                                                                      | 小   |
| D9   | 碎碎念并入看屏幕         | D4   | `src/app/features.ts`、`src/standalone/ai-provider.ts`、`ai-config.ts`、`settings-page.ts`、`src/host/index.ts`、`config.ts`、`runtime/electron-helper/`     | 中   |
| D10  | 设置页分页、右键「设置」 | D9   | `src/standalone/settings-page.ts`、`src/standalone/settings.test.ts`、`runtime/electron-helper/sprite.js`、`renderer.js`、`main.js`、`preload.js`            | 中   |
| D11  | 摊平目录                 | 全部 | 整个仓库：`dsh-pet/` → 根，根 `scripts/`、`assets/`、`.gitignore`、`.github/workflows/`、素材脚本                                                            | 中   |

**执行顺序**：

- D1 → D4 → **D9** → **D10** → D5 → D6 → D7 严格串行：好几个任务都改 `package.json`、`tsdown.config.mjs`、`src/host/index.ts`。
- D9 是用户后加的，编号排在最后，但插在 D4 之后、D5 之前做：先把碎碎念的自动定时删掉，D7 要改的东西会少一些。
- D10 也是用户后加的，紧跟 D9：两个都改设置页，D9 先把碎碎念那一节和输出上限删掉，D10 再改版面。
- **两条线并行**（2026-10-27 定）：D4 提交后分两条线。A 线 D9 → D10 → D6 → D7 在原 worktree；B 线 D5 → D8 另开 worktree（`git worktree add ../dsh-pet-detach-b -b detach-b detach`，自己 `pnpm install`），两条线的文件不重叠。B 线每个任务核验通过后由主会话合回 `detach`，A 线下一个任务开工前先把 `detach` 的最新提交合进来。真机核验同一时间只开一个测试实例，按完成先后排队。
- D11 最后做，而且要等 `detach` 合回 `custom`、历练那一轮收尾、工作区干净以后：它挪动全部文件，期间不能有别的分支在改 `dsh-pet/` 下的文件。
- 网页版先删，因为它自己也带一份余额和显示位置的代码，先删它就不用改两遍。
- D8 在 D5 之后任何时候都行，推荐放最后。
- D0 由主会话找时机做。

## 3. 通用约定

`standalone-roadmap.md` §2 照用：写代码看 §2.1，验证看 §2.3，交付看 §2.5。本节只写新增。

### 3.1 在 worktree 里做

- **原因**：历练（`adventure-roadmap.md`）还在 `custom` 上一边改一边提交，本轮不在主工作区动手。
- **建法**：`git worktree add ../dsh-pet-detach -b detach custom`，之后的任务都在这个 worktree 里接着做。仓库根在 `/Users/yfan/work/dsh-pet`，所以 worktree 在 `/Users/yfan/work/dsh-pet-detach`，包目录是它下面的 `dsh-pet/`。
- **准备**：
  - 在 worktree 里自己跑 `pnpm install`，**不要**把 `node_modules` 软链到主工作区：本轮要改依赖，软链会把主工作区的也一起改掉。
  - 新 worktree 先跑 `npm run build:desktop-core`：`shared-core.js` 被 gitignore 了，没有它打出来的包宠物不显示。
- **提交与合并**：主会话核验后提交在 `detach` 上。合回 `custom` 等历练这一轮收尾再做。

### 3.2 删除类任务的口径

- **确认没人用再删**：每删一个导出、文件、路由、脚本、依赖，先 grep 全仓确认没有别的调用方，范围包括 `src/`、`runtime/`、`scripts/`、根 `.github/`、根 `tools/`。拿不准就留，写进回报。
  - `noUnusedLocals` 只管文件内部，跨文件的孤立导出要自己查。
  - `runtime/` 通过 `window.PetShared`（`src/shared/index.ts` 打出来的 `shared-core.js`）用 `src/shared` 的导出，所以要连 `S.xxx` 一起 grep。
- **测试只跟着被删的代码删**：不许为了通过而删别的测试，也不许改弱断言。回报里写删前、删后的测试数，以及删掉的测试文件和用例。
- **行为不变**：除 D2、D3、D5 写明的变化，应用的功能、文案、配置读写都不应变化。
- **不碰历练**：`src/app/adventure-*`、`dungeon*`、`battle*`、`cultivation*`、`features.ts` 本轮不动，除非任务里写了。

### 3.3 旧配置兼容（D2、D3 必须做到）

删掉的配置字段，在用户的旧配置里还会存在。旧配置要做到：

- **照常加载**：
  - 不报错，不告警，不因为多出来的字段让整份配置回退到内置默认。
  - 用户层（`main-config.jsonc`）和文件宠物（`pet/` 下）都算。
  - 现在的合并器有好几处「非法即整段回退」「缺失即配置错误」，改的时候逐处确认。
- **不主动改写**：用户的配置文件不主动改写。设置页保存时按白名单重建用户层，删掉的字段自然不再写回。这样可以。
- **测试**：每个删掉的字段各有一条兼容测试，证明带着旧字段的配置加载结果和不带时一样。

### 3.4 每个任务都要加跑

在 §2.3 之外，每个任务还要：

```sh
npm run bundle && npm run build:desktop-core
DSH_PET_ELECTRON_DIST="$HOME/Library/Application Support/dsh-desktop/harness/electron" npm run dist   # D5 起直接 npm run dist
```

- 打包能成功，`scripts/dist.mjs` 的 `assertSelfContained` 不报错。
- 回报里写 `lib/` 下剩哪些 `.js`。

### 3.5 真机（主会话做）

按 `standalone-roadmap.md` §2.4 备份数据、装到 `/Applications`，至少过一遍：

- 宠物出来，能拖拽，右键菜单每一项都能点；
- AI 设置页能打开、能保存，碎碎念能出一句，对话能回；
- 历练小窗能开；
- 用 `scripts/dev/visit-peer.mjs host` 串一次门；
- 右键「重载配置」后宠物重建；
- 托盘能用；
- 工作状态气泡：让 Claude Code 跑一条命令。

## 4. 任务详情

### D0 仓库切换（主会话做）

- 给 `c696095` 打 tag `upstream-final`。这是上游最后一个提交，`main`、`origin/main`、`upstream/main` 都停在这里。
- `git remote remove upstream`。
- 历练这一轮和本轮都合进 `custom` 以后，把 `main` 快进到 `custom`（`git merge --ff-only custom`）。`custom` 只领先不落后，不用 force。之后在 `main` 上开发。
- 推送、改 GitHub 默认分支，都等用户说。

### D1 删网页版

**现状**：

- `src/client/` 是 DSH 页面里的 React overlay，只有 tsdown 的 `client` 入口用它，产物是 `lib/client.js`。
- React 相关的东西：
  - `package.json` 里的 `react`、`react-dom`（peer 和 dev 各一份）、`@types/react`、`@types/react-dom`、`eslint-plugin-react-hooks`；
  - `eslint.config.js` 里 `src/client/**` 那一段；
  - `tsconfig.json` 的 `"jsx": "react-jsx"`。
- `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-connection` 只有网页版 import。
- `scripts/tests/settings.test.mjs` 用 Playwright 测的是网页版的 React 设置页。

**改法**：

- **删**：`src/client/`、tsdown 的 `client` 入口、eslint 的 react-hooks 段、上面那些依赖、`settings.test.mjs`。没有 tsx 了，`tsconfig.json` 的 `jsx` 也删掉。
- **peerDependencies**：去掉上面两个只有网页版用的 `@deepseek-ai` 包。其余的留给 D4、D7，宿主代码还在 import 它们，删早了 typecheck 会红。
- **`src/shared` 里只给网页版用的导出**：确认 `src/` 和 `runtime/` 都不用以后再删（§3.2），拿不准就留。和余额、显示位置有关的先不动，D2、D3 会处理。
- **依赖**：`pnpm install`，更新 `pnpm-lock.yaml`。

**验收**：

- `lib/client.js` 不再生成。
- 删掉的测试只能是 `src/client/**` 下的和 `settings.test.mjs`。
- 其余同 §3。

### D2 删余额

**现状**：余额是从 DSH 带过来的功能：查 DeepSeek 等服务商的账户余额，按用量分档播动画、冒余额气泡。应用里没有计费账户，`src/standalone/balance.ts` 给它登记了一个随机余额（¥1 到 ¥1 亿）。涉及的地方：

- **宿主**：
  - `src/host/balance/`：注册表和四个服务商；
  - `src/host/index.ts`：约 34 处。包括启动和定时查余额、`/balance` 路由、`/state` 的 `sections.balance`；约 964 行那段读 `agentDefaultModel`、`credentials`、`deepseekAccount`；
  - `src/host/state.ts`、`src/host/config.ts`（`balanceEnabled`、`eventsRefreshSec.balance`）；
  - `src/host/lock.ts:172` 的注释。
- **共享**：
  - `src/shared/balance/`：解析、分档、气泡文案；
  - `src/shared/state.ts`、`src/shared/types.ts`（`balanceEnabled`）；
  - `src/shared/menu.ts`：`show-balance` 动作，以及 `EVENT_LABELS.balance`，也就是「动作」菜单里的「余额档位」分类；
  - `src/shared/index.ts` 的导出。
- **渲染端**：
  - `runtime/electron-helper/events.js`：约 45 处，余额轮询和触发；
  - `sprite.js`：约 30 处，余额气泡、可点展开、右键「查看余额」、`showBalanceFromMenu()`；
  - `constants.js`：`BALANCE_URL` 等；
  - `renderer.js:21` 的头注释。
- **应用**：
  - `src/standalone/balance.ts`；
  - `src/app/main.ts` 里的 `registerStandaloneBalance`；
  - `src/standalone/settings-page.ts` 的余额开关和说明（第 38 行附近），设置页读写这个开关的地方。
- **素材和配置**：
  - `assets/config.jsonc` 里的 `balanceEnabled`、`animations.events.balance`（6 段动画）、`eventsRefreshSec.balance` 和相关注释；
  - `assets/webm/余额-*.webm` 共 6 个，2.6 MB。

**改法**：

- **全部删掉**：上面列的余额代码、路由、`/state` 里的 `sections.balance`、右键「查看余额」、设置页的余额开关、`assets/config.jsonc` 里余额的三处配置和注释。
- **6 个 `余额-*.webm`**：
  - 一起删；
  - `src/shared/pickers.test.ts:58` 拿它们的名字当测试数据，换成别的事件或别的名字；
  - 根 `prompts/桌面宠物 10 秒动作提示词.md` 是素材的生成记录，不动。
- **旧配置兼容**（§3.3）：
  - 旧配置里的 `balanceEnabled`、`animations.events.balance`、`eventsRefreshSec.balance` 要照常加载。
  - `eventsRefreshSec` 现在是「整段替换」：只剩 `whisper` 一个键以后，旧配置里多出的 `balance` 键不能让整段判成非法。
- **占用锁**（`src/host/lock.ts`）：注释和逻辑里提到的「全局段」少了余额这一段，按实际改。
- **D7 的活不在这里做**：`@deepseek-ai/dsh-credentials` 只有余额那段在 import，删完以后 `index.ts` 不再 import 它。替身文件和 tsdown 里的 alias 留给 D7 统一删。
- **D3 的活不在这里做**：「显示位置」相关的不动。

**测试**：

- `src/host/balance.test.ts`、`src/shared/balance.test.ts`、`src/standalone/balance.test.ts` 整个删。
- `routes.test.ts`、`state.test.ts`、`config.test.ts` 等里面测余额的用例跟着删，其余用例保持原样。
- 加 §3.3 的兼容测试。
- `src/app/battle.test.ts` 里的 `balanceRate` 是对战平衡，和余额无关，不动。

**验收**：

- 在 `src/`、`runtime/`、`assets/config.jsonc` 里 grep `balance` 和「余额」，只剩对战平衡这类无关命中，回报里逐条列出。
- 主会话真机：
  - 右键根菜单没有「查看余额」，「动作」里没有「余额档位」；
  - 设置页没有余额开关，保存正常；
  - 拿一份带 `balanceEnabled: true` 和 `eventsRefreshSec.balance` 的旧配置启动，应用不报错，宠物照常出来。

### D3 删显示位置

**现状**：

- **配置**：宠物的 `display` 有四种取值：`web`、`desktop`、`both`、`none`，而且是必填（`src/shared/types.ts:20`、`:111`，`src/shared/config.ts:11` 的 `PET_DISPLAYS`、`isWebVisible`、`isDesktopVisible`，`src/host/config.ts:44` 的白名单）。应用里只有桌面：`web`、`none` 的宠物不显示，`both` 等于 `desktop`。
- **右键「显示位置」**：
  - 子菜单是 `S.displayMenuBranch()`（`src/shared/menu.ts:63`），在 `runtime/electron-helper/sprite.js` 的 `onContextMenu`（约 1718 行）里挂上；
  - 点了以后走 `set-display` → `setPetDisplay()`（约 1931 行）→ `POST /pet-display`（`src/host/index.ts:1377` 附近）；
  - 选「仅网页」「都不」宠物就没了。
- **`?surface=`**：会产生可见效果的接口必须带 `?surface=web|desktop|both|any`，见 `src/host/surface.ts` 和 `index.ts` 里的 `requirePet(..., { surface })`。它用来区分「哪一端」，应用里只有一端。
- **其他**：
  - `src/host/state.ts:46` 有一个只为网页端存在的信号；
  - `src/shared/chat.ts:108` 有 `surface: 'web' | 'desktop'`；
  - `index.ts:1456` 附近有 `none` 当「用户接管」的判断；
  - `src/standalone/settings-page.ts:317` 按 `display` 挑要设置的宠物；
  - `desktopPetList()` 按 `display` 过滤桌面宠物。

**改法**：

- **全部删掉**：
  - `display` 字段及其类型、白名单、判断函数；
  - 右键「显示位置」、`displayMenuBranch`、`set-display` 动作、`setPetDisplay()`；
  - `/pet-display` 路由、`surface.ts` 和所有 `surface` 校验、上面那个信号、`chat.ts` 的 `surface` 字段；
  - `runtime/`、`scripts/` 里拼 `surface=` 的地方；
  - `assets/config.jsonc` 里 `display` 的配置和注释。
- **结果**：每只宠物都显示在桌面上。`desktopPetList()` 不再过滤；设置页挑宠物的地方改成直接取 main（或第一只）。
- **`none` 的语义**：`index.ts:1456` 附近那段拿 `none` 判断「用户接管」，弄清楚原来是为了什么，按「宠物永远在桌面」改。改法写进回报。
- **旧配置兼容**（§3.3）：
  - 旧配置里的 `display`（四种值都可能出现）要照常加载，直接忽略。
  - 原来是 `web`、`none` 的宠物，删完以后会出现在桌面上。这是用户接受的变化（§0），在回报里提一句。
- **`src/shared/menu.ts`**：`MenuLeaf.action` 的联合类型、`display` 字段、头注释同步改。D2 已经删了 `show-balance`。

**测试**：

- `src/host/surface.test.ts`（如果有）整个删。
- `routes.test.ts` 里大量请求带着 `surface=`：只删参数，断言不动。专门测 `surface` 校验的用例跟着删。
- 加 §3.3 的兼容测试，四种旧值各一条。

**验收**：

- 在 `src/`、`runtime/`、`scripts/` 里 grep `display:`、`'web'`、`surface`，只剩无关的命中（比如 CSS 的 `display:`），回报里逐条列出。
- 主会话真机：
  - 右键根菜单没有「显示位置」；
  - 不动现有的 `main-config.jsonc`，重启后宠物照常出来；
  - 串门、历练、碎碎念照常。

### D4 删插件包装与文档

**现状**：插件发布要用的东西都还在：

- `cordis.patch.yml`；
- `package.json` 的 `dsh`、`exports`、`files`、`bin`、`peerDependencies`，`_comment` 里一长段在讲它们；
- `prepack` 发布链：`scripts/prepare.js`、`prepack-check.js`、`gen-types.mjs`（加 `tsconfig.types.json`）、`check-openapi.mjs`；
- 根 `openapi.yaml`、`API.md`、`CORDIS.md`、根 `tools/cordis-probe/`；
- 包内 `README.md`，这是 npm 包的说明；
- 只给 Safari 网页版用的 HEVC/.mov 流水线：根 `.github/workflows/hevc-alpha.yml`、根 `scripts/encode_hevc_alpha.sh`、根 `scripts/hevc_alpha_encoder.swift`。Electron 播的是 webm，用不上。

**改法**：

- **直接删的文件**：上面列的这些。
- **根 `tools/` 其余文件**：看头注释，只服务插件的才删，拿不准就留。
- **`package.json`**：
  - 删 `dsh`、`exports`、`files`、`bin`；
  - 删 scripts 里的 `build`、`prepack`、`check:openapi`、`types`；
  - 只有被删脚本在用的 devDependencies 一起删，比如 `js-yaml`，先 grep 确认；
  - `main` 改成 `lib/app.js`，同时删掉 `electron-builder.yml` 里的 `extraMetadata`；
  - `repository`、`homepage`、`bugs` 改成 `yangfan000818-droid/dsh-pet`；
  - `keywords` 去掉插件相关的词；
  - `_comment` 重写成只讲还在的字段；
  - `peerDependencies` 里宿主代码还在 import 的留给 D7。
- **`tsdown.config.mjs`**：删 `index` 入口（`lib/index.js` 是插件入口，`app` 入口会自己把宿主代码打进去）。头注释同步改。
- **根 `README.md`**：
  - 删插件相关的章节：安装插件、Safari 用 mov、斜杠命令、对外接口、兼容性、桌面模式、命令行独立运行、余额展示、发现更多 DSH 插件等。
  - 留独立应用、配置、素材流水线这几章；配置一章里删掉余额和 `display` 的内容。
  - 按现有章节逐个判断，回报里列出删了哪些。
  - **不要**对根 `README.md` 跑 `prettier --write`。

**验收**：

- `lib/` 下只剩 `standalone.js` 和 `app.js`。
- `npm test` 只少了被删脚本的测试（如果有）。
- 打出来的 `.app` 照常能用。主会话要确认 asar 里的 `package.json` 的 `main` 是 `lib/app.js`。

### D5 打包一条命令到位

**现状**：

- **Electron 从哪来**：本机访问不了 github.com，`npm run dist` 只能靠 `DSH_PET_ELECTRON_DIST` 借 DSH 桌面版里的那份 Electron 43.3.0。开发期的 `scripts/start-app.mjs` 去找 `$DSH_HOME/electron`。
- **打包前不编译**：`npm run dist` 不编译 `lib/`，也不生成 `shared-core.js`。改了 `src/` 忘了先 bundle，装上的就是旧代码。2026-10-26 踩过：真机测了两场才发现。
- **安装**：装到本机要手敲退出、删旧 app、ditto、打开四条命令。

**改法**：

- **Electron 进 devDependencies**：
  - 版本钉 `43.3.0`。`electron-builder.yml` 的 `electronVersion` 有了 devDependency 就可以删，electron-builder 会自己读。
  - 包目录新建 `.npmrc`，写 `electron_mirror=https://npmmirror.com/mirrors/electron/`。
  - `pnpm-workspace.yaml` 的 `allowBuilds` 放行 `electron`，它的 postinstall 要下载并解压。
  - 实测 `pnpm install` 以后 `node_modules/electron/dist` 存在。`.npmrc` 在 pnpm 下不生效的话，换别的办法，回报写清楚用的是哪个。
- **`scripts/dist.mjs`**：
  - 打包前先跑 bundle 和 build:desktop-core。
  - Electron 默认用 `node_modules/electron/dist`，`DSH_PET_ELECTRON_DIST` 留着当覆盖；找 `$DSH_HOME/electron` 那条去掉。
  - `DSH_PET_ALLOW_ELECTRON_DOWNLOAD` 那条 CI 回退：CI 上 `pnpm install` 也会装好 electron，这条大概用不上了。删不删按实际情况定，D8 会在 CI 上验。
  - 头注释同步改。
- **开发启动**：`scripts/start-app.mjs` 默认用 `node_modules/electron` 那份，加 `npm start` 指向它。
- **新增 `npm run install:mac`**（只在 macOS）：dist → `osascript -e 'quit app "dsh-pet"'` → 删旧的 `/Applications/dsh-pet.app` → `ditto dist-app/mac-arm64/dsh-pet.app /Applications/dsh-pet.app` → `open`。开发 agent 只写，**不跑**：它会替换用户每天在用的 app，由主会话跑。
- **语言包**：`electron-builder.yml` 加 `electronLanguages`，只留中文和英文。mac（`.lproj`）和 Windows（`locales/*.pak`）的写法要实测，打完看产物里实际还剩哪些语言包。
- **文档**：`standalone-roadmap.md` §2.4 和本文 §3.4 的构建命令改成新写法。

**验收**：

- 在一个全新的 worktree 里 `pnpm install`，然后 `npm run dist` 一条命令打出 `.app`：不设任何环境变量，不访问 github.com。
- 打包前后的产物体积对比写进回报。
- 主会话：`npm run install:mac` 装上以后能用，屏幕录制授权没掉（`dist.mjs` 打完会按 bundle id 重签指定要求，这一步还要在）。

### D6 删旧运行方式

**现状**：除了应用本身，代码里还留着三种跑法：

1. **插件在 DSH 里**：
   - 宿主 spawn 一个 Electron 子进程：`src/host/helper-process.ts` 的 `HelperProcess`、`ensureElectronDownload`、重启退避；
   - 渲染端经 bridge 管道访问宿主：`DSH_PET_BRIDGE`、`dsh-pet-bridge://`；
   - 子进程靠 `runtime/electron-helper/host-liveness.js` 盯着父进程。
   - 应用模式下 `DSH_PET_IN_PROCESS=1` 把这一套短路掉（`src/host/index.ts:1080`）。
2. **命令行独立模式 `dsh-pet-standalone`**：`src/standalone/cli.ts`、`check.ts`，加 tsdown 的 `standalone` 入口。
3. **开发用**：`scripts/start-desktop.mjs` 加 `scripts/dev/mock-server.mjs`（假 DSH 宿主），以及 `scripts/ensure-electron.mjs`。

**改法**：

- **删第 1 种**：
  - `HelperProcess`、下载、重启退避、bridge 的类型和常量；
  - `index.ts` 里 `launchHelper`、探测和下载 Electron 那几段；
  - `DSH_PET_IN_PROCESS` 判断，以后恒为应用模式。
  - 应用还在用的 `dshHomeDir`、`packageRoot` 留下，文件可以改名成 `paths.ts`，改不改写进回报。
  - `syncDesktop` 在应用模式下走 `dshPetAppDesktopChanged`（`index.ts:1269`），这条要留住：右键「重载配置」和保存配置都靠它。
- **`runtime/electron-helper/main.js`**：
  - 删 bridge：`BRIDGE` 分支、scheme 注册、回调服务；
  - 删 `host-liveness.js` 和它的测试（`src/host/host-liveness.test.ts`）；
  - 删 `OPEN_TARGET === 'desktop'` 走 `dsh://open` 那一支，宿主不会再是 DSH 桌面版。
  - `APP_MODE` 恒为真，删掉为假的那些分支。
  - 渲染端 HTTP 直连宿主那条路径保留，应用走的就是它。
- **删第 2 种**：
  - `cli.ts`、`check.ts`（`packageVersion` 挪到应用还在用的地方）；
  - tsdown 的 `standalone` 入口；
  - `package.json` 的 `standalone` script。
- **删第 3 种**：
  - `start-desktop.mjs`、`dev/mock-server.mjs`、`ensure-electron.mjs`，以及对应的 scripts（`start:desktop`、`ensure:electron`、`dev:mock`）；
  - `@electron/get`、`@electron-internal/extract-zip` 两个依赖；
  - tsdown 和 `dist.mjs` 的 `assertSelfContained` 里给它们留的口子。
- **`scripts/tests/desktop-macos.test.mjs`**：它自带假宿主，测的是 helper 走 HTTP 的路径，应用也走这条，所以留着。改成用 D5 装好的 electron，确认还能跑。

**验收**：

- `lib/` 下只剩 `app.js`。
- 下面这些词在 `src/`、`runtime/`、`scripts/` 里零命中：`DSH_PET_BRIDGE`、`dsh-pet-bridge`、`HelperProcess`、`ensureElectron`、`DSH_PET_IN_PROCESS`、`host-liveness`。
- 主会话真机重点看：重载配置、托盘、「打开网站」打开的是 AI 设置页。

### D7 去掉伪上下文

**现状**：

- `src/app/main.ts` 用 `createStandaloneContext`（`src/standalone/context.ts`）造一个伪 Cordis `ctx`，交给 `src/host/index.ts` 的 `apply(ctx)`。
- D2 删完余额以后，`apply` 还会用到的上下文接口，大致是：`webServer.register`、`effect`、`on('session/event' | 'agent/error')`、`commands.register`（斜杠命令）、`provide('petApi7340')`、`llm`、`agentDefaultModel`、`connection.authenticatedUrl`、`standaloneAi`、`logger`。以 D6 完成后的代码为准。
- `@deepseek-ai/dsh-home-paths`、`dsh-credentials`、`dsh-llm` 三个包，靠 tsdown 的 alias 换成 `src/standalone/shims/` 里的替身。

**改法**：

- **工厂**：`apply(ctx)` 改成普通工厂，比如 `createPetHost(deps)`，返回路由处理函数和 `dispose()`。具体形状按 `main.ts` 现在的 `startRouter` 怎么接来定。`deps` 只放应用真用到的：logger、端口、`StandaloneAiService`、`authenticatedUrl`，以及现在 `dshPetAppDesktopChanged` 那个回调。
- **删 DSH 专属的部分**：
  - 会话事件和 `agent/error` 监听、斜杠命令、`provide`；
  - 走 `ctx.llm`、`agentDefaultModel` 的分支。模型调用只留独立 AI 那条，`preferredModel(..., ctx.standaloneAi !== undefined)` 另一支随之删掉。
- **工作状态**：删掉会话事件以后，工作状态只来自 `/work-status` 接口（Claude Code hook 经 `src/app/features.ts:984` 走这里），确认这条联动不受影响。
- **跟着删的**：
  - `src/standalone/context.ts` 和它的测试、`shims/`；
  - tsdown 里所有 `@deepseek-ai` 的 alias、noExternal、external；
  - `package.json` 剩下的 peerDependencies；
  - `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里不再需要的条目。
  - `whisper.ts`、`chat.ts`、`model-selection.ts` 从 `@deepseek-ai/dsh-llm` import 的几个名字，换成本地实现，就是现在 shim 里那几个。
- **分小步做**：先换工厂接口，再删 DSH 分支，最后删 shim。每一步都要测试全绿再往下。
- **路由测试是回归网**：`src/host/routes.test.ts` 等现在用最小 ctx 调 `apply`，改成调新工厂。只改接法，断言不许改弱。

**验收**：

- `grep -rn "@deepseek-ai" src runtime scripts tsdown.config.mjs package.json pnpm-workspace.yaml` 零命中，`pnpm-lock.yaml` 里也没有。
- 测试数只少了被删模块的。
- 主会话真机：碎碎念、对话、AI 设置页、工作状态气泡。

### D8 Windows CI 冒烟

**现状**：

- 根 `.github/workflows/release-app.yml` 只在推 tag 时跑 Windows：bundle、typecheck、打包、压 zip、挂到 Release。不跑测试，打出来的包也没人启动过。
- 没有 Windows 机器，CI 是唯一的验证手段。

**改法**：

- **新的 workflow**：新增一个手动触发的 `windows-check.yml`，依次 `pnpm install` → `npm test` → `npm run dist` → 冒烟。`release-app.yml` 在打包前加上同样的测试步骤。
- **冒烟**：
  - 用临时 `DSH_HOME` 启动 `dist-app/win-unpacked/dsh-pet.exe`；
  - 等 `$DSH_HOME/dsh-pet/app.json` 出现，读里面的端口，确认 `GET /health` 成功；
  - 截一张屏作为 artifact 上传，然后退出。
  - helper 现成的 `DSH_PET_SMOKE=1`（`runtime/electron-helper/main.js:1037`，延时截图后退出）可以借用，但它在应用模式下能不能用，要先在 mac 上试通。
- **Windows 上测试失败**：测试里写死了 POSIX 路径一类的问题，就修测试并在回报里说明；是代码的问题，记下来回报，不在本任务里修。
- **根 `README.md`**：写明 Windows 版的限制：前台应用、`dsh-pet` 命令行、Claude Code hook 只在 mac 上有；Windows 版没有真机测过。
- **推送**：CI 要推到 GitHub 才能跑。开发 agent 只写 workflow，**推送和触发由主会话问过用户再做**。

**验收**：CI 绿；artifact 里的截图能看到宠物。

### D9 碎碎念并入看屏幕

**用户要的**（§0）：两个功能合成一个，以看屏幕为准。到点先看屏幕吐槽一句；模型不支持看图时，降级成原来碎碎念的效果。

**现状**：两条路各管各的，靠一个「拍」协调。

- **碎碎念（宿主）**：
  - 定时在 `src/host/index.ts` 的 `whisper poll`（约 2294 行）。开关和周期分散在每只宠物的 `whisperEnabled`、`eventsRefreshSec.whisper`，以及 AI 设置里的 `automaticWhispers`、`whisperIntervalSec`（`canWhisper()`、`automaticWhisperSchedule`，以代码实际判断为准）。
  - 每拍先问应用 `dshPetAppWhisperTurn` → `features.takeWhisperTurn()`：该看屏幕就让看屏幕顶替，应用正在说话就让一让；否则 `publishWhisper` 生成一句。
  - 生成一句的内容：人设 + 时间 + `dshPetAppContext` 给的「主人此刻」，按开关配一张表情包；不记日记。
  - 手动入口：右键「碎碎念」（`sprite.js` 的 `whisper` 动作 → `POST /whisper`）、`dsh-pet whisper`（`/app/whisper`）、`/chat` 斜杠命令不带参数。
- **看屏幕（应用）**：
  - `src/app/features.ts` 的 `lookAtScreen()`。开关和间隔是 app-config 的 `screen.enabled`、`screen.intervalMin`。
  - 自动触发要求：人在、一分钟内碰过键鼠、没出门、没在演出、已授权屏幕录制、`ai.canSeeScreen()`。`canSeeScreen()` 现在只等于「模型配好了」，并不知道模型能不能看图。
  - 碎碎念没在跑时，看屏幕自己按间隔看（tick 里的 `!whisperRunning(now) && screenDue(now)`）。
  - 手动入口：右键「看看我在干嘛」、`dsh-pet look`。

**改成**：

1. **只剩一个节拍**：只留看屏幕的开关和间隔（`screen.enabled`、`screen.intervalMin`），自动触发条件照看屏幕现在的。到点以后：
   - 能看屏幕 → 照现在的 `lookAtScreen` 截图吐槽；
   - 模型不支持看图 → 降级：调现有的 `/whisper`（`features.whisper()`），效果就是原来的碎碎念；
   - 没授权屏幕录制 → 自动触发时也降级成碎碎念，不弹授权框；手动触发照旧提示去开权限；
   - 模型没配好 → 自动触发安静跳过；手动触发照旧提示去配模型。
2. **手动入口合并**：
   - 右键只留「看看我在干嘛」，和自动走同一套判断：看得了就看，模型不支持看图就降级成碎碎念。
   - 删掉右键「碎碎念」，以及 `sprite.js` 里对应的菜单项、`showWhisperFromMenu()`、`whisper` 动作（`src/shared/menu.ts` 的 action 联合类型同步改）。
   - 删掉 `dsh-pet whisper` 和 `/app/whisper`；`dsh-pet look` 走合并后的逻辑。用法说明同步改。
3. **识别「模型不支持看图」**（`src/standalone/ai-provider.ts`）：
   - **判据**：视觉请求被服务端用客户端错误拒绝（HTTP 400、404、415、422）。401、403、429、超时、网络错误都不算。
   - **出错时**：抛一个固定文案的错误（比如 `Standalone AI model does not accept images.`），并记住「当前这套设置不支持看图」，此后 `canSeeScreen()` 返回 false。
   - **记忆只放内存**：保存 AI 设置（换模型、换地址）时清掉，重启应用也清掉。重启后第一次看屏幕会再试一次。
   - **识别出来的那一拍当场降级**，说一句碎碎念，不让这一拍空掉。
   - **识别不出来的失败**（超时、网络、限流）照现在的处理：自动安静跳过，手动说「刚才没看清」。
   - **status 怎么拿**：从 SDK 错误里取 status 码，按 `ai-transport.ts` 实际用的 SDK 来。错误细节不许外泄，沿用 `run()` 里「只透出固定文案」的规矩。
4. **删掉碎碎念自己的定时和开关**：
   - **宿主**：`whisper poll`、`whisper-policy.ts` 及其测试、`lastWhisperAt`、`whisperPeriodSec`、对 `dshPetAppWhisperTurn` 的调用；`/chat` 斜杠命令不带参数时碎碎念那一支（斜杠命令整个留给 D7 删）。
   - **应用**：`takeWhisperTurn`、`whisperRunning`、`whisperPeriodSec`、`lastWhisperTurnAt`，`main.ts` 里挂 `dshPetAppWhisperTurn` 的那行。tick 里自动看屏幕不再看 `whisperRunning`。
   - **配置**：
     - 每只宠物的 `whisperEnabled`、`whisperModel`（独立模式本来就不看它）；
     - `eventsRefreshSec`（只剩 `whisper` 一个键，整段删）；
     - AI 设置的 `automaticWhispers`、`whisperIntervalSec`，以及 `canWhisper()`；
     - 设置页的对应控件；`assets/config.jsonc` 里对应的字段和注释。
   - **旧配置兼容**（§3.3）：`main-config.jsonc` 里的那三个字段、`standalone-ai.json` 里的两个字段，都要照常加载、不告警。`ai-config.ts` 的 zod schema 如果是严格模式，要放过这两个旧键。
5. **保留，别误删**：
   - **`/whisper` 路由**和 `publishWhisper`、`generateWhisper`：降级要用它们。只删自动定时，手动生成留着。
   - **说话的展示链路**：`events.whisper` 里 3 段「碎碎念-*」动画、渲染端的 `showWhisper` / `clearWhisper`、`/broadcast`、`pets.<id>.say`。看屏幕、对话、提醒、串门转播都靠它说话。
   - **`whisperPrompt`（人设）和 `whisperImageEnabled`（配表情包）**：对话、看屏幕、提醒都在用。键名不改，改了旧配置要迁移；设置页上的文字改成「人设」「说话时配表情包」，不再叫碎碎念。
   - **不改名**：名字里带 whisper 的函数、字段、事件名一律不改。
6. **设置页**：「看屏幕」那一节写清楚：模型不支持看图时，会改成按人设随口说一句。
7. **间隔最低 10 秒**（用户后加）：
   - **单位改成秒**：现在是 `screen.intervalMin`（分钟，`src/app/app-config.ts` 里最低 3），改成 `screen.intervalSec`，范围 10–86400，默认 900（等于原来的默认 15 分钟）。新字段照 `standalone-roadmap.md` §2.1 的三处都改（字段 `.default`、对象级 `.default`、`DEFAULT_APP_CONFIG`）。
   - **旧配置**：旧的 `app-config.json` 只有 `intervalMin` 时，按 `intervalMin × 60` 读成 `intervalSec`，不告警、不让整份配置作废。设置页保存时只写 `intervalSec`。用户现在是 `intervalMin: 3`，读出来应是 180 秒。
   - **用到间隔的地方**：`features.ts` 的 `screenDue()`（`intervalMin * 60_000` → `intervalSec * 1000`），设置页的输入框和文案（单位改成秒，`min=10`）。tick 是 5 秒一次（`TICK_MS`），10 秒的间隔够用，不用改。
   - **请求频率上限**：`src/standalone/ai-provider.ts` 的 `REQUESTS_PER_MINUTE` 从 6 提到 12。10 秒看一次最多每分钟 6 次，正好占满原来的上限，对话、提醒、日记都会被挡回去。单飞（同一时刻只跑一个请求）不变。
   - **日记别被挤满**：每天最多记 200 条事件（`src/app/diary.ts` 的 `MAX_EVENTS`）。10 秒看一次的话，不到一小时就满了，当天后面的提醒、串门、修炼都记不进去。看屏幕写日记（`diary.note(..., 'screen', ...)`）改成距上一条看屏幕日记至少 3 分钟才记，维持原来最短 3 分钟间隔时的密度。降级成碎碎念的那一句照旧不记日记。
   - **测试**：旧 `intervalMin` 的兼容读法（3 → 180）；10 秒可以存、9 秒不行；`screenDue` 按秒判断；看屏幕日记 3 分钟内只记一条。
8. **AI 设置页去掉「单次输出上限（tokens）」**（用户后加）：
   - **为什么**：宠物每句话只有二十来字，关了思考以后 `max_tokens` 正常永远碰不到，它只在模型跑飞（复读停不下来）时兜底。这个值不该让人调；输入框下面「输出上限越小，单次回复越简短」的说法也不对，设小只会把话截断，开着思考时还会回空。
   - **改法**：
     - 设置页删掉这个输入框和那句说明；
     - `src/standalone/ai-transport.ts` 发请求时 `max_tokens` 固定为 1024（定义一个常量，等于 `ai-config.ts` 原来的默认值）；
     - `ai-config.ts`、`settings.ts` 里的 `maxTokens` 字段删掉；
     - 连通性测试那条另用的 `maxTokens: 32`（`ai-provider.ts` 约 307 行）照它原来的意思保留成小值。
   - **旧配置**：`standalone-ai.json` 里的 `maxTokens` 照常加载、不告警（§3.3），读到也不用。用户现在是 2048；最长的正常输出是日记（150–300 字，约 200–400 tokens），1024 足够，正常输出不受影响，模型跑飞时能早一倍停下。
   - **测试**：带 `maxTokens` 的旧 AI 设置照常加载；请求里的 `max_tokens` 是 1024；保存设置不再要求、也不再写回 `maxTokens`。

**测试**：

- **删**：
  - `whisper-policy.test.ts`；
  - `features.test.ts` 里测 `takeWhisperTurn` 的「碎碎念这一拍」几条，也就是傍晚会挂的那几条存量失败；
  - 其他只测被删开关的用例。
- **加**：
  - 合并后的节拍：能看图 → 看屏幕；不支持看图 → 调 `/whisper`；没授权（自动）→ 调 `/whisper`，而且不调 `getSources`；模型没配好 → 什么都不调。
  - 手动「看看我在干嘛」：不支持看图时降级。
  - `ai-provider`：视觉请求返回 400 → 抛固定文案的错误，`canSeeScreen()` 变成 false；保存设置后恢复 true；401、429、超时都不算「不支持看图」。
  - 旧配置兼容：上面 5 个旧字段。
- **模型调用**：
  - 降级那一拍本来就是一次文本调用，和原来的碎碎念一样，不新增。
  - 识别「不支持看图」那一拍会多一次失败的视觉请求，每次启动、每次改设置最多一次。

**验收**：

- `takeWhisperTurn`、`dshPetAppWhisperTurn`、`automaticWhispers`、`whisperIntervalSec`、`whisperEnabled`、`canWhisper`、`whisper-policy` 这几个词，在 `src/`、`runtime/`、`scripts/`、`assets/config.jsonc` 里只剩兼容测试里的命中。
- 主会话真机：
  - 用户现在的设置（看屏幕开、3 分钟、模型能看图）：自动看屏幕照常；右键没有「碎碎念」，「看看我在干嘛」能用。
  - 在数据副本里把 AI 设置换成不支持看图的模型（或者假接口对带图请求回 400）：自动和手动都降级成碎碎念一句。

### D10 设置页分页、右键「设置」

**用户要的**（2026-10-27）：右键「打开网站」应该叫「设置」；设置页（`/standalone-ai/`）太长，保存按钮在最底下，要滑很久才点得到。

**现状**：

- 设置页是 `src/standalone/settings-page.ts` 里的一张长表单，一列排下来：模型连接、宠物、陪伴与提醒、局域网串门、邻居、修炼（「定时自动碎碎念」那一节 D9 已删），最底下的 `footer` 才是唯一的「保存到本机」按钮，保存结果的提示 `#status` 还在按钮下面。
- 好几段说明很长：关闭思考（`#thinking-note`）、看屏幕（`#screen-note`）、串门总开关（`#visit-note`）、别的网段（`#visit-peers-note`）、串门身份（`#identity-note`）。
- 页面上各节的 `hidden` 属性已经有用途：数据没读到、功能不可用时整节藏起来（比如 `#pet-settings`）。
- 右键根菜单第一项在 `runtime/electron-helper/sprite.js` 的 `onContextMenu`：`OPEN_TARGET === 'desktop' ? '打开软件' : '打开网站'`，后面带 `Cmd+左键` / `Ctrl+左键` 的提示（`OPEN_SHORTCUT_HINT`）。点了打开的就是这个设置页。

**改法**：

1. **右键「设置」**：
   - 第一项的文案改成「设置」，快捷键提示和 `Cmd+左键` 这个动作都保留。`OPEN_TARGET === 'desktop'`（DSH 桌面版）那一支 D6 才删，这里只改应用里会显示的文案；两个分支都叫「设置」也行。
   - `renderer.js`、`preload.js`、`main.js`、`constants.js`、`sprite.js` 注释里写「打开网站」的地方同步改成「设置」。函数名 `openDshSite`、环境变量 `DSH_PET_SITE_URL` 不改名。
2. **页面标题和开头**：`<title>` 和 `h1` 改成「桌宠设置」。开头的介绍缩成一行，不再提碎碎念。
3. **分页**：
   - 每个 `fieldset` 是一页。左边一列导航（模型、宠物、看屏幕与提醒、串门、邻居、修炼），一次只显示一页；窗口窄（比如宽度小于 720px）时导航改到顶部横排。
   - 仍然是**一张表单、一个保存**：切页只是显示和隐藏，没切到的页里改过的值照样一起保存。
   - 「切到别的页」不能用 `hidden` 属性表示（它已经表示「这一节不可用」），另用 class 或 `data-` 属性。某节因为不可用被 `hidden` 时，导航里对应的那一项也要藏起来；当前页变得不可用时切到第一个可用的页。
   - 记住上次看的哪一页：`localStorage`，读写都包 `try/catch`，读不到就停在第一页。地址里的 `#token=` 是鉴权用的，**不要**拿 hash 记页码。
   - **必填项在别的页**：浏览器的表单校验遇到不在当前页的非法输入时，会因为对不上焦点而静默拦下提交，表现为点保存没反应。要在 `invalid` 事件（捕获阶段）里先切到那个输入所在的页，再让浏览器提示。
4. **保存栏固定在窗口底部**：`footer` 用 `position: sticky; bottom: 0`，带底色和一条分隔线，滚动时一直看得见。保存结果的提示 `#status` 挪进保存栏，放在按钮旁边。「邻居」页的操作本来就是点了立即生效，保存栏照样显示，不用特殊处理。
5. **长说明折叠**：上面列的几段长说明，正文只留一句要点，其余收进 `<details><summary>说明</summary>…</details>`。内容不删，只折叠；`aria-describedby` 指向的那句要点保持可读。
6. **CSP 不变**：页面仍然不许有内联脚本和内联样式（文件头注释写着），新加的逻辑放进 `settingsScript`，样式放进 `settingsStyle`。不引入任何外部依赖。

**测试**：

- `src/standalone/settings.test.ts` 里断言页面结构的用例跟着改：断言导航项和 `fieldset` 一一对应，保存按钮在 `footer` 里、`footer` 是 sticky，`#status` 在 `footer` 里，标题是「桌宠设置」，没有内联脚本和样式。
- 断言 `settingsScript` 里有 `invalid` 事件切页的处理，以及 `localStorage` 读写包在 `try` 里。
- 菜单文案：有源码断言测右键菜单项的，同步改成「设置」。

**截图（开发 agent 要做）**：用 `playwright`（已在 devDependencies）无头打开页面，`page.route` 拦下 `/standalone-ai/settings` 等接口返回假数据（字段齐全，各节都显示），分别截 1280×800 和 420×800 两张，再截一张「必填项在别的页、点保存后自动切过去」的图。截图存到 `/private/tmp/claude-501/-Users-yfan-work-dsh-pet/7ce6bdc1-e693-43bc-8dfd-43afd76f555f/scratchpad/d10/`，脚本放在同一目录，**不进仓库**。回报里列出图片路径。

**验收**：

- 1280×800 下不用滚动就能看到导航和保存按钮；420×800 下导航在顶部，保存栏固定在底部。
- 在「模型」页把一个必填项清空，切到「串门」页点保存：自动切回「模型」页并提示。
- 主会话真机：右键第一项叫「设置」，点开就是新版设置页，改一个值保存后生效。

### D11 摊平目录

**为什么**（用户 2026-10-27 同意）：包目录 `dsh-pet/` 外面套一层，是因为原来要把它当 npm 插件包发布，仓库根放素材流水线（提示词、python 脚本、源视频）。不发包以后这层没有理由，摊平后所有命令都在仓库根跑。以后真要接 DSH，另做一个薄的桥接插件放在子目录（§5），和目录结构不冲突。

**时机**：D1–D10、D8 都做完；`detach` 合回 `custom`；历练那一轮收尾、主工作区干净。由主会话确认时机后再派。

**改法**：

- **搬家**：`dsh-pet/` 下的全部内容（含 `.prettierrc.json`、`.prettierignore`、D5 新加的 `.npmrc`）用 `git mv` 搬到仓库根，保住历史。`.zcode/` 这类本地工作产物不搬。
- **撞名的处理**：
  - `scripts/`：根目录原来那些素材脚本（`*.py`、`*.sh`、`*.swift`）挪进 `scripts/assets/`；包里的 node 脚本成为根 `scripts/`。
  - `assets/`：根目录原来的 `assets/screenshots/`（README 用的截图）挪到 `docs/screenshots/`，根 `README.md` 里的图片路径同步改；包里的 `assets/` 成为根 `assets/`。
  - `README.md`：包内那份 D4 已删，只剩根目录的。
  - `LICENSE`：两份内容相同（已确认），留一份。
  - `.gitignore`：只留根目录一份，`dsh-pet/lib/` 这类条目去掉 `dsh-pet/` 前缀。
- **路径引用**：
  - 素材脚本里写死的 `dsh-pet/assets/...`：`scripts/encode_thumbs.py`、`encode_preview_gifs.py`、`pr_import_step02.py`（HEVC 那个 D4 已删）。搬完以后 grep 一遍 `dsh-pet/` 前缀，剩下的逐个判断（产品名、appId、数据目录、`/dsh-pet-7340` 这类**不是路径**，不改）。
  - 根 `.github/workflows/*.yml`：去掉 `working-directory: dsh-pet`，产物路径同步改。
  - 源码里从 `src/` 往上两级找包根的写法（`'..', '..'`、`../../assets/...`）搬完照样对，不用改。
- **检查范围**：搬过来的 `docs/`、`prompts/`、根 `README.md`、`scripts/assets/` 不能让 `npm run lint`、`npm run format:check`、`tsc` 变红。按需要补 `.prettierignore` 和 eslint 的 ignores；`prompts/` 和根 `README.md` 本来就不是 prettier 干净的，加进 ignore，**不要**对它们跑 `prettier --write`。
- **文档**：`docs/` 下各任务书开头写着「路径都相对包目录 `dsh-pet/`」，加一句「D11 以后包目录就是仓库根」，正文不逐条改。

**验证**：

- §2.3 全套和 §3.4 的构建打包，都在仓库根跑。
- 素材脚本：`python3 -m py_compile scripts/assets/*.py`，并确认它们按新路径能找到 `assets/webm`（只跑不写的那几个，或者 `--help`）。
- `git log --follow` 抽查几个文件，历史还在。

**主会话收尾**：

- 重建 worktree，或者回主工作区开发；
- 更新记忆里写着 `dsh-pet/dsh-pet` 的路径（`local-electron-for-dist` 等）。

## 5. 之后再说

- **拆 `features.ts`**（2891 行）：等历练这一轮收尾、合回 `custom` 以后另写任务书，现在拆会和历练的改动打架。
  - 2026-10-27 排上了：写进 `cultivation-roadmap.md` 的 R1，插在 X17 前面。
- **Windows 功能对齐**：等有 Windows 机器再说。
- **以后要接 DSH**（用户 2026-10-27 定的方向）：不恢复网页版和插件入口 `apply(ctx)`，另做一个薄的桥接插件，放在仓库的子目录（比如 `dsh-plugin/`，自带 `package.json`）。它只做两件事：把 DSH 的会话动态（思考、调工具、完成）转发给桌宠的 `/work-status`，加斜杠命令；和桌宠通信走 `dsh-pet` 命令行、Claude Code hook 用的那套本机接口（`app.json` 里的端口）。
- **图标**：`assets/logo.png` 只有 256px，mac 打包时用 `sips` 放大到 1024，会糊。要换的话用即梦出一张 1024 的。

# dsh-pet 独立应用后续规划（2026-10-24）

给开发 agent 的任务书：每个任务写清现状、改法、测试和验收，主会话负责核验。

- **基线**：`custom` 分支 `fb4ccae`，`npm test` 1093 个全过，typecheck / lint / prettier 干净。
- **进度**（2026-10-24）：T0–T7 全部完成，经主会话核验（含真机）后已提交到 `custom`，`npm test` 1125 个全过。真机没能验证的项目见 §5。
- **进度**（2026-10-26）：T8 完成，经主会话核验后提交，`npm test` 1322 个全过。真机验了回发、探测、手动 IP 单播（改配置即时生效）；设置页那一节用无头浏览器加假接口验证。两台不同网段的真电脑见 §5。
- **路径**：下文代码路径都相对包目录 `dsh-pet/`；仓库根是它的上一级（本文就在根目录的 `docs/` 下）。

## 0. 范围

- **只做独立应用**：改动限于 `runtime/electron-helper`、`src/app`、`src/standalone`，以及它们用到的 `src/shared`、`src/host`。
- **网页版不管**：网页版（`src/client` 的 overlay）不改、不同步，总结里也不提。
- **共享代码**：改 `src/shared` 时，网页端现有的编译和测试仍要通过。

## 1. 任务总览

| 编号 | 任务                     | 依赖               | 主要文件                                                                         | 规模 |
| ---- | ------------------------ | ------------------ | -------------------------------------------------------------------------------- | ---- |
| T0   | 假邻居脚本（测试工具）   | 无                 | `scripts/dev/visit-peer.mjs`（新）                                               | 小   |
| T1   | 客人的气泡贴近头顶       | 无                 | `src/app/visit-windows.ts`                                                       | 小   |
| T2   | 客人跟着自家宠物走       | T1（同一文件）     | `src/app/visit-windows.ts`、`src/app/features.ts`                                | 小   |
| T3   | 固定身份与签名           | T0                 | `src/app/visit-identity.ts`（新）、`visit.ts`、`features.ts`                     | 中   |
| T4   | 邻居记录、提到上次聊的   | T3                 | `src/app/neighbors.ts`（新）、`visit-talk.ts`、`features.ts`                     | 中   |
| T5   | 熟人自动开门、设置页邻居 | T4                 | `app-config.ts`、`app-routes.ts`、`main.ts`、`settings-page.ts`、`features.ts`   | 中   |
| T6   | 回访与邻居排序           | T4                 | `features.ts`                                                                    | 小   |
| T7   | 捎话                     | T5                 | `src/app/note-window.ts`（新）、`visit.ts`、`features.ts`、`app-routes.ts`       | 中   |
| T8   | 跨网段：手动填邻居 IP    | 无                 | `visit.ts`、`app-config.ts`、`settings-page.ts`、`features.ts`、`visit-peer.mjs` | 中   |

**执行顺序**：

1. T0，与 T1 → T2 并行。
2. T3。
3. T4。
4. T5。
5. T6。
6. T7。
7. T8（2026-10-26 加，不依赖别的任务）。

T5、T6、T7 都改 `features.ts` 里的 `visitActions`，必须串行。

## 2. 通用约定（所有任务都适用）

### 2.1 写代码

- **风格**：跟周围代码一致，包括中文注释、注释密度和命名。新的纯逻辑放进新模块并配单测，`features.ts` 只做接线。`features.ts` 已经 1371 行，别再往里堆逻辑。
- **依赖**：不引入新依赖，加密用 `node:crypto`。
- **Electron**：不静态 `import 'electron'`，沿用 `WindowLike` / `FeatureElectron` 的写法，只声明用到的成员。否则 tsc 整仓找不到类型。
- **新增 app-config 字段（容易踩坑）**：这类字段都在 `visit` 对象里，每个都要同时改三处：
  1. 字段本身写 `.default(...)`；
  2. `visit` 对象级的 `.default({...})` 里补上；
  3. `DEFAULT_APP_CONFIG` 里补上。

  漏一处，旧的 `app-config.json` 就会整份校验失败（应用会沿用上一份配置并报错）。`offWork.leadMin` 是现成的例子。
- **对方发来的数据**：任何字段先过 `cleanText` / `cleanName`，新字段要有长度上限。显示只用 `textContent`；传进页面时先 `JSON.stringify` 成字面量。
- **外科式修改**：不顺手重构，不格式化无关代码。`src/app/main.ts` 和仓库根的 `README.md` 本来就不是 prettier 干净的，**不要**对它们跑 `prettier --write`。

### 2.2 不能放宽的边界

1. **网络上只传这些**：
   - 昵称、宠物名、按人设生成的台词；
   - T3 起：身份公钥、签名、时间戳；
   - T7：熟人之间主人亲手写的捎话。

   「主人此刻」不出本机，包括前台应用、截图、Claude 进度、人在不在电脑前。
2. **串门台词只用 `compose`**：`compose` 只带人设，不带「主人此刻」。任何会再拼进串门提示词的文本（比如 T4 的见面摘要）也只能用 `compose` 生成。`speak` / `generate` 默认会带上「主人此刻」。
3. **陌生人进门必须主人点头**：没通过签名验证的一律当陌生人。
4. **本机服务不上局域网**：127.0.0.1 上那个本机服务的接口不放到局域网，串门只走 `VisitHost` 那个监听。
5. **和旧版本互通**：旧对端不带新字段时照旧能串门，走人工点头；新字段对旧对端无害。每个协议改动都要有对应的兼容测试。
6. **模型调用有上限**：每个任务写明新增几次调用。现在一次做客大约每边 6–10 次。

### 2.3 验证（按顺序，都在 `dsh-pet/` 下跑）

```sh
npx prettier --check <改动的文件>     # main.ts、根 README 除外
npm run typecheck
npm run lint
npm test
node --check runtime/electron-helper/<改动的 js>   # eslint 忽略 runtime/ 和 scripts/
```

- **测试要求**：修缺陷要加能复现问题的回归测试，新模块配单测。
- **错误清零**：新引入的 lint、类型、测试错误必须清零。不许弱化断言、跳过测试、吞异常。

### 2.4 真机验证

用户已定（2026-10-24）：真机验证由主会话核验时统一做，**开发 agent 跳过本节**。本节留作参考，各任务里的「真机」小节也一样。

**构建与安装**：这一步会替换用户每天在用的 `/Applications/dsh-pet.app`。

```sh
npm run build
DSH_PET_ELECTRON_DIST="$HOME/Library/Application Support/dsh-desktop/harness/electron" npm run dist
osascript -e 'quit app "dsh-pet"'
rm -rf /Applications/dsh-pet.app
ditto dist-app/mac-arm64/dsh-pet.app /Applications/dsh-pet.app
open /Applications/dsh-pet.app
```

**备份与还原用户数据（必做）**：

- 数据目录：`D="$HOME/Library/Application Support/dsh-pet/dsh-pet"`。
- 测试前备份会被写到的文件：
  - `app-config.json`
  - `diary/<今天>.json`
  - `snacks.json`
  - T3 起的 `visit-identity.json`
  - T4 起的 `neighbors.json`
- 测完先退出 app，再还原这些文件。

测试记录不能留在日记里：第二天模型写日记时，会把它们当成真事写进去。

**常用操作**：

- **本机服务端口**：
  ```sh
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['port'])" "$D/app.json"
  ```
- **插件调试路由**：要带 `?pet=main&surface=desktop`，比如 `/position`、`/broadcast`。
- **点右键菜单项**：
  ```sh
  curl -X POST "http://127.0.0.1:$PORT/dsh-pet-7340/menu/click?pet=main" \
    -H 'content-type: application/json' \
    -d '{"owner":"dsh-pet-app","label":"<菜单项>","pet":"main"}'
  ```
- **查看当前菜单**：`GET /dsh-pet-7340/state?pet=main`，结果在 `sections.menu.data.items`。
- **日志**：`~/Library/Logs/dsh-pet/app.log`。串门相关的行以「串门：」开头，接待端口在「串门：接待开了，端口 N」这一行。
- **截图**：`screencapture -x out.png`，屏幕是 2940×1912 像素（Retina，点坐标 ×2），用 ffmpeg 裁剪。
- **浏览器**：开有界面的浏览器（比如看设置页）时，必须带上 `~/.local/bin/headed-browser-args` 输出的参数。弹出钥匙串授权框一律当作拒绝：关掉浏览器，补齐参数再启动。

**做不了的验证**：比如两台真电脑互访、真鼠标点击，在回报里如实写「未验证」。

### 2.5 交付与回报

**交付方式**：

- 用户已定（2026-10-24）：一次只交付一个任务，改动留在工作区，**开发 agent 不提交**。
- 主会话核验通过后，等用户说「提交」再提交，然后才开始下一个任务。提交时逐个文件暂存，禁止 `git add -A`、`git add .`、`git commit -a`。
- T0 和 T1/T2 并行时，各开一个 git worktree。

**回报内容**：

1. 改动文件清单；
2. 和本文设计不一样的地方，以及理由；
3. 跑过的验证命令和结果，失败要贴输出；
4. 真机验证做了什么、没做什么；
5. 遗留问题。

## 3. 任务详情

### T0 假邻居脚本

**目的**：没有第二台电脑，也能让真 app 当主人家或当客人来测，后面每个任务的真机验证都靠它。以前每次都在临时目录现写一份，这次落进仓库。

**文件**：`scripts/dev/visit-peer.mjs`（新）。

- 头注释写清用法，参照 `scripts/dev/mock-server.mjs`。
- 直接 import `../../src/app/visit.ts`。
- 不进 npm 包：`package.json` 的 `files` 没包含 `scripts/dev`。

```sh
node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs host  [--owner 测试邻居] [--pet 小测] [--accept auto|ask]
node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs visit [--port N]
```

**host 模式**（扮演主人家）：

- `VisitHost.listen('127.0.0.1')`，每 2 秒往 `127.0.0.1:47340` 发一条信标。
- 有人敲门时：`--accept auto` 1 秒后让进；`--accept ask` 等标准输入 `y` / `n`。
- 客人说话回一句固定的话，所有事件都打印出来。
- 标准输入命令：

  | 命令        | 调用                               |
  | ----------- | ---------------------------------- |
  | `line <话>` | `tell({ type: 'line', text })`     |
  | `poke`      | `tell({ type: 'poke' })`           |
  | `play <项>` | `tell({ type: 'play', what })`     |
  | `gift <项>` | `tell({ type: 'gift', what })`     |
  | `home`      | `sendHome()`                       |

**visit 模式**（扮演客人）：

- 不给 `--port` 时，从 `app.log` 最后一条「串门：接待开了，端口 N」里读端口。
- 敲门；进门后每 5 秒 ping 一次，并打印收到的 events。
- 标准输入命令：`say <话>`（`/v1/chat`）、`leave`（`/v1/leave`）。

**自动退出**：两种模式都在 10 分钟后自动退出。

**验收**：

- **开发 agent 自测**：开两个终端，脚本自己连自己：一个跑 host，另一个跑 `visit --port <host 打印的端口>`。敲门、聊天、各条命令、告辞都要走通。
- **以下由主会话真机核验。**
- **host 模式**：app 开着串门时，右键「串门」里出现「去 测试邻居 家」。点了之后能进门、能聊天、能回家。
- **visit 模式**：app 冒出「来敲门」的气泡，右键点「让 小测 进来」后出现粉色客人。在脚本里发 `say` 后，客人冒气泡。
- **格式**：`npx prettier --check scripts/dev/visit-peer.mjs` 通过。

### T1 客人的气泡贴近头顶

**现状**：

- 客人页面（`src/app/visit-windows.ts:312`）的气泡是 `margin-bottom:-4px`，底边几乎正好落在 16:9 舞台的上沿。
- 自家宠物的气泡底边伸进**宠物盒** `size × BUBBLE_OVERLAP_RATIO`（`src/shared/fonts.ts:90`，0.108）。但舞台在宠物盒里往下错开了一段脚底垫高（舞台高 × 30/360，舞台高 = 宽 × 9/16，即 0.0469 × 宽），所以气泡伸进**舞台**的深度只有 0.108 − 0.0469 ≈ 0.0611 × 宽。
- 客人气泡（伸进舞台约 4px）比自家宠物的高出约 0.061 × 客人窗口宽，宽 350 时约 21pt。以实现后的截图对比为准。

> 2026-10-24 核验修正：初版方案漏了脚底垫高，让客人直接用 0.108，真机上客人气泡几乎压在头顶（约 6pt，应约 29pt）。下面的改法已更正。

**改法**：

- **下边距**：气泡下边距改成 `calc(-100vw * <伸进舞台的比例>)`。客人窗口宽等于舞台宽，所以 `100vw` 就是舞台宽。
- **系数来源**：比例 = `BUBBLE_OVERLAP_RATIO − (9/16) × (CANVAS_H − FEET_Y) / CANVAS_H`，用 `src/shared/fonts.ts` 和 `src/shared/constants.ts` 里的常量算出来，导出成一个常量后拼进模板字符串，不手写数字。
- **层级与点击**：
  - 气泡加 `position:relative; z-index:1`，盖在画布上面。
  - 气泡加 `pointer-events:none`。光标在身体命中区里点到气泡时，仍要算摸到客人：命中区上沿在 0.15 舞台高处，气泡底边下来以后会到约 0.19 舞台高处。
- **可选**：加一个和自家气泡同款、朝下的小尾巴，不强求。
- **不动**：`BUBBLE_ROOM`、`guestBounds` 不改，窗口尺寸和脚底对齐的现有测试保持不变。

**测试**：在 `src/app/visit-windows.test.ts` 加一条契约测试，写法参照 `src/shared/fonts.test.ts`：

- 导出的比例约等于 0.0611（即 `BUBBLE_OVERLAP_RATIO − 9/16 × 30/360`），`guestPage` 里含 `calc(-100vw * ${这个常量})`；
- `#bubble` 的规则里有 `pointer-events:none`。

**真机**：

1. 用 T0 visit 模式让客人进门，`say` 一句。
2. 截图，量客人和自家宠物的「气泡底边到头顶」距离。
3. 按客人的缩放比例换算后，两者相差不超过 6pt。

### T2 客人跟着自家宠物走

**现状**：

- `openGuestWindow`（`visit-windows.ts:209`）开窗时按当时的 `PetBox` 定好位置，之后窗口不再动。
- 命中区 `petHitRect` 也只在开窗时算一次。
- 自家宠物会自己走动、会被拖走，客人却留在原地。

**改法**：

- **参数**：`openGuestWindow` 的 `home` 参数从快照改成取值函数 `() => PetBox | null`。`features.ts` 的 `letIn` 传 `homePet.box`。
- **新纯函数**：`followGuest(current: Rect, side, home, workArea): { bounds; side } | null`，便于单测。
  - 按 `guestBounds` 的规则算目标位置，**优先留在当前这一边**，只有这一边放不下才换边。
  - 和当前位置相差不到 1px 时返回 `null`。
  - `guestBounds` 加一个可选参数 `prefer: 'left' | 'right'` 来实现「优先这一边」；不传时行为和现在一样，现有测试不改。
- **跟随定时器**：窗口里加一个跟随定时器 `FOLLOW_MS = 50`，和 `HOVER_MS` 分开。
  - 每拍取一次 `home()`；位置有变化就 `setBounds`，并重算命中区（hover 定时器读的那个 `hit` 变量）。
  - 换边时页面要转身：`guestPage` 加 `guest.face(facing)`，`arrive` 复用它。
  - `workArea` 取自家宠物中心所在的那块屏：宠物被拖到另一块屏时，客人跟过去。
  - `home()` 返回 `null`（没收到自家宠物的位置）时客人不动。
- **朝向**：`GuestWindow.side` 改成随换边更新的 getter。`playTogether` 靠它决定自家宠物朝哪边。
- **类型**：`WindowLike` 加 `setBounds(rect: Rect): void`。

**测试**：给 `followGuest` 写单测，覆盖：

- 跟着平移；
- 左边放不下时换到右边，而且只在放不下时才换；
- 宠物回到屏幕中间后客人仍留在右边，不来回跳；
- 差不到 1px 不动；
- 换到另一块屏。

**真机**：

- 客人进门后拖动自家宠物，再等它自己走一段：客人一路跟着，脚底一直对齐。
- 把自家宠物拖到屏幕最左边：客人换到右边并转身。
- 再右键「和 X 一起玩」：自家宠物面朝客人。

**已核对、不用做**：之前列过「转播的气泡挡住状态行」。桌宠的气泡只有一个槽位（`sprite.js` 的 `renderBubble`），优先级是：终态任务 > 碎碎念 > 余额 > 非终态任务。转播占的是碎碎念槽，「在 X 家做客 · 剩 N 分」是非终态任务，所以转播的 8 秒里状态行让位，之后自己回来，两者不会叠在一起。

### T3 固定身份与签名

**目标**：重启后还认得对方，并为 T5（熟人自动开门）和 T7（捎话）提供防冒充的身份。信标里的名字和 id 都是明文广播，谁都能抄，所以身份必须靠签名。

**现状**：

- `features.ts:228` 的 `visitId = randomUUID()` 每次启动都换。
- 敲门只带 `owner` / `pet`，主人家只按地址认客人。

**身份模块**：新建 `src/app/visit-identity.ts`，配单测。

- **密钥**：每台电脑一对 Ed25519 密钥，用 `crypto.generateKeyPairSync('ed25519')`。已在本机打包用的 Electron 43.3 / Node 24.18 上实测：签名、验签都可用，SPKI DER 44 字节。
- **存放**：
  - 存在 `$DSH_HOME/dsh-pet/visit-identity.json`，文件权限 0600，内容 `{ "v": 1, "key": "<PKCS8 PEM>" }`。
  - 不放进钥匙串，因为会弹授权框。
- **编码**：
  - `id` = 公钥 SPKI DER 的 sha256，取前 32 个十六进制字符；
  - `pub` = SPKI DER 的 base64（60 字符）。
- **文件异常**：
  - 文件不存在 → 生成一对新的。
  - 读不了或内容坏了 → 把原文件改名为 `.bad-<时间>`，明确 warn，再生成新的。不静默覆盖。
- **导出**：
  - `loadVisitIdentity(path, warn)`；
  - `resetVisitIdentity(path)`；
  - `idOfPub(pub): string | null`：校验确实是 Ed25519 SPKI，不是就返回 `null`；
  - 签名、验签函数，以及下面两种签名内容的拼装函数。

**协议改动**（全部向后兼容，信标仍是 `v: 1`）：

| 位置           | 改动                                                                    | 旧对端                                            |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| 信标           | `id` 改用身份 id（schema 不变）                                         | 照常解析                                          |
| `/v1/knock` 请求 | 加 `id, pub, ts, sig`（客人签）                                       | 旧主人家只读 `owner` / `pet`                      |
| `/v1/knock` 应答 | 加 `id, pub, sig`（主人家签）                                         | 旧客人只读 `ok` / `token`；新客人收不到就当没认出 |

**签名内容**（字段之间用 `\n` 连接）：

- **敲门（客人签）**：
  ```
  dsh-pet/knock/v1
  <主人家 id，来自信标>
  <客人拨的地址>:<端口>
  <ts，毫秒>
  <owner>
  <pet>
  ```
- **进门应答（主人家签）**：
  ```
  dsh-pet/welcome/v1
  <客人 id>
  <本机收到这个连接的地址>:<接待端口>
  <token>
  ```

**主人家验证**（在 `VisitHost.knock` 里做，要把 `req` 传进去，好拿 `req.socket.localAddress`）。按顺序检查：

1. 四个字段都是字符串，且有长度上限（`pub`、`sig` ≤ 100 字符）。
2. `idOfPub(pub) === id`。
3. `|now − ts| ≤ 120 秒`。
4. `(id, ts)` 没出现过：防重放缓存，条目 120 秒过期，最多存 256 条。
5. 用 `localAddress`（去掉 `::ffff:`）加监听端口拼出签名内容，再 `crypto.verify`。

- **任何一步不过**：**不拒绝**，当陌生人处理（`Visitor` 不带 `id`），日志里记下原因。
- **全部通过**：`Visitor.id = id`。`Visitor` 类型加可选的 `id`。

**客人验证**：`knockOn` 返回后，三条都满足才记 `Trip.verified = true`：应答里的 `id` 等于信标里的 id；`idOfPub(应答里的 pub)` 也等于这个 id（只核对填写的 id 不够，冒充者可以填熟人的 id、再用自己的密钥签名）；签名对得上。否则当作没认出主人家：T4 不记录，T7 不捎话。

**为什么签名里要带地址**：防「假信标 + 转发」。有人可以广播一条抄来的熟人 id、地址写成自己，客人敲到它那里，它再把签名转给真主人家。签名里带了地址，转发后地址对不上，两边都能识破。ARP 欺骗那一级的真正中间人，明文 HTTP 防不住，这一档不防；T5 的设置页说明里要写清楚。

**其他**：

- **设置页说明**：「局域网串门」的说明里加一句：开着串门时，同一网络里的人能认出这台电脑。重置身份的按钮放在 T5 的「邻居」一节。
- **T0 脚本升级**：
  - 加 `--identity <路径>`，缺省在系统临时目录建一份；`--identity none` 模拟旧版本，不签名。
  - host 模式验签，并打印 `verified`；visit 模式敲门时签名。
- **模型调用**：不增加。

**测试**：`src/app/visit-identity.test.ts`、`src/app/visit.test.ts`。

- **身份文件**：
  - 生成后重读，得到同一个 id；
  - 坏文件被改名，换成新身份并 warn；
  - 文件权限是 0600。
- **敲门签名**：
  - 签名正确 → `visitor.id` 有值。
  - 以下每种情况都当陌生人，而且仍能人工让进：
    - 不带签名（旧版本）；
    - `id` 和公钥对不上；
    - `ts` 超过 120 秒；
    - 重放同一个 `(id, ts)`；
    - 签名里的地址和本机地址不同（模拟转发：客人按 `127.0.0.2` 签，主人家在 `127.0.0.1`）；
    - 篡改了 `owner`。
- **应答签名**：
  - 客人验证通过；
  - 地址不符时不通过；
  - 旧主人家不带签名：照常进门，但不是 verified。
- **信标**：重启后 id 不变。

**真机**：

- T0 两种模式都跑一遍，日志里能看到 verified。
- 重启 app 后，T0 host 收到的 app 信标 id 不变。

### T4 邻居记录、见面提到上次聊的

**目标**：记住来往过的邻居，下次见面打招呼时能提到上次聊了什么。记录只存本机。

**邻居簿**：新建 `src/app/neighbors.ts`，配单测。类名 `NeighborBook`。

- **文件**：`$DSH_HOME/dsh-pet/neighbors.json`，先写临时文件再改名，和 `saveAppConfig` 一样。坏文件按 T3 的办法处理：改名 + warn。
- **记录结构**：
  ```ts
  interface NeighborRecord {
    id: string;
    owner: string; // 每次见面更新成最新的（已清理）
    pet: string;
    friend: boolean; // T5 用；T4 里恒为 false
    hosted: number; // 来我家做客的次数
    visited: number; // 我去它家的次数
    firstMet: number;
    lastMet: number;
    summary: string; // 最近一次见面的摘要，≤ LINE_MAX
  }
  ```
- **方法**：
  - `get`；
  - `list`：熟人在前，其余按 `lastMet` 倒序；
  - `met(id, names, 'hosted' | 'visited', now)`；
  - `setSummary`、`setFriend`、`forget`、`clear`。
- **上限**：最多 50 条，超了先丢最久没见的非熟人。

**只记验证过身份的**：主人家这边要求 `visitor.id` 有值，客人这边要求 `trip.verified` 为真。

**什么时候记**：

- `letIn` 进门时：`met(…, 'hosted')`。
- `startTrip` 时：`met(…, 'visited')`。

**见面摘要**：

- **时机**：见面结束（`seeGuestOff` / `comeHome`）后生成。条件：开着「串门时用模型聊天」，且这次聊过至少 2 句。
- **生成方式**：用 `compose` 按聊天记录写一句给自己以后看的备忘。新提示词 `memoPrompt(owner, pet, lines)` 放在 `visit-talk.ts`。
- **失败时**：生成不了就保留旧摘要。
- **必须用 `compose`，因为它只带人设**：摘要会拼进下次的串门提示词，也就会间接发到对方电脑上；`speak` / `generate` 带「主人此刻」，会把主人在干嘛漏出去。同样的原因，**不要**拿回家讲见闻那句（`travelPrompt` 走 `speak`）当摘要。
- **不能 await**：`comeHome` 里不能 await 摘要生成。它可能正是从说话队列里被叫回家的，等就会死锁（见 `comeHome` 的头注释）。用 `void compose(...).then(...)`。

**用进提示词**：

- `guestPrompt` / `hostPrompt` 加一个可选的 `memory` 参数。有记录时，在场景里加一句：`你们之前见过 N 次，上次是 X 前，上次聊了：「摘要」。`
- 时间格式用现成的（`activity.ts` 的 `durationText` 一类）。
- 客人进门打招呼（`GUEST_ASK.greet`）和主人家第一次起话题时，加一句提示：「可以提一句上次聊的」。
- 摘要里含有对方说过的话：照旧当引用数据处理，过 `cleanText` 截断。

**模型调用**：每次见面每边 +1（写摘要）。

**测试**：

- `neighbors.test.ts`：增改；排序；超上限时淘汰非熟人、不淘汰熟人；坏文件；重启后还在。
- `visit-talk.test.ts`：有 memory 和没有 memory 时的提示词。

**真机**：

- T0（带身份）来访两次：第二次打招呼时提到上次聊的，`neighbors.json` 里 `hosted` 为 2。
- `--identity none` 来访：不记录。

### T5 熟人：自动开门、设置页「邻居」一节

**熟人是什么**：本机单方面的标记，表示我把谁当熟人，跟对方怎么看我无关。存在 `NeighborBook` 的 `friend` 字段。

**配置**：

- `visit` 加 `autoAdmitFriends: boolean`，默认 `false`，按 §2.1 改三处。
- 设置页「局域网串门」一节加一个勾选项「熟人来敲门直接请进」，挂在总开关下面，加进 `visitDetails` 数组。

**右键菜单**：

- 家里来了验证过身份的客人，或者自己出门在验证过身份的主人家时，加一项 `把 X 设为熟人` / `X 不再是熟人`（X 是对方主人的昵称）。
- 没验证过身份的，不出这一项。
- 项数检查：家里有客时 2（固定）+ 1（送客）+ 8（一起玩）+ 最多 5（零食）+ 1 = 17，不超过插件的 20 项上限。

**自动开门**（在 `hostHandlers.knocked` 里判断）：

- **条件**：同时满足以下三条，就直接 `letIn(true)`，宠物说「熟人 X 家的 Y 来啦，直接请它进来～」，不再说「右键点让进」那句：
  - `visitor.id` 是熟人；
  - 开了 `autoAdmitFriends`；
  - 主人此刻在电脑前（`tracker.snapshot()?.present`）。
- **主人不在电脑前**：照旧等主人点头。没人看着，就别让两只宠物对着空屏幕调模型。
- **照旧的限制**：敲门冷却、一次只接待一位，都不变。
- **实现建议**：判断抽成纯函数 `shouldAutoAdmit(...)` 单测。
- **为什么在 `knocked` 里能直接让进**：`VisitHost.knock` 在调用 `knocked` 之前就挂好了 `pending`，所以 `knocked` 里同步 `answer(true)` 是安全的。

**冒名提示**：敲门的没验过身份，但昵称和某个熟人一样时，敲门那句改成「自称是 X 家的 Y，可我没认出来，要让它进来吗？」。

**设置页新增「邻居」一节**：只有独立应用有。CLI 下路由是 404，这一节保持隐藏，照 `app-settings` 的做法。

- **路由**：`/standalone-ai/app-neighbors`。
  - 挂在 `main.ts` 里那组令牌校验的路由下，和 `app-settings` 同级。
  - 处理函数放 `app-routes.ts`：`appNeighborsHandler(() => features)`；`features` 还是 `null` 时回 503。
- **GET**：回 `{ id: <本机身份 id 前 8 位>, neighbors: NeighborRecord[] }`。
- **POST**：参数用 zod 校验，非法回 400。
  - `{ action: 'friend', id, friend }`
  - `{ action: 'forget', id }`
  - `{ action: 'clear' }`
  - `{ action: 'reset-identity' }`：串门进行中（家里有客、自己在外、正在敲门）时回 409。
- **页面**：
  - 每行显示「昵称 · 宠物名 · 来过 n 次 / 去过 n 次 · 上次见面」，后面是熟人勾选框和「忘掉」按钮。
  - 这些操作点了立即生效，不跟整页的保存按钮走。
  - 底部有「全部忘掉」和「重置我的串门身份」，点之前都先 `confirm`。
  - 说明文字：记录只存本机；重置身份后大家都不认得这台电脑了；局域网里有人做中间人时防不住冒充。
- **features 接口**：暴露 `neighbors: { list, setFriend, forget, clear, resetIdentity }`。`resetIdentity` 换掉密钥后关掉信标和接待，下一拍 `syncVisit` 用新身份重开。

**模型调用**：不增加。

**测试**：

- `app-config.test.ts`：旧文件缺新字段时补上默认值。
- `app-routes.test.ts`：GET；POST 的每个 action；非法参数；409；503。
- `src/standalone/settings.test.ts`：「邻居」一节的显隐、列表渲染、各按钮发出的请求体。
- `shouldAutoAdmit` 单测：熟人 + 开关打开 + 主人在场，三者同时满足才是 true。

**真机**：

- T0 host（带身份）先来访一次 → 设为熟人 → 打开自动开门 → T0 visit 敲门，直接进门。
- 关掉开关后，又要主人点头。
- 冒名：换一个身份、用同样的昵称来敲门，出现「没认出来」的提示。
- 设置页「忘掉」「重置身份」之后的表现符合预期。
- 设置页从右键「打开网站」进入（地址带令牌），能正常保存。

### T6 回访与邻居排序

**「串门」子菜单排序**：

1. 熟人在前，后缀「（熟人）」；
2. 其次是见过面的，按 `lastMet` 倒序；
3. 最后是陌生邻居，按昵称排序。

菜单项长度：插件限制每项 32 字（含子菜单前缀）。最长的「串门/去 <12 字昵称> 家（熟人）」是 23 字，够用。

**回访**：

- 客人走后 2 小时内，如果它还在邻居列表里，就在子菜单最上面放一项 `串门/回访 X 家`。只放最近那一位，点了就是 `goVisit`。
- 按 id 对上：T3 之后信标 id 就是身份 id。没验证过身份的客人，不出回访项。
- 回访项也算在 `MENU_NEIGHBORS_MAX`（15）里。

**实现**：纯逻辑抽成 `orderNeighbors(neighbors, book, lastGuest, now)`，单测覆盖排序、回访项出现和过期、未验证不出。

**真机**：

1. T0 visit 模式（指定一个 `--identity` 文件）来访后离开。
2. 再用同一个身份文件跑 T0 host 模式。
3. 右键「串门」第一项是「回访 测试邻居 家」，点了能敲进 T0 host 的门。

### T7 捎话

**目标**：主人写一句话，让宠物带给对方主人，对方也能回一句。只对熟人开放：

- **发送方**：只有对方是自己的熟人时，才显示捎话的菜单项。
- **接收方**：只收自己熟人的捎话；不收时回 `{ ok: false, reason: 'not-friend' }`。

**输入方式**：用户已定（2026-10-24）用小输入窗。

- **小输入窗**：
  - 右键「捎话给 X」后，宠物旁边弹出一个小窗。新模块 `src/app/note-window.ts`，写法照 `openGuestWindow`；页面由本机服务的 `GET /app/note` 提供（和 `/app/guest` 同法）。
  - 一行输入框，限 60 字；回车发送，Esc 取消，2 分钟不动自动关。
  - 窗口要能拿焦点（`focusable: true`）：这是用户主动点出来的，中文输入法要能用。
  - 主进程用 `await win.webContents.executeJavaScript('note.wait()')` 拿结果：页面返回一个 Promise，提交时 resolve 成文本，取消时 resolve 成 `null`。窗口被关掉时 reject，当取消处理。不开 preload，也不开 IPC。
  - 同一时间只开一个；已经开着就把它提到前面。
- **没选的方案**：在浏览器里打开一个带令牌的本地页面来写。要切到浏览器，体验是断开的。

**协议**：

- **客人 → 主人家**：`POST /v1/note { token, text }`。
  - `text` 过 `cleanText`，≤ `LINE_MAX`。
  - 回 `{ ok: true }`，或 `{ ok: false, reason: 'not-friend' | 'too-many' }`。
  - 旧主人家没有这个路径（404）时，客人这边说「对方的版本太旧，捎不了话」。
- **主人家 → 客人**：`HostEvent` 加 `{ type: 'note'; text }`，`parseEvents` 认它。旧客人会丢掉不认识的事件（现有行为）。
- **限额**：每趟每个方向最多 5 条，两条之间至少隔 10 秒。

**显示**：

- **主人家这边**：客人窗口的气泡显示「X 托我带话：……」，持续 20 秒。自家宠物不复述。
- **客人这边**：转播「（Y 带回 X 的话）……」，持续 15 秒。
- **发送的人**：宠物要告诉主人「捎到啦」，或者失败的原因：
  - 对方不是熟人；
  - 已经回家了；
  - 对方版本太旧；
  - 发太多了。

**不进提示词，不进日记正文**：

- 捎话原文是不可信文本，不拼进任何提示词。
- 日记会喂给模型写日记，所以日记里只记「帮主人给 X 捎了句话」「X 托 Y 带来一句话」，不记内容。
- 日记的 kind 沿用 `visit`，不新增枚举值。

**配置与菜单**：

- **配置**：`visit` 加 `notes: boolean`，默认 `true`，设置页文案是「和熟人互相捎话」，按 §2.1 改三处。
- **菜单**：出门在熟人家时，加「捎话给 X」；家里来了熟人的客人时，也加「捎话给 X」（托客人带回去给它的主人）。家里有客时，菜单项数变成 T5 的 17 项再加 1，共 18 项，仍不超过 20 项的上限。

**模型调用**：不增加。

**假邻居脚本跟着升级**（2026-10-24 补充）：`scripts/dev/visit-peer.mjs` 加捎话命令，好在真机上测两个方向——host 模式 `note <话>`（攒一条 note 事件捎给客人），visit 模式 `note <话>`（`POST /v1/note`），两种模式都打印收到的捎话和对方回的结果。

**测试**：

- `visit.test.ts`：
  - `/v1/note`：熟人的收下；非熟人的拒绝；超条数、间隔太短被拒；超长截断。
  - `note` 事件的解析。
  - 客人遇到旧主人家 404 时的处理。
- `note-window.ts`：页面契约，包括 `maxlength="60"`、显示用 `textContent`、`note.wait` 的约定。

**真机**：

- 互为熟人时，两个方向各捎一条话，截图。
- 不是熟人时，菜单里没有捎话这一项。
- 在小输入窗里用中文输入法打字。

### T8 跨网段：手动填邻居 IP

**现状**：信标只发往本机各网卡的广播地址（`broadcastAddresses`），路由器不转发广播，所以两台电脑在不同网段（比如公司里 192.168.10.x 和 192.168.11.x）时互相看不到。看到之后的敲门、聊天、切磋走 HTTP，接待端只查 `isLanAddress`，跨网段本来就能连。`Neighborhood` 的 `targets` 选项能改发往地址，但它是**替换**广播地址，而且只有测试在用。

**目标**：设置页填上对方电脑的 IP，信标除了照常广播，再单播一份过去；对方回发，所以**一边填就够**，两边都能看到。

**配置**：

- `visit` 加 `peers: string[]`，默认 `[]`，按 §2.1 改三处。
- 每一项必须是点分 IPv4（每段 0–255），并且 `isLanAddress` 为真；最多 20 项。不合格整份配置 400，不静默丢掉。
- 校验函数 `isPeerAddress(value)` 放 `visit.ts` 导出并单测，`app-config.ts` 引它（`visit.ts` 的依赖链里没有 `app-config`，不会循环）。

**协议**：

- **信标不变**：内容、端口、字段都不动。
- **新增探测**：`{ app: 'dsh-pet', v: 1, probe: true }`，不带身份、昵称、宠物名。导出 `encodeProbe()` 和 `isProbe(raw)`。
  - 用途：只出门、不接待的一方，`announce()` 是 null，不发信标；它也要让对方知道「往这儿回」。
  - 旧版本收到探测时，`parseBeacon` 解析失败返回 null，直接丢掉，无害。

**`Neighborhood` 的改法**：

- **新选项** `peers?: () => Array<{ address: string; port: number }>`：手动邻居。它**追加**在默认广播地址（或测试注入的 `targets`）后面，不替换。每次发送时现取，设置页改了下一拍生效。
- **回发名单**：记下「需要单播回去」的地址。
  - **什么时候记**：收到信标（不是自己的）或探测，并且 `shouldReply(info.address)` 为真时，记下 `{ address: info.address, port: info.port, seenAt }`。`receive` 要拿到 `info.port`：发信标用的就是绑定的那个 socket，源端口就是对方的监听端口。正式环境里是 47340，测试里是随机端口。
  - **过期**：`NEIGHBOR_TTL_MS` 内没再收到就丢。
  - **上限**：最多 32 个，满了丢最久没收到的。
  - **`stop()`**：一并清空。
- **`shouldReply(address, interfaces = networkInterfaces())`**（纯函数，导出并单测）：`isLanAddress(address)` 为真，并且这个地址不在本机任何一块「有广播地址」的 IPv4 网卡的网段里。
  - 本网段的邻居已经被广播覆盖，不用回发。
  - `internal`（回环）网卡和 /31、/32 网卡（VPN 隧道、Tailscale）不算覆盖。所以 `127.0.0.1` 和 Tailscale 的 `100.x` 都要回发；测试和假邻居脚本都靠这一点。
- **`send()`**：
  - `announce()` 不是 null 时：信标发往 默认广播（或 `targets`）+ `peers()` + 回发名单里没过期的，按 `address:port` 去重。
  - `announce()` 是 null 时：只往 `peers()` 发探测。不发广播，不发给回发名单。
- **新地址立刻回一条**：回发名单里**新加**一个地址、并且 `announce()` 不是 null 时，马上单播一条信标给它，不等下一个 5 秒。已经在名单里的只刷新 `seenAt`，不额外发，免得来回放大。
- **探测不进邻居列表**：探测只影响回发名单。
- **测试钩子**：测试里等 5 秒太慢的话，可以加一个只给测试用的 `intervalMs` 选项，照 `port` / `now` 的写法。

**接线（`features.ts`）**：

- `openNeighborhood` 传 `peers: () => deps.appConfig().visit.peers.map((address) => ({ address, port: deps.beacon?.peerPort ?? BEACON_PORT }))`。
- `FeatureDeps.beacon` 加 `peerPort?: number`，注释写明只给测试用。
- `features.ts` 只接线，回发、探测、去重都在 `visit.ts` 里。

**设置页（`settings-page.ts`）**：

- 「局域网串门」一节，昵称 / 停留时长那一对下面加一个 `<textarea id="visitPeers" rows="3" spellcheck="false" placeholder="192.168.11.23">`。
  - 标签：「别的网段里的邻居（对方电脑的 IP，一行一个）」。
  - 加进 `visitDetails`，跟着总开关变灰。
- **回填**：`data.visit.peers` 用 `\n` 连起来。
- **保存**：按空白、英文逗号、中文逗号、顿号、分号切开，去掉空项，去重，发数组。
- **前端校验**：有不合格的项（不是局域网 IPv4，或者超过 20 项）时，用 `setCustomValidity` 写明是哪一项不对，让 `reportValidity` 拦住保存。服务端的 zod 校验仍是准绳。
- **说明文字**（`aria-describedby`）：

  > 在不同网段（比如公司里另一层楼，或有线和 Wi-Fi 分在两个网段）时广播过不去，彼此看不到。填上对方电脑的 IP（在对方的「系统设置 → 网络」里能看到），这台电脑就会把信标直接发过去，对方会回发，所以一边填就够；要被看到的一方得开着「允许别人来我家做客」。对方的 IP 变了要重填。只能填局域网地址（10.x、172.16–31.x、192.168.x，Tailscale 的 100.x 也行）。两边之间的防火墙要放行 UDP 47340 和接待端口；只 ping 得通不算数。

**假邻居脚本（`scripts/dev/visit-peer.mjs`）跟着升级**：

- **host 模式**：打印发信标的那个 socket 收到的信标，比如「听到 X 家的信标（回发）」。新版 app 会回发，真机能看到。
- **新增 `listen` 模式**：扮演只出门、不接待的新版本。每 2 秒往 `127.0.0.1:47340` 发探测，打印收到的信标，10 分钟自动退出。头注释的用法跟着补上。

**§2.2 边界**：

- 信标内容不变。
- 单播只发往两类地址：设置里填的局域网地址；主动联系过来、并且 `isLanAddress` 的地址。
- 探测里什么都不带。

**和旧版本互通**：

- 旧版本收到单播信标照常显示，探测直接丢掉。
- 旧版本不会回发：跨网段时，旧版本能看到新版本、能来做客；新版本看不到旧版本。这是已知限制，不用特判。

**README**：仓库根 `README.md` 「局域网串门」那一格补一句：不在同一网段、广播过不去时，在设置里填上对方电脑的 IP 就能互相看到。手动改，**不要**跑 prettier。

**模型调用**：不增加。

**测试**：

- `visit.test.ts`：
  - `isPeerAddress`：合格的局域网 IPv4 通过；公网地址、256、首尾带空格、IPv6、主机名、空串都不通过。
  - `shouldReply`：用假的 `networkInterfaces`。同网段 → false；别的局域网段 → true；公网 → false；本机只有 /32 的 Tailscale 网卡时，`100.x` → true；`127.0.0.1` → true。
  - 探测：`parseBeacon(encodeProbe())` 是 null（旧版本当垃圾丢掉）；`isProbe` 不认信标、不认垃圾。
  - `Neighborhood`：
    - `targets: () => []` 加 `peers: [b]` 时，b 能看到 a（证明是追加，不是替换）。
    - a 填了 b、b 没填 a，a 很快就能看到 b，不用等 5 秒（立刻回一条）。
    - a 不接待（`announce` 是 null）、填了 b 时，a 能看到 b；b 的邻居列表里没有 a。
    - 回发名单过期后不再给它发（用假时钟，必要时配 `intervalMs`）。
    - 超过 32 个时丢最久没收到的那个。
- `app-config.test.ts`：旧文件缺 `peers` 时补 `[]`；公网地址、格式不对、超过 20 项都被拒。
- `src/standalone/settings.test.ts`：
  - 回填。
  - 保存时的请求体：混合分隔符、去重。
  - 不合格的项拦住保存，提示里点名是哪一项。
  - 总开关关着时变灰。
- `features.test.ts`：配置里 `peers: ['127.0.0.1']`，`beacon.peerPort` 指向测试自己开的 UDP socket。接待开着时，这个 socket 收到信标；关掉「允许别人来我家做客」后，收到的是探测。

**真机**（主会话做）：

- 真 app 开着串门，跑 `visit-peer host`：脚本打印出 app 回发的信标，右键「串门」里照旧有「去 测试邻居 家」。
- 跑 `visit-peer listen`：脚本收到 app 的信标；关掉 app 的「允许别人来我家做客」后，就收不到了。
- 设置页的「别的网段里的邻居」：填一个公网地址被拦住；填合格的地址，保存后 `app-config.json` 里有 `peers`。
- 两台在不同网段的真电脑：主会话做不了，列进 §5。

## 4. 想法池（先不排期）

| 想法                     | 说明                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| 甩到别人屏幕上           | 把某条屏幕边缘当成通往某个邻居的门，甩出去的宠物按原速度落到对方屏幕上。需要实时通道 |
| 跨网络串门               | 用中转服务或 Hyperswarm，要考虑隐私和运维成本；公司网络下打洞不保证成功               |
| 客人显示对方自己的皮肤   | 皮肤素材有几 MB，要过网络传文件，安全面明显变大                                         |
| Claude 权限一键批准      | 在气泡上直接点「允许 / 拒绝」：Claude Code 的 hook 要等桌宠的答复。这等于替主人批准操作，需要单独做安全设计 |
| 扔个球、趴在窗口上、跟音乐摇摆、捣蛋模式、屏幕底部挂机小游戏 | 来自之前的调研，各自独立，可以挑着做                                  |

## 5. 需要用户自己做的验证

- **真鼠标点客人**：T0 做好后一个人就能测——跑 visit 模式让客人进门，用鼠标点粉色客人。
- **两台真电脑互访**：到现在只在本机测过。公司网络可能拦广播，或者需要授权「本地网络」，这些问题只有两台电脑之间才会暴露。
- **跨网段**（T8）：两台不同网段的电脑，只在一边填对方的 IP，两边都应当能在右键「串门」里看到对方，并且能互相做客。只出门、不接待的那一边填了对方的 IP，也要能看到对方。
- **设置页保存**：在 app 里从右键「打开网站」进入设置页，保存一次（走令牌校验）。顺带看一眼 T5 的「邻居」一节：列表、熟人勾选、忘掉、重置身份（令牌只在右键打开时生成，主会话测不到浏览器里的这一节）。
- **熟人直接请进**（T5）：开着「熟人来敲门直接请进」、人在电脑前时，熟人敲门应当不用点头直接进门。核验时主人一直不在电脑前，只验了「不在时照旧等点头」。
- **在小输入窗里打字**（T7）：用中文输入法写一句捎话，回车发送；组字时的回车 / Esc 不应发送或关窗。主会话不模拟键盘输入，只验了小窗能弹出、拿到焦点、超时自动关。
- ~~测试记录~~：2026-10-24 日记账里 7 条「小李家的阿花」测试记录已删除（2026-10-24）。

## 6. 主会话的核验清单（每次交付）

1. **范围**：`git status` 和 `git diff --stat` 里只有本任务的文件；没有无关的格式化；没有新依赖；没碰 `src/client`。
2. **读 diff**：逐行读完整 diff，对照 §2.2 的边界和本任务的设计。和设计不一样的地方必须有理由。
3. **重跑验证**：重跑 §2.3 的全部命令，和 agent 的回报对照。
4. **回归测试**：抽查回归测试能不能真的复现问题，必要时临时撤掉实现，看测试是否会失败。
5. **真机**：构建安装，用 T0 脚本走一遍本任务的真机步骤并截图；测完还原用户数据（§2.4）。
6. **结论**：通过，或打回并列出具体问题。通过后等用户说「提交」再提交。

## 7. 派发用的提示词

每次派一个任务，把下面的 `<编号>` 换掉。T0 可以和「T1 + T2」同时派给两个 agent，但两边要各开一个 git worktree。

```text
你在 /Users/yfan/work/dsh-pet/dsh-pet（dsh-pet 独立 macOS 桌宠应用，分支 custom）里开发。
先完整读一遍 /Users/yfan/work/dsh-pet/docs/standalone-roadmap.md 的 §0、§2，再读 §3 里的 <编号>，只做 <编号>。

要求：
- 照 §3 <编号> 的设计实现，照 §2.3 跑完验证。
- 跳过 §2.4 的真机验证：不要构建安装 app，不要动 /Applications/dsh-pet.app 和用户数据目录，也不要连正在运行的 dsh-pet app（会往用户的日记里写测试记录）。真机验证由 Claude 核验时做。
- 和设计不一样、或者设计里没写清的地方，选错了代价低、改得回来的做法继续，回报里写明；改动面大或改不回来的，先停下来问。
- 不要 git commit，不要 push；改动留在工作区。
- 做完按 §2.5 回报：改动文件清单、和设计的偏差及理由、验证命令和结果、真机验证做了和没做的、遗留问题。
```

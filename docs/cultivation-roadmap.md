# 修炼与对战任务书（2026-10-24）

给开发 agent 的任务书：每个任务写清现状、改法、测试和验收，主会话负责核验。设计依据和取舍理由见同目录的 `cultivation-battle-research.md`（下称「设计」），本文以本文为准。

- **基线**：`custom` 分支 `52cbf5e`，`npm test` 1125 个全过，typecheck / lint / prettier 干净。
- **路径**：下文代码路径都相对包目录 `dsh-pet/`；仓库根是它的上一级。
- **动画素材**：由主会话用即梦生成，放进 `assets/webm/`，名字见 §2.3。开发 agent 不生成、不改素材。

## 0. 范围

- **只做独立应用**：改动限于 `runtime/electron-helper`、`src/app`、`src/standalone`、`src/host`（只有 X3 的 `/anim` 加 `rate` 要动），以及 `scripts/dev/`。
- **网页版不管**：`src/client` 不改、不同步。改 `src/shared` 或 `src/host` 时，网页端现有的编译和测试仍要通过。
- **只做全自动对战**：手动对战只在引擎里留口子（X0），界面和协议都不做。

## 1. 任务总览

| 编号 | 任务                           | 依赖   | 主要文件                                                                                                | 规模 |
| ---- | ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------- | ---- |
| X0   | 战斗引擎、图鉴、解说（纯逻辑） | 无     | `src/app/battle.ts`、`battle-lines.ts`（新）、`scripts/dev/battle-sim.mjs`（新）                        | 中   |
| X1   | 修炼核心（纯逻辑）             | X0     | `src/app/cultivation.ts`（新）                                                                          | 中   |
| X2   | 修炼接线：修为来源、菜单、日记 | X1     | `features.ts`、`main.ts`、`app-config.ts`、`diary.ts`                                                   | 中   |
| X3   | 演出与心魔试炼                 | X2     | `src/app/battle-show.ts`、`arena-window.ts`（新）、`visit-windows.ts`、`features.ts`、`/anim` 的 `rate` | 大   |
| X4   | 渡劫与二选一                   | X3     | `cultivation.ts`、`features.ts`                                                                         | 中   |
| X5   | 串门切磋                       | X3     | `visit.ts`、`neighbors.ts`、`features.ts`、`scripts/dev/visit-peer.mjs`                                 | 大   |
| X6   | 设置页「修炼」、README         | X4、X5 | `settings-page.ts`、`app-routes.ts`、`main.ts`、根 `README.md`                                          | 小   |

**执行顺序**：X0 → X1 → X2 → X3 → X4 → X5 → X6，一次一个。X2 起都改 `features.ts`，必须串行。

和设计 §5 的编号不一样：引擎和图鉴提到最前（修炼要用图鉴里的法宝、招式编号），以本表为准。

## 2. 通用约定

`standalone-roadmap.md` 的 §2.1（写代码）、§2.3（验证）、§2.5（交付与回报）全部照用，本节只写差异和新增。§2.4（真机验证）照旧由主会话做，**开发 agent 跳过**。

### 2.1 新增约定

- **`features.ts` 已经 1651 行**：新逻辑一律放新模块并配单测，`features.ts` 只做接线。接线超过 150 行就该想想能不能挪出去。
- **随机数可注入**：纯逻辑模块里凡是用到随机的，都通过参数传入 `rng: () => number`（默认 `Math.random`），测试里传固定序列。对战引擎例外，它用种子（§X0）。
- **持久化**：新文件写法照 `neighbors.ts`：zod 校验；先写临时文件再改名；坏文件改名成 `.bad-<时间戳>` 并 warn，然后当空档重建。
- **新增 app-config 字段**：照旧的三处规则（字段 `.default`、对象级 `.default({...})`、`DEFAULT_APP_CONFIG`）。新的顶层对象 `cultivation` 也一样：对象本身 `.default({...})`，字段各自 `.default`，`DEFAULT_APP_CONFIG` 补上。

### 2.2 不能放宽的边界

1. **修为来源不上网**：在电脑前多久、前台应用、久坐提醒、Claude 干了几次活，一律只在本机算。网上只多传 X5 的「名帖」（境界序号、四项属性、法宝和招式编号、引擎版本）和随机数。名帖不进 UDP 信标。
2. **对方发来的名帖不可信**：过 zod，编号必须在图鉴里，数值不能超过该境界的理论上限（X1 提供 `statCap(stage)`），数组有长度上限。
3. **不做体力**：心魔、切磋不限场次；只给奖励封顶（§X1）。
4. **输了不受罚**：不掉境界、不丢法宝。渡劫失败只扣修为（§X4）。
5. **模型调用有上限**：每个任务写明新增几次。对战过程的解说全用模板，不调模型。
6. **网络上的台词仍走 `compose`**：切磋的赛后感言会转播给对方，只能用 `compose`（只带人设）。

### 2.3 动画素材

主会话生成后放进 `assets/webm/<名字>.webm`（640×360、24 帧、带透明，4–6 秒，首尾都是标准站立，出招一律朝左；宠物朝右时整段镜像）。代码里按名字引用。

**怎么播**：用户层的 `main-config.jsonc` 会整段替换 `animations`，所以新素材**不注册进动画池**，一律用 `/anim` 的 `url` 形态播：`{ url: `${petBase}/thumb/main/${encodeURIComponent(名字)}.webm`, facing }`。`/thumb` 路由按「用户目录 → 包内 assets」找文件，不查动画池。客人窗口（`visit-windows.ts`）本来就直接拿 `/thumb/main/<名字>.webm` 播。

| 名字          | 时长   | 用在                            |
| ------------- | ------ | ------------------------------- |
| 战斗-起手     | 4 秒   | 开场                            |
| 战斗-出拳     | 5 秒   | 空手攻击                        |
| 战斗-受击     | 5 秒   | 挨打                            |
| 战斗-闪避     | 4 秒   | 闪避（没有化鸽遁时）            |
| 战斗-倒地     | 5 秒   | 输了                            |
| 战斗-胜利     | 4 秒   | 赢了                            |
| 修炼-打坐     | 6 秒   | 平时偶尔播                      |
| 修炼-突破     | 5 秒   | 进大境界                        |
| 修炼-挨雷     | 5 秒   | 渡劫挨一道雷                    |
| 修炼-服丹     | 4 秒   | 渡劫前吃破境丹                  |
| 法宝-<法宝名> | 4 秒   | 用这件法宝攻击，8 件见 §X0 图鉴 |
| 招式-<招式名> | 4–5 秒 | 招式触发，10 个见 §X0 图鉴      |

**素材缺失**：个别素材可能晚到或重做。代码里集中一张「事件 → 素材名 + 时长」的表（X3 的 `battle-show.ts`），播之前不检查文件在不在；缺了的那一下只是没动画，气泡照出。主会话核验时负责素材齐全。

## 3. 任务详情

### X0 战斗引擎、图鉴、解说（纯逻辑）

**目标**：一个纯函数引擎：同一组输入加同一个种子，必然打出同一场。不碰 Electron、不调模型、不读写文件。

**新模块 `src/app/battle.ts`**（配 `battle.test.ts`）：

- **图鉴**：法宝和招式各一张表，编号用 ASCII（会上网），显示名用中文。

  | 编号          | 名字   | 品级 | 效果（起点，按 §平衡 调）                |
  | ------------- | ------ | ---- | ---------------------------------------- |
  | `water-gun`   | 水枪   | 凡器 | 6–10，远程：不会被反击                   |
  | `poker`       | 扑克牌 | 凡器 | 3–6，一次两张（两次独立判定命中）        |
  | `shuttlecock` | 毽子   | 凡器 | 5–9，连击率 +10%                         |
  | `balloon`     | 气球   | 凡器 | 4–8，10% 让对方跳过下一次出手            |
  | `juggle`      | 三球   | 灵器 | 3–5，一次三个                            |
  | `top`         | 陀螺   | 灵器 | 8–12，15% 让对方跳过下一次出手           |
  | `whale-tail`  | 鲸尾   | 灵器 | 12–18，重：用它出手后，下次出手间隔 ×1.2 |
  | `firework`    | 烟花   | 神器 | 18–26，必中                              |

  | 编号           | 名字     | 类型 | 效果（起点）                                                    |
  | -------------- | -------- | ---- | --------------------------------------------------------------- |
  | `play-dead`    | 假死遁   | 被动 | 一场一次：致命一击后留 1 点气血                                 |
  | `dove`         | 化鸽遁   | 被动 | 闪避率 +8%                                                      |
  | `bubble`       | 泡泡护体 | 被动 | 一场两次：挡掉一半伤害                                          |
  | `sixth-sense`  | 第六感   | 被动 | 挨了近身攻击后 25% 反击一下（空手伤害）                         |
  | `shadow-fists` | 无影手   | 被动 | 连击率 +15%                                                     |
  | `critical`     | 会心一击 | 被动 | 10% 伤害 ×2                                                     |
  | `spirit-beast` | 灵兽助阵 | 被动 | 自己前 3 次出手后，灵兽各追加一击 4–7（可被闪避，不会被反击）   |
  | `bloom`        | 凭空生花 | 主动 | 一场一次：气血低于一半时用，回 25% 气血上限，然后马上再出手一次 |
  | `lion-roar`    | 狮子吼   | 主动 | 一场一次：15 伤害，对方跳过下一次出手                           |
  | `blue-whale`   | 蓝鲸现世 | 主动 | 一场一次：20 + 灵力 × 100%，必中                                |

  每条带 `anim`（`法宝-水枪`、`招式-假死遁` 这样的素材名，见 §2.3）。

- **对战者**：
  ```ts
  interface Fighter {
    name: string; // 显示用
    hp: number; // 气血上限（开打时满血）
    power: number; // 灵力
    agility: number; // 身法
    speed: number; // 遁速
    weapons: WeaponId[];
    skills: SkillId[];
  }
  ```
- **接口**：`fight(a: Fighter, b: Fighter, seed: string, controllers?: [Controller, Controller]): BattleEvent[]`。
  - **两路随机数**（为以后的手动对战留口子）：决策用 `sha256(seed + ':decide')`，结算用 `sha256(seed + ':resolve')`，各喂一个小 PRNG（自己写几十行，比如 xoshiro128\*\* 或 sfc32，不引依赖）。换了出招者，结算序列不受影响。
  - **出招者 `Controller`**：轮到某方出手时，引擎问它 `decide(view): Action`，`Action` 是「用某件法宝攻击 / 空手攻击 / 用某个主动招式」。现在只实现 `autoController(decideRng)`：可用的「凭空生花」在气血低于一半时必用；其余没用过的主动招式每次 25% 用；否则在自有法宝里随机挑一件，20% 空手。
  - **出手顺序**：时间轴式。每方下次出手时刻 = 上次 + `100 / (遁速 + 10)`（鲸尾 ×1.2）。初始时刻 = 一个间隔 × 结算随机数 U(0.8, 1.2)。同一时刻 a 先。
  - **结算**（起点）：
    - 闪避率 = min(35%, 身法 × 1.5% + 化鸽遁 8%)；必中的不判闪避。
    - 伤害 = 法宝区间随机 + ⌊灵力 / 2⌋，空手 3–6 + ⌊灵力 / 2⌋；会心一击 ×2；泡泡护体挡一半（向下取整）。
    - 连击：一次攻击打中后，按 min(30%, 身法 × 1%) + 加成 再打一次，同一回合最多连击 2 次。
    - 反击：第六感见上表；远程法宝（水枪）和灵兽不会被反击。
  - **收场**：一方气血 ≤ 0（假死遁生效时留 1）即结束；出手满 30 次还没分出来，按剩余气血比例判，相同则遁速高的赢，再相同 a 赢。
  - **事件**：`BattleEvent` 是可辨识联合，每个事件带 `actor`（0 / 1）、`kind`，以及事件后的 `hp: [number, number]`。至少有：`start`、`decide`（记下这次的 `Action`，以后回放手动对战用）、`hit`（含 `weapon`、`damage`、`crit`、`blocked`）、`dodge`、`combo`、`counter`、`skill`（含 `skill`、`damage?`、`heal?`）、`beast`、`skip`（被定住跳过）、`play-dead`、`end`（含 `winner`、`reason: 'ko' | 'timeout'`）。
- **渡劫**：`tribulate(f: Fighter, strikes: number, stage: number, seed: string): BattleEvent[]`。N 道天雷依次劈下，第 i 道伤害 = 某个随境界涨的基数（自己定，按 §平衡 调）。能用上的：闪避（按一半闪避率算）、泡泡护体、假死遁；凭空生花在两道雷之间、气血低于一半时用。熬过全部雷 = 成功。事件 `kind` 用 `strike`、`end` 等，和 `fight` 共用类型。
- **心魔**：`shadowOf(f: Fighter): Fighter`，属性 ×0.9（向下取整，最低 1），法宝招式相同，名字「心魔」。
- **能力上限**：`statCap(stage: number): { hp, power, agility, speed }`，给 X5 校验名帖用，按 X1 的成长规则算出该境界可能的最大值（再留 10% 余量）。X1 之前先按 X1 的规则写死公式，X1 里要有一个测试保证成长结果不超过它。

**解说 `src/app/battle-lines.ts`**（配单测）：`lineOf(event, names, rng): string | null`。每种事件、每件法宝、每个招式配 2–3 句模板，例如「{a}掏出水枪滋过去，-{d}」「{b}化成一只鸽子躲开了」。每句 ≤ 40 字，不调模型。`decide`、`start` 这类不需要台词的事件返回 null。

**平衡**：

- `scripts/dev/battle-sim.mjs`：随机生成成千上万对角色对打，打印胜率表（按境界差、按每件法宝和每个招式）。用 `node --experimental-strip-types` 直接 import `src/app/battle.ts`（参照 `scripts/test-register.mjs` 的做法）。
- `battle.test.ts` 里放确定性的平衡断言（固定种子 0..N，N 取让测试 3 秒内跑完的量），目标：
  - 同一境界、随机配招的两只，a 的胜率在 40%–60%；
  - 任一法宝或招式，持有方对不持有方（其余随机）的胜率不超过 65%；
  - 高一个小境界（按 X1 的成长规则）约 60%，高一个大境界约 85%（各给 ±10% 容差）；
  - 心魔：本体对 `shadowOf(本体)` 胜率 55%–70%；
  - 渡劫：同境界随机配招，不吃丹约 65%、吃丹（气血 ×1.2）约 80%（±10%）。
- 同境界的属性按 X1 的成长规则生成。X0 先写一个测试用的 `fighterAt(stage, rng)` 放在测试工具里，X1 再换成正式的。

**测试**（除平衡外）：同种子同结果、不同种子不同结果；换出招者不改变结算随机序列（比如两边都换成「永远空手」，结算序列照旧可复现）；每种招式至少一个用例确实触发；假死遁只救一次；30 次出手封顶；事件里的 `hp` 和实际一致、不为负。

**模型调用**：0。

**X0 落地情况**（2026-10-24 已提交，后面的任务要知道）：

- 境界映射用 `battle.ts` 导出的 `majorBreaks(stage)`（到这个 stage 一共经过几次大境界突破）；X1 起所有「是不是大境界」的判断都用它，不要自己再算。
- `battle-testkit.ts` 的 `fighterAt(stage, rng)` 是平衡测试和 `battle-sim.mjs` 用的成长近似（法宝按「每个大境界多一件」近似）。X1 的正式成长规则要和它一致（法宝来源除外），并让 `statCap` 的测试改用正式规则。
- 平衡常数集中在 `battle.ts` 顶部的常量区；伤害里有一项「破势」（随对手气血上限加成），所以气血高不等于稳赢。
- `lineOf(event, names, rng, skillSets?)`：第四个参数传双方招式表，化鸽遁的闪避句才会出现。
- 对战出手满 30 次的「按比例判」在现数值下基本打不到，只是兜底。

### X1 修炼核心（纯逻辑）

**目标**：境界、修为、属性成长、每日封顶和存档，全在一个类里，可离线单测。

**新模块 `src/app/cultivation.ts`**（配 `cultivation.test.ts`）：

- **境界表**：

  | 大境界 | 小境界           | 每个小境界要的修为 |
  | ------ | ---------------- | ------------------ |
  | 炼气   | 一层 … 九层      | 150                |
  | 筑基   | 初期、中期、后期 | 1 000              |
  | 金丹   | 同上             | 2 000              |
  | 元婴   | 同上             | 4 000              |
  | 化神   | 同上             | 7 000              |
  | 炼虚   | 同上             | 10 000             |
  | 合体   | 同上             | 14 000             |
  | 大乘   | 同上             | 20 000             |

  `stage` 是 0 起的序号（0 = 炼气一层，30 个小境界）。`stageLabel(stage)` 给「炼气三层」「筑基中期」。大乘后期修满显示「大乘圆满」，之后不再涨（飞升在想法池）。

- **存档**：`$DSH_HOME/dsh-pet/cultivation.json`，字段：
  ```ts
  {
    version: 1,
    stage: number,
    progress: number,        // 当前小境界已攒的修为
    stats: { hp, power, agility, speed },
    weapons: WeaponId[], skills: SkillId[],
    pills: number,           // 破境丹（上限 9）
    offer: { a: SkillId; b: SkillId; until: number } | null,   // X4 用，X1 里恒为 null
    today: { date, presence, presenceMs, rests, pills, trial, spars: string[] },  // 日记口径的一天（diaryDate）
    record: { wins, losses },
  }
  ```
  - 写法照 §2.1。每天第一次写入前，先把旧文件复制成 `cultivation.json.bak`（只留一份）。
  - 第一次建档：灵力、身法、遁速各随机 2–5，合计 11；气血 50；随机一件凡器法宝；没有招式。
- **修为来源**（方法都带 `now`，返回发生的事件，供 X2 冒泡和记日记）：

  | 方法                     | 规则                                                                                                       |
  | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
  | `tick(now, present)`     | 在电脑前每满 1 分钟 +1；「心浮气躁」时减半（攒 2 分钟才 +1）；本地 0–4 点不涨；每天封顶 240                |
  | `onSitReminder(now)`     | 久坐提醒响了：进入「心浮气躁」，到主人离开电脑为止                                                         |
  | `onLeave(now)`           | 主人离开电脑（活动统计的 `leave`）：解除心浮气躁；若离上次久坐提醒不到 10 分钟，「调息」+20，每天最多 3 次 |
  | `onClaudeDone(now)`      | Claude 一轮活干完：20% 得一颗破境丹，每天最多 3 颗                                                         |
  | `trialDone(now, won)`    | 心魔试炼结束：当天第 1 场赢 +30、输 +10，赢了 30% 掉一件还没有的法宝；之后的场次只返回 0                   |
  | `sparDone(now, id, won)` | 切磋结束：同一个邻居每天只算 1 场，每天前 3 场有收益，赢 +20、输 +10                                       |

  `tick` 的 `present` 只是一个布尔值，`Cultivation` 不知道前台应用之类的东西。

- **升级**：修为加进当前小境界，满了就进下一个，余下的带过去。
  - 同一大境界内（比如炼气三层 → 四层、筑基初期 → 中期）自动升：随机一项（灵力 / 身法 / 遁速）+1～2，气血 +6。
  - 大境界的最后一个小境界修满 = 「圆满」：修为停在满值，多出来的不要，等突破。
  - `breakthrough(now)`：圆满时进下一个大境界：灵力、身法、遁速各 +1，气血 +20，再随机得一个还没有的招式。X4 会把它换成渡劫加二选一，现在先这样，保证第一期能一路往上走。
- **事件**：`stage-up`（同大境界内升级）、`full`（刚到圆满，只发一次）、`breakthrough`、`rest`（调息，带加了多少）、`pill`、`drop`（掉法宝）。
- **给别处用的**：`view()`（境界名、百分比、属性、法宝和招式的中文名、丹数、战绩，设置页和菜单用）、`fighter(name): Fighter`（给引擎）、`statCap` 的测试见 X0。

**测试**：每日封顶；跨 4 点换日后计数清零；0–4 点不涨；心浮气躁减半与解除；调息的 10 分钟窗口和每天 3 次；丹药上限；心魔和切磋的奖励只算前几场、同一邻居一天一场；升级带余量；圆满停住；突破后的属性和招式；坏文件、`.bak`、重启后还在；成长结果永远不超过 `statCap`（随机跑若干条成长路径）。

**模型调用**：0。

**X1 落地情况**（2026-10-24 已提交）：

- `new Cultivation(path, warn, rng?, maxTickElapsedMs?)`；后两个只给测试用，接线不传。
- `tick` 单拍最多计 30 秒（防睡眠 / 合盖后的那一拍虚增），所以接线照现有 `TICK_MS`（5 秒）每拍调用即可。
- 存档只在状态变了才写；`onSitReminder` 不写盘（心浮气躁本来就不落盘，重启即解除）。
- 事件：`stage-up`（带新 `stage`）、`full`（刚到圆满，只发一次，重启不会再发）、`breakthrough`（带领悟的 `skill?`）、`rest`（带 `gain`）、`pill`、`drop`（带 `weapon`）。菜单要不要显示「突破」看 `view().full`，不要靠记住 `full` 事件。
- 其他导出：`stageLabel`、`stageReq`、`isFullStage`、`MAX_STAGE`、`drawDropWeapon`。

### X2 修炼接线：修为来源、菜单、日记

**目标**：真机上宠物开始修炼：在电脑前就涨修为，境界和百分比在右键菜单里看得到，升级会冒泡、记日记。

**配置**：`app-config.ts` 加顶层 `cultivation: { enabled: boolean }`，默认 `true`（§2.1 的三处规则）。设置页开关在 X6 做。

**路径**：`main.ts` 照 `snackPath` 加 `cultivationPath: join(home, 'dsh-pet', 'cultivation.json')`，经 `FeatureDeps` 传进来。

**接线**（`features.ts`，开关关着时全部跳过）：

- **`tick`**：`cultivation.tick(now, snap?.present ?? false)`；`health.tick` 出来的 `sit` 调 `onSitReminder`；`tracker.update` 出来的 `leave` 调 `onLeave`。
- **Claude**：`handleClaudeHook` 里 `speech?.kind === 'done'` 的分支调 `onClaudeDone`。
- **冒泡**（都排进现有的说话队列，不和别的气泡抢）：
  - `stage-up`：`say` 模板句，比如「修为精进，到炼气四层啦～」，不调模型；
  - `full`：`speak` 一句「可以突破了」，+1 次调用；
  - `breakthrough`：播 `修炼-突破`（§2.3 的 url 形态），再 `speak` 一句，+1 次调用；
  - `pill`：`say`「炼成一颗破境丹～」；`rest`：`say`「调息回来，修为 +20」。
- **平时修炼**：在电脑前、没出门、没在说话时，每 40–60 分钟随机播一次 `修炼-打坐`。
- **菜单**：新增子菜单「修炼」：
  - 第一项是信息项，标签如「修炼/筑基中期 · 63%」，点了说一句当前境界、属性和法宝数；
  - 圆满时多一项「修炼/突破」，点了调 `breakthrough`。
  - 百分比取整，变了才重新注册菜单（`refreshMenu` 本来就按标签比较）。
- **日记**：`diary.ts` 的事件类型加 `cultivate`；升级、突破、掉丹、调息都记一条（比如「修为精进，到了炼气四层」）。看一下 `diaryInstruction` 拼出来的内容里新事件读得通。
- **`AppFeatures`** 加 `cultivation: { view(): CultivationView }`，X6 的设置页用。

**模型调用**：每次到圆满 +1，每次突破 +1（都很少，按设计约几天到几十天一次）。

**测试**：`app-config.test.ts`（旧文件没有 `cultivation` 时补默认值）；`diary.test.ts`（新事件类型能读写）；`features.test.ts`：开关关着不建档；在电脑前若干拍后 `cultivation.json` 有修为；久坐提醒后减半；Claude 干完活能拿到丹（注入的随机数）；菜单里有「修炼」信息项，圆满时有「突破」。

**真机**（主会话做）：装好后菜单里有「修炼/炼气一层 · N%」；`cultivation.json` 随时间涨；把存档改成快圆满，看「可以突破了」和「修炼/突破」。

**X2 落地情况**（2026-10-24 已提交，真机验证过）：

- `say(text, { image?, anim? })`、`speak(instruction, fallback, options?)`、`sayLine(text, options?)`：`anim` 默认 true，会联动一段说话动画。**带 `anim` 的气泡会把正在播的动画顶掉**（真机上突破动画就是这样被打断的），所以 X3 / X4 演出时的台词气泡一律 `anim: false`。
- `playExtra(name)`：按 §2.3 的 url 形态播新素材（不带 `facing`；对战要面朝对手，X3 要给它加 `facing` 和 `rate`）。
- `cultivationOn()` 懒建档，开关关着返回 null；修炼菜单项由 `cultivationActions()` 生成，组前缀是 `修炼/`。
- 破境丹只在 Claude 那轮活干满 30 秒（`speech?.kind === 'done'`）时有机会掉。
- 测试里要拨时间用 `t.mock.timers.enable({ apis: ['Date'] })`（只接管 Date，拍子照走真的），不要真等。注入随机数用序列，不要用常量。
- 跑测试一律外包超时（比如 `perl -e 'alarm 600; exec @ARGV' npm test`），同步死循环 `--test-timeout` 打断不了。

### X3 演出与心魔试炼

**目标**：右键「修炼/心魔试炼」，自家宠物旁边出现一个暗色的「心魔」，两边按引擎事件依次出招、挨打、闪避，头顶有气血条，打完说一句赛后感言、拿奖励。

**`/anim` 加 `rate`**（`src/host/anim.ts`、`src/host/index.ts`、`runtime/electron-helper/sprite.js`）：

- 可选参数 `rate`（0.5–3），name 和 url 两种形态都支持；非法值回 `bad-request`。写进叶子，渲染端播这一段时设 `video.playbackRate`，这段结束或被打断就恢复 1。
- 没给 `rate` 时行为一字不变。`anim.test.ts` 补用例；`sprite.js` 改完跑 `node --check`。

**心魔窗口**（`visit-windows.ts`）：`openGuestWindow` 加 `tint: 'pink' | 'shadow'` 选项（默认 pink，客人照旧）。`shadow` 用新的 `shadowPixels`：去饱和、压暗、偏紫，和 `pinkPixels` 一样只在页面里逐帧处理。`GuestWindow.play(name, rate?)` 也支持 `rate`。心魔窗口不响应点击戳一下的反应。

**擂台窗口 `src/app/arena-window.ts`**（新，配单测）：透明、置顶、不可聚焦、鼠标穿透的小窗，浮在两只宠物上方，只画两条气血条、名字和境界。页面走 `app-routes.ts` 新的 `GET /app/arena`（照 `/app/note` 的写法），数据经 `executeJavaScript` 传 `JSON.stringify` 后的字面量，显示只用 `textContent`。

**演出 `src/app/battle-show.ts`**（新，配单测）：

- **纯函数** `timeline(events, names, rng): Step[]`：把引擎事件排成时间线。每步：`{ at, who, anim?, rate?, line?, hp }`。
  - 一个出手事件约 2.4 秒；动画按 §2.3 的时长算 `rate`，让一段动画正好占满这一步。
  - 挨打方的反应（`战斗-受击`）比出手晚约 0.9 秒，对上攻击打到的时刻。
  - 映射：法宝攻击 → `法宝-<名>`；空手 → `战斗-出拳`；闪避 → 有化鸽遁播 `招式-化鸽遁`，否则 `战斗-闪避`；招式 → `招式-<名>`；开场两边 `战斗-起手`；收场赢的 `战斗-胜利`、输的 `战斗-倒地`；渡劫的雷 → `修炼-挨雷`；服丹 → `修炼-服丹`。
  - 台词用 X0 的 `lineOf`，出在出手那一方的气泡里。
- **执行器**：一个小类，构造时注入「自家宠物播动画 / 说话」「对手窗口播动画 / 说话」「擂台更新气血」这几个函数，按时间线跑，支持 `skip()`（快进：停掉剩下的步骤，直接到结果）和 `dispose()`。`features.ts` 只负责把真实的函数传进去。
- **朝向**：自家宠物面朝对手（对手在右就 `facing: 'right'`），对手窗口面朝自家宠物（`GuestWindow` 已有）。

**心魔试炼流程**（`features.ts`）：

- 菜单「修炼/心魔试炼」：开着修炼、没在打、没出门、家里没客人时才有。打的时候多一项「修炼/快进」。
- 打开心魔窗口 → `fight(本体, shadowOf(本体), 随机种子)` → 演完 → `cultivation.trialDone` → 冒泡奖励（「修为 +30」「得到法宝：陀螺」）→ 记日记 → 用 `compose` 说一句赛后感言（+1 次调用，失败用模板）→ 3 秒后关心魔窗口和擂台窗口。
- 打的过程中：碎碎念和自动看屏幕让一让（参照 `takeWhisperTurn` 里 `generating` 那套）；有人来敲门照常处理，先把这场快进结束。

**模型调用**：每场心魔 +1（赛后感言）。

**测试**：`battle-show.test.ts`（时间线的映射、rate、反应延迟、快进）；`arena-window.test.ts`（页面里只用 textContent、数据经 JSON 字面量）；`visit-windows.test.ts`（shadow 配色函数、不影响 pink）；`features.test.ts`（菜单项出现和消失、一场打完奖励进了存档、打的时候碎碎念让路）。

**真机**（主会话做）：打一场心魔，截图看配色、朝向、气血条、动画衔接；快进；连打几场确认只有第一场加修为。

**X3 落地情况**（2026-10-25 已提交 `4fd0144`，真机验证过；截图项与打击时刻修正后补）：

- 节奏常量都在 `battle-show.ts` 顶部：一格 `SLOT_MS = 2400`、同格台词错开 `BEAT_MS = 800`、挨打反应晚 `REACT_MS = 900`、开场 `OPEN_MS = 2400`、收场 `CLOSE_MS = 3000`；素材时长表 `ANIM_MS`（没列的按 4 秒），`rateFor(anim, windowMs)` 让素材正好占满窗口、夹在 0.5–3——多数招式 1.7–3 倍速。真机嫌快 / 嫌慢调 `SLOT_MS` / `BEAT_MS` 就行。
- 被动招式素材第一版只接了假死遁、化鸽遁，核验后返工补上 4 段（dsh 会话 `session-935cfda2`，旧的 `80a9e8f1` 已不存在）：`blocked` 的那一下挨打方播「招式-泡泡护体」（替「战斗-受击」）；`beast` 出手方加播「招式-灵兽助阵」（与台词同拍）；`counter` 反击方在 `at + REACT_MS` 加播「招式-第六感」（先挨一下再反劈）；`combo` 且出手方有无影手时加播「招式-无影手」。**会心一击不用**：它是出手方蓄力重拳的素材，会心只是 hit 结算字段、没有独立出手时刻。渡劫的 `strike` 被 `blocked` 时那一拍就地换成泡泡护体。
- `MENU_NEIGHBORS_MAX` 维持 15：固定 2 + 修炼最多 3 + 邻居 15（回访占名额）= 恰好 20，不超过宿主 `ITEMS_MAX = 20`（`>` 才拒）。
- 演出台词气泡一律 `anim: false` + `durationMs`（`/broadcast` 的 `duration` 宿主原生支持，气泡只显示一步长 `LINE_MS`，下一句自然顶替）；自家宠物 `playExtra(name, { facing, rate })` 每次都带朝向（面朝对手）。
- **`shadowPixels` 踩坑（真机抓到）**：配色函数经 `toString()` 内联进 guest 页面，**模块级常量带不进去**——引用了 `SHADOW_LEVEL` 页面里逐帧 `ReferenceError`、心魔整只画不出来。已把常数写死进函数体（和 `pinkPixels` 同口径），回归测试在 node `vm` 的贫瘠沙箱里跑内联源码（`visit-windows.test.ts`「配色函数是自包含的」）。以后凡是 `toString()` 进页面的函数都必须自包含。
- `skip()` 立即结算照拿奖励；`dispose()`（退出 app）不补奖励不算场。有人敲门先 `skipTrial()` 快进收场，客人进门 `closeTrial(0)` 立即关窗（两个窗口同一套摆位规则，不能叠着）。
- 真机（2026-10-25，三场）：菜单切换、演出台词按时间线走（日志全「不联动动画」）、快进 1.6 秒内直收场、连打三场只有首场加修为（`today.trial=1`、`record.wins=3`）、修复版零渲染错误。**截图项后来补验**（用户给 ZCode 进程开了屏幕录制权限）：两只同框、心魔暗紫、面对面朝向、血条面板两条带名字和百分比、台词气泡都在。测试期间 `cultivation.json` 已用备份还原、测试日记条目已删。
- **挨打反应的打击时刻**（`d866446`，用户真机观感「出招还没出完，另一半就挨揍了」）：固定 0.9 秒只有出拳对得上（打击时刻 2.0s ÷ 倍速 2.083 ≈ 0.96s），法宝 / 招式的打击动作在素材中后段（1.4–2.25s），受击就偏早。现在 `HIT_AT_MS` 表（13 段素材的打击时刻，分镜在 prompts 文档）+ `reactDelayOf(attackAnim)` = 打击时刻 ÷ 倍速，夹 [400, SLOT_MS−600]；出拳 960ms、水枪/烟花 1140ms、气球 1200ms。第六感贴着自己挨的那一下 +300ms（先挨后反）；counter 挨的反击是徒手快打维持固定 900ms；beast 挨的那下跟灵兽素材自己的冲撞时刻。素材重做后 `HIT_AT_MS` 跟着分镜改。
- X4 复用点：`BattleShow` 的 `sides.foe = null` 就是渡劫的形态（测试已盖）；`strike`（挨雷）时间线已排好；赛后感言走 `compose` 只带人设、失败落模板，X4 的结果感言照抄。
- **受击时刻的两轮真机返修 + 心魔等大**（`bb71c9e`，2026-10-25 用户连续反馈「攻击刚出来就挨了」）：① `HIT_AT_MS` 第一版按分镜的**特效出手**时刻标——错在法宝是**飞过去**的，命中在飞行段中后段（毽子踢出 1.4s、命中 ≈1.9s）；重标为「特效命中对方」（持续命中型标首次命中），加受击素材自己的前摇补偿 240ms（`战斗-受击` 前 0.5s 还站着，起播不等于被击中）。② 心魔窗口改**等大 + 贴身**（`openGuestWindow` / `guestBounds` 的 `{ scale: 1, tight: true }`，宽度上限随 scale 等比放宽不被串门的 400 卡住）——小一号时特效要飞过更宽的空隙，把「刚出手就挨」进一步放大；串门维持小一号 + 社交距离的既有表意。切磋复用串门的客人窗口（尺寸进门时定），等大不适用、受击时机靠协议延迟保证——取舍记录在案。

### X4 渡劫与二选一

**目标**：大境界圆满后的突破换成渡劫：吃丹（可选）→ 扛天雷 → 成功进大境界并二选一领悟招式，失败扣修为。

- **`cultivation.ts`**：
  - `breakthrough` 拆成 `tribulationPlan(now)`（给出雷数、能不能吃丹）和 `tribulationDone(now, survived, usedPill)`。
  - 雷数：进筑基、金丹 3 道，进元婴、化神 6 道，之后 9 道。
  - 成功：属性照 X1 的大境界加成，然后从还没有的招式里随机挑两个放进 `offer`（10 分钟有效）。`choose(now, skill)` 领悟其中一个；过期没选就随机定一个（`tick` 里检查）。
  - 失败：扣当前小境界 20% 的修为，最多 300；不再是圆满，攒回来才能再渡劫。**不设冷却计时**。
  - 吃丹：渡劫这一场气血上限 ×1.2，丹数 −1。
- **菜单**：圆满时「修炼/渡劫」替换「修炼/突破」；有丹时多一项「修炼/服丹后渡劫」。有 `offer` 时多两项「修炼/领悟：狮子吼」「修炼/领悟：泡泡护体」。
- **演出**：复用 X3 的执行器，没有对手窗口；吃丹先播 `修炼-服丹`；每道雷 `修炼-挨雷`；成功播 `修炼-突破`，失败播 `工作状态-垂头叹气冒汗`（现有素材，名字形态播）。
- **模型调用**：每次渡劫 +1（结果感言）。
- **测试**：渡劫成功和失败的存档变化；扣修为封顶 300；失败后不再是圆满；吃丹；`offer` 选择、过期自动定、不会给已有的招式；菜单项随状态变化。

**X4 落地情况**（2026-10-25 已提交 `bb69959`，dsh 会话 `session-cebf828e`，真机验证过）：

- `tribulationPlan` / `tribulationDone` / `choose` / `expireOffer` 都在 `cultivation.ts`：雷数 `tribulationStrikes(stage+1)`（进筑基、金丹 3 道，元婴、化神 6 道，之后 9 道）；`tribulate` **喂渡劫前的圆满 `stage`**（X0 平衡测试同一口径）；失败扣 `min(floor(req×20%), progress, 300)`（三重夹取，不会扣成负数）；丹是扛没扛住都算吃了；`tribulationDone` 只认还圆满着的那一场（不圆满时空操作、连丹都不扣，防重复结算）；二选一用「`missing[i]` + 环上一个」的取法，注入常量 0 也不会两个相同，只剩一个没学的直接给。
- 菜单：`MENU_NEIGHBORS_MAX` 15 → **14** + `wantedLabels` 按 `MENU_ITEMS_MAX = 20` 兜底截断（挤不下先少列邻居，渡劫 / 试炼这些关键项在前）。这次 dsh 说改的数字**真改了**（grep 核过）。
- 演出：`timeline` 的 `tribulation` 选项多了 `strikes`（台词报「第 i/N 道」的 N 用 plan 的雷数——没扛住时事件里只有前几道，不传会报成偏小的分母）；失败收场「工作状态-垂头叹气冒汗」走 `/anim` **名字形态**（`playPooled`），测试校验它真在 `config.jsonc` 的 `events.workStatus` 池里；`Step.from: 'pool'` 标记池内素材。`breakthrough` 事件不再另播动画和感言（演出里已有，§X4 每场只 +1 次模型调用）。
- 真机（2026-10-25）：服丹开场 → 挨雷演出（截图确认单角色、乌云黑烟、气泡「第 2/3 道」）→ 失败场（扣 30 = 150×20%、丹扣掉、不再圆满、菜单收掉渡劫、垂头素材无失败日志、compose 感言）→ 满配属性一次成功（进筑基、二选一挂出、点「领悟：化鸽遁」入 `skills`、菜单收掉）→ 快进 0.6 秒直结算。测完存档 / 日记已还原。
- **真机改档的教训**：把存档改到高 `stage` 时 **`stats` 必须按成长补齐**（每级 hp+20、三维各 +1）——雷伤害公式里有按自身气血的分量（`TRIBULATION_HP_CUT`），1 级的血扛 8 级的雷是必死（真机 10 连败查明就是这个，不是代码 bug）。反过来也说明**渡劫成功率对血量很敏感**：`fighterAt` 典型成长（stage 8 血 98）和正式成长口径（血 216）的雷伤 / 血量比差一倍，正式成长实际更容易过——见下面平衡遗留。
- **平衡已重标**（2026-10-25 `bab8e47`，用户拍板）：旧参数（`TRIBULATION_*` 0.54 / 0.024 / 0.35）只在 stage 12 一点标定过，七个渡劫分界实际 0.30–0.72 不齐（早期偏难）。按正式成长口径（`fighterAt` 与 `Cultivation` 的 stage-up 同源：小境界 hp+6、大境界 +20）网格扫描重标为 `BASE 0.46 / STEP 0.022 / HP_CUT 0.38`（`LATE_STEP` 不动），2000 场验证七站**不吃丹 0.59–0.67、吃丹 0.83–0.89**；X0 断言从「stage 12 单点」重写为七站全覆盖（600 场/站）。`battle-sim` 的渡劫表同步落在 0.58–0.73。校准脚本是一次性的没进仓库（参数化 `tribulate` + `fighterAt` 蒙特卡洛网格）。
- `scripts/dev/battle-sim.mjs` 的渡劫段还是「自己算雷数」的旧口径，没覆盖「圆满境 + 二选一攒招式」的正式成长路径（非阻塞）。

### X5 串门切磋

**目标**：串门进行中，两边都能发起切磋；在主人家屏幕上演，客人那边转播台词和结果；奖励、战绩各记各的。

- **协议**（`visit.ts`；现有协议只有客人发请求，主人家要告诉客人的事放在 `/v1/ping` 回复的 `events` 里）：
  1. 主人家发起：`events` 里塞 `{ type: 'spar-invite' }`，客人收到后走第 2 步（客人那边关了切磋就忽略）。
  2. 客人发 `POST /v1/spar { token, mode: 'auto', card, commit }`，`commit = sha256hex(客人随机数)`。
  3. 主人家回 `{ card, nonce }`（自己的名帖和随机数）；不认识的 `mode` 回 `{ reason: 'unsupported-mode' }`；切磋关着回 `{ reason: 'off' }`；正在打回 `{ reason: 'busy' }`。
  4. 客人发 `POST /v1/spar/reveal { token, nonce }`；主人家核对 `sha256hex(nonce) === commit`，对不上或 30 秒没来，按客人认输记。
  5. 两边各自算 `fight(主人家, 客人, 客人随机数 + ':' + 主人家随机数)`，结果必然一致。
- **名帖**：`{ v: 引擎版本, stage, hp, power, agility, speed, weapons: WeaponId[≤8], skills: SkillId[≤10] }`。过 zod；编号在图鉴里；数值 ≤ `statCap(stage)`；随机数是 32 字节十六进制。引擎版本不同回 `{ reason: 'version' }`，菜单那边说「两边版本不一样，切磋不了」。
- **兼容**：旧版本的对端没有 `/v1/spar`（404）就说「对方的桌宠还不会切磋」；旧客人不认识 `spar-invite` 事件，`parseEvents` 本来就会丢掉不认识的类型（确认一下）。
- **演出**：主人家屏幕上，自家宠物对客人窗口，用 X3 的执行器（客人窗口照旧粉色）。客人那边：自家宠物在别人家，只转播台词（`relay`）和最后结果。
- **奖励与记录**：两边各自 `cultivation.sparDone`；`neighbors.ts` 的记录加 `sparWins`、`sparLosses`（旧文件没有就当 0）；`memoryLine` 加「上次切磋你赢了 / 输了」。日记各记一条。
- **菜单**：主人家「串门/和客人切磋」，客人那边「串门/找主人家的宠物切磋」，都只在开着修炼、对方在、没在打时出现。
- **模型调用**：每场每边 +1（赛后感言，走 `compose`）。
- **测试工具**：`scripts/dev/visit-peer.mjs` 两种模式都加 `spar` 命令；`host` 模式能按假名帖应战。
- **测试**：协议各分支（正常、commit 不符、超时、版本不同、mode 不认识、关着、正在打、旧对端 404）；两边算出的事件序列逐个相同；名帖超上限、编号不认识被拒；奖励一邻居一天一场；`neighbors.json` 旧文件兼容。

**X5 落地情况**（2026-10-25 已提交 `184a674` + 测试工具 `0cae17c`，真机验证过）：

- **开发方式**：dsh 两次尝试都断（一次配额 429、一次挂死），经用户拍板改用 ZCode workflow subagent（GLM-5.3-Flash）做——脚本 `dsh-pet/.zcode/workflow-drafts/X5-串门切磋开发.dwf.ts`，一个共享上下文的开发 agent + `world.run` 亲自跑四道验证门（prettier / typecheck / lint / 全量测试），挂了把输出喂回去回炉，最多 4 轮；实际两轮过（第一轮挂的 lint 是 workflow 自己的运行产物文件被 `eslint .` 扫到，顺手修了 `eslint.config.js` 忽略 `.zcode/**` 并加回归测试 `eslint-ignores.test.ts`）。验证门 exit code 说话，不依赖 agent 自报。
- 协议在 `visit.ts`：`parseSparCard`（先验版本再过 schema 再卡 `statCap`）、`sparCommit` / `isSparNonce`（32 字节十六进制）、`sparFight`（种子「客人随机数:主人家随机数」，测试钉住「顺序反了是另一场」）；404 映射 `old-host`；`parseEvents` 对 `spar-invite` 显式收编（旧客人不认识会丢，确认过）。应答里的对方名帖**同样不可信**，`sendSpar` 收到后再过一遍校验。
- `features.ts` 用一个小状态机管两边（host: `invited → card → showing`；guest: `asking → showing`）；**账（修为、战绩、邻居簿、日记）在开打那一步记**，演出只是回放——快进、客人走、退出都不会把账弄乱；客人侧赛后感言有 10 秒上限（`SPAR_REMARK_CAP_MS`），模型磨蹭不拖垮 reveal 时限；主客双方演出期间一起玩 / 请吃 / 回话都让路（`anim: false`）。
- **真机踩到并修掉的 bug（`184a674` 内）**：主客两侧的演出结束后都没把 `battle` 置 null——一场打完菜单永远挂着「修炼/快进」、心魔 / 渡劫 / 切磋全被 `if (battle)` 锁死到退出 app。`cancelSpar` 与两处 `await battle.run()` 之后补清零；对应测试断言从「历史快照 `menus.some(...)`」（开打前的快照也满足，形同虚设）改严为「最新一帧里有切磋项、没有快进」。
- 真机（假客人 `visit-peer.mjs visit` + 真实 app，签名 verified 进门）：客发起一场、主人发起一场连打，两边各自算出同一场（客人日志「主人家的宠物 赢」= 主人家屏幕上的结果），血条两条带名字境界（视觉分析确认「吃白饭的 · 炼气二层」/「小测 · 炼气三层」）、客人粉色、面对面、毽子攻击台词按时间线走、busy 分支（演出中再约回 busy）、修为 +20 一天一场、邻居簿 `sparWins/lastSparWon` 记账、演出后菜单恢复。测完存档 / 日记还原、测试期生成的 `neighbors.json` 已删。
- 测试技巧：`visit-peer.mjs` 的 stdin 用 fifo 喂（`mkfifo` + 后台 `sleep 600 > fifo` 保住写端），命令之间留足间隔——脚本 10 分钟自动退出，`echo` 进无人读的 fifo 会卡死 shell（踩过）。

### X6 设置页「修炼」、README

- **设置页**（`settings-page.ts`）：新的一节「修炼」：
  - 「修炼」总开关（`cultivation.enabled`）；
  - 只读：境界、百分比、四项属性、法宝和招式（中文名）、破境丹、战绩。
- **接口**：`app-routes.ts` 加 `GET /standalone-ai/app-cultivation`（和 `app-neighbors` 一样放在需要令牌的那组），回 `features.cultivation.view()`；功能还没起来回 503。
- **README**：根目录 README 的「新增功能」表加一行「修炼与切磋」，「设置页」那一行补上「修炼」一节。只做这两处外科式修改，**不要**对根 README 跑 prettier。
- **测试**：`app-routes.test.ts`（令牌、503、返回结构）；设置页渲染只用 textContent。

**X6 落地情况**（2026-10-26 已提交 `f831cdf`，workflow subagent 实现（同 X5 的四道验证门方式），真机验证过）：

- 接口 `appCultivationHandler`（`app-routes.ts`）：features 没起来 503、非 GET 405、GET 回 `cultivation.view()`；挂在 `main.ts` 的令牌组（`/standalone-ai/app-cultivation`）。**开关关着 / 还没建档时 `view()` 是 null，照样 200**（照设计原话「功能还没起来回 503」的字面执行），设置页在 null 时只显示开关。
- 开关的写口随「陪伴与提醒」的 `app-settings` POST 一起保存（复用整页保存管线），`app-cultivation` 保持纯读。
- 设置页（`src/standalone/settings-page.ts`）：「修炼」fieldset 在「邻居」之后，开关 + 提示语 + 六行只读（境界 · 百分比、四项属性、法宝、招式、破境丹、战绩），全部 `createElement` + `textContent`；CLI 里 404 整节隐藏。只读行不含 `full` / `offer`（圆满态右键菜单可见）。
- 根 README 恰好两处：「新增功能」表加「修炼与切磋」一行、「设置页」行补「修炼」一节；没跑 prettier。
- 真机（2026-10-26）：带令牌设置页实际渲染核对——开关勾选、六行全是真实存档数据（炼气二层 88%、法宝毽子/扑克牌、战绩胜 4 负 0 是测试期累积后已还原的账）；无令牌 403。1259/1259 过。
- 已知边缘态（不改）：app 启动后第一个 tick（5 秒）内打开设置页，懒建档前 `view()` 还是 null——只显示开关，刷新即有，与邻居节同款行为。

## 4. 主会话的核验清单

照 `standalone-roadmap.md` §6，另外：

1. 引擎相关的任务：重跑 `battle-sim.mjs`，看胜率表和测试里的断言一致。
2. 有新菜单项的任务：真机点一遍，截图。
3. 真机测之前备份并在测完还原 `cultivation.json`（X2 起），以及旧清单里的那些文件。测试打出来的修为、日记条目都不能留下。

## 5. 派发用的提示词

```text
你在 /Users/yfan/work/dsh-pet/dsh-pet（dsh-pet 独立 macOS 桌宠应用，分支 custom）里开发。
先完整读一遍 /Users/yfan/work/dsh-pet/docs/cultivation-roadmap.md 的 §0、§2，以及它引用的
/Users/yfan/work/dsh-pet/docs/standalone-roadmap.md 的 §2.1、§2.3、§2.5；再读 cultivation-roadmap.md §3 里的 <编号>，只做 <编号>。
需要了解取舍理由时再看 /Users/yfan/work/dsh-pet/docs/cultivation-battle-research.md。

要求：
- 照 §3 <编号> 的设计实现，照 standalone-roadmap.md §2.3 跑完验证（prettier --check、typecheck、lint、npm test，改了 runtime/ 的 js 还要 node --check）。
- 跳过真机验证：不要构建安装 app，不要动 /Applications/dsh-pet.app 和用户数据目录，也不要连正在运行的 dsh-pet app。真机验证由 Claude 核验时做。
- 和设计不一样、或者设计里没写清的地方，选错了代价低、改得回来的做法继续，回报里写明；改动面大或改不回来的，先停下来问。
- 不要 git commit / push / stash / checkout / restore；改动留在工作区。
- 做完按 standalone-roadmap.md §2.5 回报：改动文件清单、和设计的偏差及理由、验证命令和结果、遗留问题。
```

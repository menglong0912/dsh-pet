/**
 * 三王传承（历练路线 Y0）：《蛊真人》第二卷第一百二十四至二百零五章的名场面（设计 §4.10）。
 *
 * 纯数据 + 规则钩子：对白、场景文字、五层形状、三种一转蛊、四种结局组合、春秋蝉倒回哪里，全在这个文件里。
 * 通用跑图（`dungeon.ts`）不认得「春秋蝉」「白凝冰」——它只照这里的声明式字段和钩子结算。
 *
 * 信王、爆王两条路的关卡原著没写（方源只闯了犬王传承），照「炼道」「炎道」的路子原创。
 * 画风是 Q 版：原著里的血腥（自爆、贯穿心脏）都点到为止，不写出来。
 */
import {
  DUNGEON_VERSION,
  type BlessingId,
  type DungeonDef,
  type EndingDef,
  type FightCtx,
  type FoeDef,
  type LayerDef,
  type NodeDef,
  type Run,
} from './dungeon';

/** 三条路（一转蛊 ↔ 王）：进第一层选一道光柱定下来，记在 flags.road */
type Road = 'dog' | 'letter' | 'blast';

const ROAD_NAMES: Record<Road, string> = { dog: '犬王', letter: '信王', blast: '爆王' };

/**
 * 第五层开场的两个数：被背刺扣当前气血的比例、白凝冰替挡几下。
 * 设计表写的是「气血减半」「guard 3 下」，按 §3 Y0「平衡」实测调到 28% / 1 下才落进目标区间（见回报）。
 */
const BACKSTAB_CUT = 0.28;
const GUARD_TIMES = 1;

/** 驭犬蛊的狗数：起始 1 只驭犬蛊 = 2 条狗，每打赢一场多 1 条，最多 6 条（原著第一百四十七章） */
const DOGS_START = 2;
const DOGS_MAX = 6;

function roadOf(run: Run): Road {
  const raw = run.flags.road;
  return raw === 'letter' || raw === 'blast' ? raw : 'dog';
}

/** 这一路给的一转蛊 */
const GU_OF: Record<Road, 'gu-dogs' | 'gu-crane' | 'gu-egg'> = {
  dog: 'gu-dogs',
  letter: 'gu-crane',
  blast: 'gu-egg',
};

function dogsOf(run: Run): number {
  return typeof run.flags.dogs === 'number' ? run.flags.dogs : DOGS_START;
}

/** 识破白凝冰（「白凝冰，你演够了吗？」，原著第二百零四章） */
function seenOf(run: Run): boolean {
  return run.flags.seen === true;
}

/** 改炼定仙游（原著第二百零五章）；没选就是照原著炼第二空窍蛊 */
function dingxianOf(run: Run): boolean {
  return run.flags.smelt === 'dingxian';
}

/** 春秋蝉还没用过（一趟一次） */
function canRewind(run: Run): boolean {
  return run.flags.rewound !== true;
}

/**
 * 结局：识破 + 改炼定仙游 = 「定仙游」（原著那条路线，最稳）；
 * 其余三种组合都是「第二空窍」（赢了就是改写原著）。
 */
function endingOf(run: Run): EndingDef {
  return dingxianOf(run) ? ENDING_DINGXIANYOU : ENDING_SECOND;
}

const ENDING_SECOND: EndingDef = {
  id: 'second-void',
  name: '第二空窍',
  text: [
    '「你……竟然识破了我的定星蛊。」白凝冰退了一步。',
    '大同风起了，福地在身后塌下去，你站在三叉山的顶上，怀里多了一枚第二空窍蛊。',
    '原著里没能成的事，这一趟成了。',
  ],
  bubble: ['炼成了！两个空窍的我～'],
  titles: ['第二空窍'],
  // 两卷功法玉简（设计 §4.10：改写原著的奖励）
  scrolls: 2,
  anim: '秘境-得宝',
};

const ENDING_DINGXIANYOU: EndingDef = {
  id: 'ding-xian-you',
  name: '定仙游',
  text: [
    '玉竹、星屑、荣耀之光三味蛊材在炉里化开，定仙游成了。',
    '大同风将起，福地崩溃。碧芒一闪，你已从三叉山上消失。',
    '「……春秋蝉沉眠了。这一趟，值。」',
  ],
  bubble: ['衣服……没跟着传过来'],
  titles: ['春秋蝉主'],
  anim: '秘境-定仙游',
  // 原著第二百零五章的高光：破茧、碧芒一闪（Y5；只影响演出）
  cutscene: {
    video: '过场-定仙游.mp4',
    lines: [
      '蚕茧破开，飞出一只绿光莹莹的翩翩蝴蝶——定仙游蛊！',
      '碧芒一闪即逝。',
      '白凝冰、铁若男……仿佛是雕塑一样站着。',
    ],
  },
};

const SANWANG_FOES: Record<string, FoeDef> = {
  'wild-dog': {
    id: 'wild-dog',
    name: '野狗',
    tier: 'mob' as const,
    moves: ['dog-bite'],
    prefix: '对手-野狗',
    scale: 0.96,
    tactics: '一群饿狗扑上来，一次两下，专咬脚踝。',
    text: ['土丘后面钻出三四条野狗，肋骨一根根数得清。', '它们饿了很久，看见活物就扑。'],
  },
  'red-egg': {
    id: 'red-egg',
    name: '红蛋人',
    tier: 'mob' as const,
    moves: ['egg-burst'],
    prefix: '对手-红蛋人',
    scale: 0.8,
    tactics: '抱成一团滚过来撞开，炸得满脸灰；十下里有一下把人撞晕。',
    text: ['一群红壳蛋似的东西从地缝里滚出来，顶上裂开一张张人脸。', '它们不争路，只撞。'],
  },
  mastiff: {
    id: 'mastiff',
    name: '狮獒',
    tier: 'elite' as const,
    moves: ['mastiff-maul'],
    prefix: '对手-狮獒',
    scale: 1.12,
    eliteLook: true,
    tactics: '一扑压身，下口极重；扑中一次要歇半口气。',
    text: ['犬王的王牌部队。金毛狮獒一排趴着，眼睛全是绿的。', '两头上古异兽立在最后，每一头都抵得上五转蛊师。'],
  },
  'han-buliu': {
    id: 'han-buliu',
    name: '韩不留',
    tier: 'elite' as const,
    moves: ['han-dogs'],
    prefix: '对手-韩不留',
    tactics: '正道四转，驱犬围攻：一声令下群狗三面包上，本人不出手。',
    text: ['韩不留牵着十一条狗站在土丘上，袖子里露出半截驭犬蛊的壳。', '「三王传承，正魔不论。可蛊虫……就不必谈了。」'],
  },
  'lava-croc': {
    id: 'lava-croc',
    name: '熔岩鳄',
    tier: 'elite' as const,
    moves: ['mastiff-maul'],
    prefix: '对手-熔岩鳄',
    scale: 1.11,
    // 复用狮獒的立绘和动作，CSS 换色（任务书 §2.3）
    skin: '对手-狮獒',
    filter: 'hue-rotate(-25deg) saturate(1.7)',
    eliteLook: true,
    tactics: '火炭山里的东西，一口咬住不松；翻身一甩就是重扑。',
    text: ['火炭山的黑沙底下拱出一条熔岩鳄，脊背上的裂纹冒着橙光。', '原著里方源路过火炭山时，见过的就是这个阵仗。'],
  },
  'rival-gu-master': {
    id: 'rival-gu-master',
    name: '他派蛊师',
    tier: 'elite' as const,
    moves: ['moon-blade'],
    prefix: '对手-他派蛊师',
    scale: 1.0,
    // 复用韩不留的立绘和动作，CSS 换色
    skin: '对手-韩不留',
    filter: 'hue-rotate(160deg) saturate(0.8)',
    eliteLook: true,
    tactics: '月刃远程甩过来，不吃反击；抢的就是那一件一转蛊。',
    text: ['「这块石头是我们先踩的。」对面那只蛊师亮出弯月般的刃。', '传承里最不缺的就是同行，和最不够的就是地方。'],
  },
  'tie-ruonan': {
    id: 'tie-ruonan',
    name: '铁若男',
    tier: 'boss' as const,
    moves: ['gold-needle', 'gold-blade'],
    prefix: '对手-铁若男',
    scale: 1.06,
    tactics: '金针一次三下磨人；额上印记化出的金色飞刀必中，一场只有一把。带多段的先磨掉金针，带必中的别怕她躲。',
    text: ['铁家四老立在殿口，手里三根金针捏得发响。', '「无极搜锁一开，你插翅难逃。」'],
  },
  // 不打架的客串（Y5）：改炼定仙游时在殿外看着，借用对手窗口的立绘和气泡
  'feng-tianyu': {
    id: 'feng-tianyu',
    name: '风天语',
    tier: 'mob' as const,
    moves: [],
    prefix: '对手-风天语',
    tactics: '炼蛊大师，只在殿外看着，不动手。',
    text: ['一个瘦高的炼蛊师抱着脑袋立在殿外，腰上挂着药囊和小铜炉。', '他看得比谁都清楚：那不是第二空窍蛊。'],
  },
  'bing-ninbing': {
    id: 'bing-ninbing',
    name: '白凝冰',
    tier: 'boss' as const,
    moves: ['ice-blade', 'frost', 'bingpo'],
    prefix: '对手-白凝冰',
    scale: 1.02,
    tactics:
      '冰刃一次三截，寒气十下里冻住两次；一场憋一次北冥冰魄爆发，必中。带必中的先把爆发逼出来，带回复的撑得住那一下。',
    text: ['白凝冰立在殿门口，指尖垂着一截冰刃。', '「北冥冰魄体……你挡不住我。」'],
  },
};

const SANWANG_NODES: Record<string, NodeDef> = {
  // 第一层：三道光柱（原著第一百二十四章）
  'beam-dog': {
    id: 'beam-dog',
    kind: 'event',
    name: '犬王光柱',
    icon: '图标-奇遇',
    art: '奇遇-商家城囤蛊',
    anim: '秘境-入阵',
    text: ['三道彩色光柱从三叉山最高的三座峰顶冲天而起。', '「三王传承，今日开启，正魔不论，留待有缘。」'],
    event: {
      auto: {
        text: ['你踩进青光里。掌心一凉，是一转驭犬蛊。', '福地里天空灰白，土丘像一座座坟。'],
        flags: { road: 'dog', dogs: DOGS_START },
      },
    },
  },
  'beam-letter': {
    id: 'beam-letter',
    kind: 'event',
    name: '信王光柱',
    icon: '图标-奇遇',
    art: '奇遇-商家城囤蛊',
    anim: '秘境-入阵',
    text: ['三道彩色光柱从三叉山最高的三座峰顶冲天而起。', '「三王传承，今日开启，正魔不论，留待有缘。」'],
    event: {
      auto: {
        text: ['你踩进白光里。掌心一凉，是一转纸鹤蛊。', '纸鹤从袖口钻出去，替你看路。'],
        flags: { road: 'letter' },
      },
    },
  },
  'beam-blast': {
    id: 'beam-blast',
    kind: 'event',
    name: '爆王光柱',
    icon: '图标-奇遇',
    art: '奇遇-商家城囤蛊',
    anim: '秘境-入阵',
    text: ['三道彩色光柱从三叉山最高的三座峰顶冲天而起。', '「三王传承，今日开启，正魔不论，留待有缘。」'],
    event: {
      auto: {
        text: ['你踩进赤光里。掌心一凉，是三颗一转爆蛋蛊。', '蛋皮薄得能看见里头翻火的芯子。'],
        flags: { road: 'blast' },
      },
    },
  },

  // 第二层
  'dog-pack': {
    id: 'dog-pack',
    kind: 'mob',
    name: '野狗群',
    icon: '图标-妖兽',
    art: '节点-野狗群',
    foe: 'wild-dog',
    text: [
      '第一轮 3 只野狗，第三轮 6 只——有伤、有老，全是流浪的。',
      '过了这一轮，传承给一只驭犬蛊，也是下一关的钥匙。',
    ],
  },
  'tenth-round': {
    id: 'tenth-round',
    kind: 'ruin',
    name: '第十轮择利',
    icon: '图标-遗迹',
    art: '节点-第十轮择利',
    anim: '秘境-参悟',
    text: [
      '前十轮淘汰了大半非奴道的蛊师。到第十轮，传承让挑战者自己选一项对自己有利的。',
      '土丘上摆开三样东西，任你挑一件。',
    ],
  },
  'refine-gu': {
    id: 'refine-gu',
    kind: 'chest',
    name: '炼蛊关',
    icon: '图标-宝箱',
    art: '节点-炼蛊关',
    anim: '秘境-开宝箱',
    text: ['炼道的关卡：一具小炉，材料齐全，只看你手稳不稳。', '炼成了，炉里那一味就是你的。'],
    chest: {
      // 按灵力判定；炼废 = 炸炉（扣 15% 气血，这一份也没了）
      check: { stat: 'power' },
      trapChance: 1,
      cutShare: 0.15,
      failText: ['炉盖一掀，炸了。满脸灰，火气往上撞。'],
    },
  },
  'egg-swarm': {
    id: 'egg-swarm',
    kind: 'mob',
    name: '红蛋人群',
    icon: '图标-妖兽',
    art: '节点-红蛋人',
    foe: 'red-egg',
    text: ['地缝里滚出一大片红壳，顶上裂开一张张人脸。', '炎道的路，从一开始就等着人撞。'],
  },

  // 第三层
  'han-liu': {
    id: 'han-liu',
    kind: 'event',
    name: '韩不留起杀心',
    icon: '图标-奇遇',
    art: '奇遇-韩不留起杀心',
    text: [
      '韩不留牵着 11 条狗站在土丘后，眼睛在你身上数驭犬蛊。',
      '「蛊师死了不能引爆自己的蛊虫……人人都想杀人夺蛊。」',
    ],
    event: {
      choices: [
        {
          label: '先下手为强',
          note: '打韩不留：赢了多掉一份（杀人夺蛊），再多 1 只驭犬蛊',
          safe: false,
          outcome: {
            text: ['「既然你先起了杀心。」你把狗群往前一压。'],
            fight: 'han-buliu',
            fightExtra: 1,
            fightFlags: { robbed: true },
          },
        },
        {
          label: '带着狗群绕开他',
          note: '身法判定：成就跳过这一场（没有奖励），败了被他偷袭',
          safe: true,
          check: { stat: 'agility' },
          outcome: {
            text: ['你压着狗群贴着土丘根绕过去，狗蹄子踏得极轻。', '韩不留骂了一声，没敢追。'],
            skip: true,
          },
          lose: {
            text: ['到底是绕不开——他一声令下，狗群咬住尾巴。', '带着伤才甩脱，血已经少了一截。'],
            cutShare: 0.15,
            fight: 'han-buliu',
          },
        },
      ],
    },
  },
  'mastiff-pack': {
    id: 'mastiff-pack',
    kind: 'elite',
    name: '狮獒群',
    icon: '图标-精英',
    art: '节点-狮獒群',
    foe: 'mastiff',
    text: ['关底是犬王的王牌部队：一群狮獒，比五岳犬还强。', '两头上古异兽是犬王的左右臂膀，每头都抵得上五转蛊师。'],
  },
  'rest-dog': {
    id: 'rest-dog',
    kind: 'spring',
    name: '调息',
    icon: '图标-灵泉',
    anim: '秘境-泡灵泉',
    text: ['坟一样的土丘之间有一小洼清水，是福地里仅剩的活气。', '你坐下来调息，把狗群散在四周。'],
  },
  'rest-letter': {
    id: 'rest-letter',
    kind: 'spring',
    name: '调息',
    icon: '图标-灵泉',
    anim: '秘境-泡灵泉',
    text: ['炼道的关口之间留着一处泉眼，纸鹤落在水边梳羽毛。', '你坐下来调息，让纸鹤再替你看一趟路。'],
  },
  'rival-standoff': {
    id: 'rival-standoff',
    kind: 'elite',
    name: '争夺',
    icon: '图标-精英',
    art: '节点-韩不留',
    foe: 'rival-gu-master',
    text: ['炼道的传承哪一处好拿，纸鹤先替你看见了——所以别人也看见了。', '他派蛊师拦住去路，手里那枚一转蛊还没捂热。'],
  },
  'lava-croco': {
    id: 'lava-croco',
    kind: 'elite',
    name: '火炭山熔岩鳄',
    icon: '图标-精英',
    art: '节点-炼蛊关',
    foe: 'lava-croc',
    text: ['黑沙底下拱出一条熔岩鳄，热浪把空气扭成一团。', '炎道的关口，从来不缺火里养出来的东西。'],
  },
  'rest-blast': {
    id: 'rest-blast',
    kind: 'spring',
    name: '调息',
    icon: '图标-灵泉',
    anim: '秘境-泡灵泉',
    text: ['火炭山脚下一洼冷水，红蛋人的壳漂在上头。', '你坐下来调息，把炸糊的头发捋了捋。'],
  },

  // 第四层：青铜大殿（三路汇合，一层里好几步）
  'earth-spirit': {
    id: 'earth-spirit',
    kind: 'event',
    name: '地灵的考验',
    icon: '图标-奇遇',
    art: '节点-青铜大殿',
    anim: '秘境-参悟',
    text: [
      '玄青色大殿里立着一头大如房屋的巨龟——地灵霸龟。殿中央是一只三足两耳的青铜大鼎。',
      '「完成原福地主人临死前的执念，炼成第二空窍蛊。这便是考验。」',
    ],
    event: {
      choices: [
        {
          label: '接下考验',
          note: '霸龟替你治伤（回 50% 气血），往里走',
          safe: true,
          outcome: {
            text: ['霸龟一张口，灰白的天光落下来，伤处一阵清凉。', '「炉子给你留着。三味蛊材，缺一味便炸。」'],
            healShare: 0.5,
            flags: { trial: 'accepted' },
          },
        },
        {
          label: '不接，原路退出',
          note: '按撤退结算，已经拿到的照拿',
          safe: false,
          outcome: {
            text: ['你退了三步。霸龟的眼睛没动，像早知道会有人这样。', '「执念不成，福地也不留你。」'],
            retreat: true,
          },
        },
      ],
    },
  },
  'hall-eggs': {
    id: 'hall-eggs',
    kind: 'mob',
    name: '红蛋人拦路',
    icon: '图标-妖兽',
    art: '节点-红蛋人',
    foe: 'red-egg',
    text: ['鼎边的阴影里滚出一片红壳——这福地里本来就养着这些东西。', '炼蛊之前，先把它们踩干净。'],
  },
  'smelt-blind': {
    id: 'smelt-blind',
    kind: 'event',
    name: '开炉炼蛊',
    icon: '图标-宝箱',
    art: '节点-青铜大殿',
    anim: '秘境-开宝箱',
    text: ['三味蛊材下炉，青铜鼎里火光冲天。殿门口，白凝冰替你挡着铁若男。', '你自估：「至少有五成的把握。」'],
    event: {
      // 第一轮没有选项：照原著炼第二空窍蛊，最后一只三更蛊时背后挨一截冰刃
      auto: {
        text: ['炉火将歇，最后一只三更蛊正要落进去——', '一截冰刃从背后贯穿。白凝冰收回手，「抱歉。」'],
        flags: { smelt: 'second' },
      },
    },
  },
  'ask-bing': {
    id: 'ask-bing',
    kind: 'event',
    name: '白凝冰，你演够了吗',
    icon: '图标-奇遇',
    art: '奇遇-白凝冰你演够了吗',
    text: [
      '炉火又升起来。这一次你记得：白凝冰会在最后一只三更蛊时出手。',
      '她立在殿门口，指尖还垂着一截冰刃，装作在替你看住铁若男。',
    ],
    event: {
      choices: [
        {
          label: '「白凝冰，你演够了吗？」',
          note: '识破她：逼她替你挡住铁若男（第五层她替挡 3 下，铁若男开场少两成气血）',
          safe: true,
          when: (run) => run.flags.remember === true,
          outcome: {
            text: [
              '「定星蛊种在我左前臂，你以为我察觉不到？」',
              '白凝冰盯了你半晌，转身面向殿口，把冰刃对准了铁若男。',
            ],
            flags: { seen: true },
          },
        },
        {
          label: '不动声色',
          note: '照她的安排走：第五层她照样翻脸',
          safe: false,
          when: (run) => run.flags.remember === true,
          outcome: {
            text: ['你把话咽回去，继续添蛊材。', '背后那一截冰刃的凉意，你记得清清楚楚。'],
            flags: { seen: false },
          },
        },
      ],
    },
  },
  'ask-smelt': {
    id: 'ask-smelt',
    kind: 'event',
    name: '改炼定仙游',
    icon: '图标-宝箱',
    art: '节点-福地崩溃',
    anim: '秘境-开宝箱',
    text: [
      '霸龟的考验还写着「第二空窍蛊」，可你记得这一炉炼到最后会出什么事。',
      '玉竹、星屑、荣耀之光——另一味方子也在你心里。',
    ],
    event: {
      choices: [
        {
          label: '放弃第二空窍蛊，改炼定仙游',
          note: '第五层换铁若男守；打赢碧芒一闪传送出福地，称号「春秋蝉主」',
          safe: true,
          when: (run) => run.flags.remember === true,
          outcome: {
            text: ['「福地要崩，大同风将起——空窍再高也走不出去。」', '你把第二味方子投进炉里：玉竹、星屑、荣耀之光。'],
            flags: { smelt: 'dingxian' },
            // 原著第二百零五章的高光：天瀑光河 + 殿外的风天语（Y5；只影响演出）
            cutscene: {
              video: '过场-天瀑光河.mp4',
              // 定场诗（第二百零五章「于万众瞩目中，心潮奔腾，化为一诗」）：原文页面段落被打乱，每联两句原文相连；三联的先后按诗意排，用户核对确认过
              lines: [
                '杀招——天瀑光河！',
                '{pet}浑身金黄灿烂，在天瀑光河中逆流飞翔。',
                '于万众瞩目中，心潮奔腾，化为一诗：',
                '「千古地仙随风逝，昔日三王归青冢。」',
                '「阳莽憾陨谁无败？卷土重来再称王。」',
                '「今日暂且展翼去，明朝登仙笞凤凰！」',
                '太古的荣耀之光，照耀着蚕茧。',
              ],
              say: '今日暂且展翼去，明朝登仙笞凤凰！',
            },
            cameo: {
              foe: 'feng-tianyu',
              art: '奇遇-风天语.png',
              lines: [
                '这不可能！',
                '他用了宙道蛊虫来加速？',
                '定仙游！他真的在炼制定仙游蛊吗？想不到我风天语，居然有幸能看到炼制仙蛊的场面啊！',
              ],
            },
          },
        },
        {
          label: '接着炼第二空窍蛊',
          note: '照原著的考验走；第五层打白凝冰',
          safe: false,
          when: (run) => run.flags.remember === true,
          outcome: {
            text: ['六转仙蛊就在炉口，你舍不得放。', '「再试一次。这一次我先防着她。」'],
            flags: { smelt: 'second' },
          },
        },
      ],
    },
  },
  collapse: {
    id: 'collapse',
    kind: 'boss',
    name: '福地崩溃',
    icon: '图标-守护',
    art: '节点-福地崩溃',
    anim: '秘境-得宝',
    text: ['灰白的天裂开一道道口子，大同风起来了——这块快塌的福地撑不到下一刻。', '这一层打完，不管输赢都得出去。'],
    foe: 'bing-ninbing',
  },
};

/**
 * 第二、三层的节点按这一路给（任务书 §3 Y0 那张表）。
 * 第四层的步序看「记不记得」：记得才有那两个原著问题。
 */
function layerNodes(run: Run, layer: LayerDef): string[] {
  const road = roadOf(run);
  if (layer.index === 1) return ['beam-dog', 'beam-letter', 'beam-blast'];
  if (layer.index === 2) {
    if (road === 'dog') return ['dog-pack', 'tenth-round'];
    if (road === 'letter') return ['refine-gu'];
    return ['egg-swarm'];
  }
  if (layer.index === 3) {
    if (road === 'dog') return ['han-liu', 'mastiff-pack', 'rest-dog'];
    if (road === 'letter') return ['rival-standoff', 'rest-letter'];
    return ['lava-croco', 'rest-blast'];
  }
  // 第四层是线性多步（rules.steps 给），第五层是守护：用层里写死的那个节点
  return layer.nodes ?? [];
}

function hallSteps(run: Run): string[] {
  // 倒带回来时红蛋人那一场已经打过了，不再重打（adventure-roadmap §3「春秋蝉」）
  if (run.flags.remember === true) return ['earth-spirit', 'ask-bing', 'ask-smelt'];
  return ['earth-spirit', 'hall-eggs', 'smelt-blind'];
}

const SANWANG_LAYERS: LayerDef[] = [
  { index: 1, name: '三叉山 · 光柱', art: '地图.png', nodes: ['beam-dog', 'beam-letter', 'beam-blast'] },
  { index: 2, name: '三叉山 · 犬王传承', art: '地图.png' },
  { index: 3, name: '三叉山 · 关底', art: '地图.png' },
  { index: 4, name: '三叉山 · 青铜大殿', art: '节点-青铜大殿.png', linear: true },
  { index: 5, name: '三叉山 · 福地崩溃', art: '节点-福地崩溃.png', nodes: ['collapse'] },
];

const SANWANG_BLESSINGS: BlessingId[] = ['echo', 'borrow', 'core', 'light', 'last-stand', 'mouse'];

/**
 * 第五层开打前的两件事（任务书 §3 Y0 那张四种组合的表）：
 *  - 没识破：最后一只三更蛊时被冰刃贯穿——扣掉当前气血的 `BACKSTAB_CUT`（设计写「减半」，按模拟调）；
 *  - 识破 + 改炼定仙游：白凝冰被逼着挡在前面（`guard` `GUARD_TIMES` 下；设计写 3 下，按模拟调）；
 *  - 识破 + 照原著炼：没背刺，全血上殿。
 */
function patchSanwang(ctx: FightCtx): void {
  const { run, party } = ctx;
  if (run.layer !== 5) return;
  const me = party[0];
  if (!seenOf(run)) {
    // 背刺：扣掉当前气血的 28%（设计写的是「减半」，按模拟调到这个数才落进目标区间，见回报）
    const now = me.hpNow ?? me.hp;
    me.hpNow = Math.max(1, now - Math.floor(now * BACKSTAB_CUT));
    return;
  }
  if (dingxianOf(run)) {
    // 白凝冰被逼着挡在前面（guard 1 下；设计写 3 下，按模拟调，见回报）
    me.guard = { by: '白凝冰', times: GUARD_TIMES };
  }
}

/** 每打赢一场多一只驭犬蛊（原著：过一轮得一只）；韩不留那一场杀人夺蛊再多一只 */
function afterSanwangFight(ctx: FightCtx): void {
  const { run, node } = ctx;
  if (roadOf(run) !== 'dog') return;
  const gain = node.id === 'han-liu' ? 2 : 1;
  run.flags.dogs = Math.min(DOGS_MAX, dogsOf(run) + gain);
}

/** 春秋蝉倒回哪里（任务书 §3 Y0）：2、3 层回本层开头；大殿里红蛋人那一场回大殿开头（不算记得）；开炉以后、第五层回大殿开头 + 记得 */
function rewindSanwang(
  run: Run,
  layer: number,
): { layer: number; flags?: Record<string, string | number | boolean> } | null {
  if (!canRewind(run)) return null;
  if (layer === 2 || layer === 3) return { layer };
  if (layer === 4) {
    // 红蛋人是第 2 步：开炉（第 3 步）之前输的，倒回大殿开头，不算「记得」
    return run.step <= 2 ? { layer: 4 } : { layer: 4, flags: { remember: true } };
  }
  if (layer === 5) return { layer: 4, flags: { remember: true } };
  return null;
}

export const SANWANG: DungeonDef = {
  id: 'sanwang',
  version: DUNGEON_VERSION,
  name: '三王传承',
  // 原著境界：筑基（筑基初期 = stage 9）
  originStage: 9,
  cover: '封面.png',
  map: '地图.png',
  video: { enter: '过场-入口.mp4', rewind: '过场-春秋蝉.mp4' },
  opening: [
    '「三王传承，今日开启，正魔不论，留待有缘。」',
    '三道彩色光柱从三叉山最高的三座峰顶冲天而起，立在灰白的天上。',
    '这是魔道传承，十分危险——前世有人耗了半年才打到关底。',
  ],
  foes: SANWANG_FOES,
  nodes: SANWANG_NODES,
  layers: SANWANG_LAYERS,
  blessings: SANWANG_BLESSINGS,
  endings: [
    { id: 'second-void', name: '第二空窍' },
    { id: 'ding-xian-you', name: '定仙游' },
  ],
  lines: {
    retreat: ['你捏碎手里的蛊，一阵天旋地转，人已躺在三叉山下。', '怀里那点东西，还在。'],
    lose: ['福地的裂缝轰然张开，你被大同风吹出三叉山。', '伤得不轻，可已经拿到手的照拿。'],
    rewind: '自爆，催动春秋蝉',
    rewindText: [
      '你把所有蛊虫、真元、血肉、魂灵一股脑灌进那只六转仙蛊。',
      '蝉翅一振，光阴倒流——「每一次催动春秋蝉，都是一场豪赌。」',
      '春秋蝉耗尽，沉眠了。这一趟只能赌这一次。',
    ],
    remember: '你记得：白凝冰会在最后一只三更蛊时出手。',
    expired: ['福地的裂缝合上了。你在外面过了三天，人才被吐出来。', '这一趟没走完，算撤了。'],
  },
  rules: {
    // 第五层是福地崩溃：打完不管输赢都得出去，撤不出去
    canRetreat: (_run, layer) => layer < 5,
    rewindTarget: rewindSanwang,
    // 进第五层不另存快照：留着大殿那一份，倒带才回得到炼蛊之前
    snapshot: (_run, entering) => entering !== 5,
    nodes: layerNodes,
    steps: (run) => hallSteps(run),
    gu: (run) => (typeof run.flags.road === 'string' ? GU_OF[roadOf(run)] : null),
    pack: dogsOf,
    patchFight: patchSanwang,
    afterFight: afterSanwangFight,
    // 守护按标记换人：改炼定仙游那一局铁若男守在殿口
    boss: (run) => (dingxianOf(run) ? 'tie-ruonan' : 'bing-ninbing'),
    ending: endingOf,
    // 纸鹤蛊：进第二层前揭开第二、三层；进大殿前亮出两种守护的打法
    revealLayers: (run) => {
      if (GU_OF[roadOf(run)] !== 'gu-crane') return [];
      return run.layer >= 2 ? [run.layer, run.layer + 1] : [2, 3];
    },
    revealFoes: (run) => {
      if (GU_OF[roadOf(run)] !== 'gu-crane' || run.layer < 4) return [];
      return ['bing-ninbing', 'tie-ruonan'];
    },
    // 「福地内第 N 天（外面已过 3N 天）」：原著里里面过一天外面过三天。只是文案，不影响数值
    day: (run) => ({
      label: `福地内第 ${run.layer} 天（外面已过 ${run.layer * 3} 天）· ${ROAD_NAMES[roadOf(run)]}一路`,
      cracks: run.layer,
    }),
  },
};

/** 这一路的名字（小窗和日记用） */
export function roadLabel(run: Run): string {
  return ROAD_NAMES[roadOf(run)];
}

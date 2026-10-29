/**
 * 对战解说（修炼路线 X0）：把引擎事件翻成一句模板台词，不调模型。
 * 每种事件、每件法宝、每个招式配几句轮着来；`decide`、`start` 这类没有画面的返回 null。
 * 模板里 {a} 是事件主角的名字、{b} 是对手、{d} 伤害、{h} 回血；每句不超过 40 字（名字按 12 字算）。
 * 化鸽遁那句「化成一只鸽子」只给真的有化鸽遁的一方（skillSets 里带），其余闪避走通用句。
 */
import type { BattleEvent, SkillId } from './battle.ts';

/** 一个事件一个词条；词条内的句子由 rng 轮着挑 */
const HIT_LINES: Record<string, string[]> = {
  'water-gun': ['{a}掏出水枪滋过去，-{d}', '{a}端起水枪一顿猛滋，-{d}', '{a}的水枪正中{b}，-{d}'],
  poker: ['{a}甩出两张扑克牌，-{d}', '{a}指尖弹飞扑克牌，-{d}', '{a}的王牌划过空气，-{d}'],
  shuttlecock: ['{a}一个飞脚踢出毽子，-{d}', '{a}把毽子踢得虎虎生风，-{d}', '{a}的毽子直取面门，-{d}'],
  snowball: ['{a}团了个雪球砸过去，-{d}', '{a}的雪球啪地糊在{b}身上，-{d}'],
  duster: ['{a}挥起鸡毛掸子一通掸，-{d}', '{a}的掸子扫过{b}的鼻尖，-{d}'],
  juggle: ['{a}抛出三个彩球，-{d}', '{a}三球连发砸向{b}，-{d}'],
  top: ['{a}放出陀螺嗡嗡转着撞过去，-{d}', '{a}的陀螺咬住{b}不放，-{d}'],
  'whale-tail': ['{a}掀起一条鲸尾拍下去，-{d}', '{a}借鲸尾之力横扫，-{d}'],
  tray: ['{a}甩出银托盘，当！-{d}', '{a}的托盘旋着飞过去，-{d}'],
  slingshot: ['{a}拉开弹弓弹出星星糖，-{d}', '{a}一弹弓正中{b}，-{d}'],
  firework: ['{a}点燃烟花轰向{b}，-{d}', '{a}的烟花在{b}脚边炸开，-{d}'],
  unarmed: ['{a}抡起小拳头捶过去，-{d}', '{a}握着小拳头冲上去乱捶，-{d}', '{a}鼓起腮帮子挥拳，-{d}'],
};

const KIND_LINES: Record<string, string[]> = {
  dodge: ['{a}侧身一闪躲开了', '{a}垫步后跳，堪堪躲过', '{a}趴下一缩，让了个空'],
  dodgeDove: ['{a}化成一只鸽子飞开了', '{a}鸽影一闪，扑棱棱躲开'],
  combo: ['{a}趁势再补一下，-{d}', '{a}不给喘息机会，追击！-{d}', '{a}连招接上，-{d}'],
  counter: ['{a}顺手反打一记，-{d}', '{a}后发先至回敬一拳，-{d}'],
  beast: ['{a}的灵兽窜上去咬了一口，-{d}', '{a}的灵兽扑出偷袭，-{d}'],
  skip: ['{a}被定在原地，动弹不得', '{a}愣在原地错过了出手'],
  skipFreeze: ['{a}冻成了冰棍，动弹不得', '{a}浑身挂着冰，错过了出手'],
  skipSleep: ['{a}站着睡着了，错过了出手', '{a}还在打呼，没想起来出手'],
  skipDream: ['{a}神魂被牵进梦里，这一拍醒不过来', '{a}眼神一散，陷在梦里没出手'],
  skipFloat: ['{a}被风托着飘在半空，手脚乱划', '{a}飘了起来，够不着地'],
  skipSham: ['{a}还躺在地上装死，没爬起来', '{a}装死装得正香，缓了一拍才起身'],
  miss: ['{a}眼前一团黑，打歪了', '{a}抹着脸上的墨乱挥，落了空'],
  decoy: ['{a}的水母分身替它挨了这下', '打中的是{a}的水母分身，本体没事'],
  mirror: ['{a}身前一重魂影被斩碎，本体没事', '斩中的只是魂影，{a}本体还在'],
  'play-dead': ['{a}两眼一翻装死过去，硬是留了口气', '{a}直挺挺倒下，又幽幽爬起来'],
  strike: ['一道天雷劈下，-{d}', '雷光轰在{a}头顶，-{d}', '劫雷炸响，-{d}'],
};

const SKILL_LINES: Record<string, string[]> = {
  bloom: ['{a}凭空变出一朵花，闻着精神一振，气血 +{h}', '{a}拈花一笑，气血 +{h}'],
  'lion-roar': ['{a}鼓足力气一声狮子吼，-{d}，{b}被震得动不了', '{a}吼得地动山摇，-{d}，{b}愣在原地'],
  'blue-whale': ['{a}身后浮现蓝鲸虚影砸落，-{d}', '{a}唤出蓝鲸现世，-{d}'],
  'whale-song': ['{a}唱起鲸歌，{b}听着听着睡着了', '{a}哼了段摇篮曲，{b}眼皮直打架'],
  ink: ['{a}噗地喷出一团墨汁，糊了{b}一脸', '{a}一口墨汁喷过去，{b}眼前一黑'],
  'whale-gulp': ['{a}一口鲸吞，-{d}，气血 +{h}', '{a}张嘴猛吸，{b}的灵气 -{d}，自己 +{h}'],
  'myriad-self': ['{a}轻轻一笑，分出三重魂影——我即是我，杀之不尽', '{a}三重魂影落在身侧，个个都是我'],
  'dream-chant': ['{a}低声念咒，魂丝缠上{b}的神魂，-{d}', '{a}念完一句，{b}眼神一散，-{d}'],
  'finger-sword': ['{a}五指收拢成拳、高举过顶，拳心射出一道剑光，-{d}', '{a}拳心一亮，剑光已到{b}身上，-{d}'],
  'dragon-palm': ['{a}一掌推出，亢龙有悔！-{d}', '{a}掌风化作龙影，直取{b}，-{d}'],
  'farewell-wind': ['{a}袖口一卷，一阵清风送向{b}，-{d}', '{a}挥手道别：一路顺风～-{d}'],
};

/** 控制被扛住（X20）：狮子吼 / 鲸歌 / 魂牵梦绕 / 送友风没压住，只说伤害与对方的反应 */
const RESIST_LINES: Record<string, string[]> = {
  'lion-roar': ['{a}一声狮子吼，-{d}，{b}晃了晃，没被震住', '{a}吼得地动山摇，-{d}，{b}稳住心神没愣神'],
  'whale-song': ['{a}唱起鲸歌，{b}甩甩头，没被哄睡', '{a}哼了段摇篮曲，{b}打了个哈欠，还挺精神'],
  'dream-chant': ['{a}低声念咒，-{d}，{b}神魂一紧，没入梦', '{a}念完一句，-{d}，{b}眼神一晃又醒了'],
  'farewell-wind': ['{a}袖口一卷，-{d}，{b}脚下生根，没被吹起来', '{a}挥手道别，-{d}，{b}站稳了没飘走'],
};

/**
 * 招式表（历练路线 Y0）：一转蛊和对手的招式，一件一条，`{g}` 是替挡者的名字。
 * 只在这台机器上显示，不上网（这些招不进名帖），所以照旧全用模板。
 */
const MOVE_LINES: Record<string, string[]> = {
  'gu-dogs': ['{a}放出一群狗扑上去，-{d}', '{a}的狗群撕成一团，-{d}', '{a}驱狗掩上，-{d}'],
  'gu-crane': ['{a}放出纸鹤啄向{b}，-{d}', '{a}的纸鹤盘旋而下，-{d}'],
  'gu-egg': ['{a}掷出爆蛋，轰然炸开，-{d}', '{a}的爆蛋在{b}脚边炸了，-{d}'],
  'dog-bite': ['{a}扑上来就是一口，-{d}', '{a}的犬牙咬住{b}，-{d}'],
  'egg-burst': ['{a}滚过来撞在{b}身上炸开，-{d}', '{a}闷头撞上来炸开，-{d}'],
  'mastiff-maul': ['{a}猛扑下来压住{b}，-{d}', '{a}一爪拍下，-{d}'],
  'han-dogs': ['{a}驱犬围攻，-{d}', '{a}一声令下，群狗扑向{b}，-{d}'],
  'moon-blade': ['{a}挥出一道月刃，-{d}', '{a}的月刃掠向{b}，-{d}'],
  'gold-needle': ['{a}弹出三根金针，-{d}', '{a}的金针钉向{b}，-{d}'],
  'gold-blade': ['{a}额上金光一闪，飞刀已到，-{d}', '{a}的金色飞刀破空而来，-{d}'],
  'ice-blade': ['{a}挥出三截冰刃，-{d}', '{a}的冰刃擦着{b}飞过，-{d}'],
  frost: ['{a}吐出一口寒气，-{d}', '{a}的寒气罩住{b}，-{d}'],
  bingpo: ['{a}化作北冥冰魄，天地一白，-{d}', '{a}的冰魄爆发轰在{b}身上，-{d}'],
};

/** 鸡毛掸子让对方迟缓、弹弓打两颗、五指拳心剑穿护体时的专属句（代替那件法宝 / 那招的普通句） */
const FLAG_LINES: Record<string, string[]> = {
  slowed: ['{a}的掸子挠得{b}笑岔气，-{d}', '{b}被{a}掸得直乐，慢了一拍，-{d}'],
  twin: ['{a}的弹弓一发两颗，-{d}', '{a}连弹两颗星星糖，-{d}'],
  pierce: ['{a}的剑气穿过{b}的护体，-{d}', '{b}的泡泡护体被一剑捅破，-{d}'],
  // 降龙十八掌的后劲（X16）
  surge: ['{a}掌力的后劲到了，-{d}', '{a}上一掌的余劲追上，-{d}'],
};

const END_LINES = ['{a}赢了！', '{a}站到了最后！', '{b}躺平了，{a}获胜'];

/** 送友风把对方送回家（X16）：串门切磋里的 `end.reason = 'farewell'` */
const FAREWELL_END_LINES = ['{b}被一阵风送回家了', '{b}被{a}的送友风送走，回家去了'];

/** 替挡（Y0，定仙游结局）：`{g}` 是替挡者的名字，`{a}` 是被护住的那一方 */
const GUARD_LINES = ['{g}挡在{a}前面，硬接了这一下', '{g}一把拦在{a}身前，这一下没打着'];

/** 名字本身以「的」结尾时，`{a}的` / `{b}的` 只留一个「的」；只认占位符紧跟一个「的」的写法 */
function fill(template: string, a: string, b = '', d = 0, h = 0, g = ''): string {
  return template.replace(/\{([abdhg])\}(的?)/g, (_match, key: string, de: string) => {
    if (key === 'd' || key === 'h') return String(key === 'd' ? d : h) + de;
    const name = key === 'a' ? a : key === 'g' ? g : b;
    return de && name.endsWith('的') ? name : name + de;
  });
}

/**
 * 事件 -> 台词；返回 null 表示这个事件不配台词。
 * skillSets 可选：双方的招式表，用来判断闪避的一方是不是真有化鸽遁（「化成鸽子」只有它会）。
 */
export function lineOf(
  event: BattleEvent,
  names: [string, string],
  rng: () => number,
  skillSets?: [SkillId[], SkillId[]],
): string | null {
  const a = names[event.actor];
  const b = names[event.actor ^ 1];
  const pick = (lines: string[]): string => lines[Math.floor(rng() * lines.length)];
  // 会心和泡泡挡伤的前后缀（加在一句台词外面，总长仍 ≤ 40 字）
  const decorate = (line: string): string => {
    let out = line;
    if ('crit' in event && event.crit) out = `会心一击！${out}`;
    if ('blocked' in event && event.blocked) out = `${out}（泡泡挡掉一半）`;
    return out;
  };
  switch (event.kind) {
    case 'start':
    case 'decide':
      return null;
    case 'hit': {
      const lines = event.surge
        ? FLAG_LINES.surge
        : event.slowed
          ? FLAG_LINES.slowed
          : event.twin
            ? FLAG_LINES.twin
            : event.move
              ? MOVE_LINES[event.move]
              : HIT_LINES[event.weapon ?? 'unarmed'];
      return decorate(fill(pick(lines), a, b, event.damage));
    }
    case 'combo':
      return decorate(fill(pick(event.surge ? FLAG_LINES.surge : KIND_LINES.combo), a, b, event.damage));
    case 'dodge': {
      const hasDove = skillSets?.[event.actor]?.includes('dove') ?? false;
      const lines = hasDove ? KIND_LINES.dodgeDove : KIND_LINES.dodge;
      return fill(pick(lines), a);
    }
    case 'counter':
      return decorate(fill(pick(KIND_LINES.counter), a, b, event.damage));
    case 'beast':
      return decorate(fill(pick(KIND_LINES.beast), a, b, event.damage));
    case 'skip':
      return fill(
        pick(
          event.cause === 'freeze'
            ? KIND_LINES.skipFreeze
            : event.cause === 'sleep'
              ? KIND_LINES.skipSleep
              : event.cause === 'dream'
                ? KIND_LINES.skipDream
                : event.cause === 'float'
                  ? KIND_LINES.skipFloat
                  : event.cause === 'sham'
                    ? KIND_LINES.skipSham
                    : KIND_LINES.skip,
        ),
        a,
      );
    case 'miss':
      return fill(pick(KIND_LINES.miss), a);
    case 'decoy':
      return fill(pick(KIND_LINES.decoy), a);
    case 'guard':
      return fill(pick(GUARD_LINES), a, b, 0, 0, event.by);

    case 'mirror':
      return fill(pick(KIND_LINES.mirror), a);
    case 'play-dead':
      return fill(pick(KIND_LINES['play-dead']), a);
    case 'skill':
      if (event.pierce) return decorate(fill(pick(FLAG_LINES.pierce), a, b, event.damage ?? 0));
      if (event.resisted)
        return decorate(
          fill(pick(RESIST_LINES[event.skill] ?? SKILL_LINES[event.skill]), a, b, event.damage ?? 0, event.heal ?? 0),
        );
      return decorate(fill(pick(SKILL_LINES[event.skill]), a, b, event.damage ?? 0, event.heal ?? 0));
    case 'strike':
      return decorate(fill(pick(KIND_LINES.strike), a, b, event.damage));
    case 'end':
      return fill(pick(event.reason === 'farewell' ? FAREWELL_END_LINES : END_LINES), a, b);
  }
}

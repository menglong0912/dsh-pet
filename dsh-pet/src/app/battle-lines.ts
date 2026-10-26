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
  miss: ['{a}眼前一团黑，打歪了', '{a}抹着脸上的墨乱挥，落了空'],
  decoy: ['{a}的水母分身替它挨了这下', '打中的是{a}的水母分身，本体没事'],
  mirror: ['{a}的一重魂影替本体被斩碎', '斩中的是{a}的一重魂影，本体还在'],
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
};

/** 鸡毛掸子让对方迟缓、弹弓打两颗、五指拳心剑穿护体时的专属句（代替那件法宝 / 那招的普通句） */
const FLAG_LINES: Record<string, string[]> = {
  slowed: ['{a}的掸子挠得{b}笑岔气，-{d}', '{b}被{a}掸得直乐，慢了一拍，-{d}'],
  twin: ['{a}的弹弓一发两颗，-{d}', '{a}连弹两颗星星糖，-{d}'],
  pierce: ['{a}的剑气穿过{b}的护体，-{d}', '{b}的泡泡护体被一剑捅破，-{d}'],
};

const END_LINES = ['{a}赢了！', '{a}站到了最后！', '{b}躺平了，{a}获胜'];

function fill(template: string, a: string, b = '', d = 0, h = 0): string {
  return template.split('{a}').join(a).split('{b}').join(b).split('{d}').join(String(d)).split('{h}').join(String(h));
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
      const lines = event.slowed
        ? FLAG_LINES.slowed
        : event.twin
          ? FLAG_LINES.twin
          : HIT_LINES[event.weapon ?? 'unarmed'];
      return decorate(fill(pick(lines), a, b, event.damage));
    }
    case 'combo':
      return decorate(fill(pick(KIND_LINES.combo), a, b, event.damage));
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
                : KIND_LINES.skip,
        ),
        a,
      );
    case 'miss':
      return fill(pick(KIND_LINES.miss), a);
    case 'decoy':
      return fill(pick(KIND_LINES.decoy), a);
    case 'mirror':
      return fill(pick(KIND_LINES.mirror), a);
    case 'play-dead':
      return fill(pick(KIND_LINES['play-dead']), a);
    case 'skill':
      if (event.pierce) return decorate(fill(pick(FLAG_LINES.pierce), a, b, event.damage ?? 0));
      return decorate(fill(pick(SKILL_LINES[event.skill]), a, b, event.damage ?? 0, event.heal ?? 0));
    case 'strike':
      return decorate(fill(pick(KIND_LINES.strike), a, b, event.damage));
    case 'end':
      return fill(pick(END_LINES), a, b);
  }
}

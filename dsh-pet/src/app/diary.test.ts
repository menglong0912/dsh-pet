import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dateLabel, Diary, diaryDate, diaryInstruction, renderDiaryIndex } from './diary.ts';
import type { DiaryDay } from './diary.ts';
import type { ActivitySnapshot } from './activity.ts';

const MIN = 60_000;
/** 2026-10-23 是周五（Date 按本地时间构造） */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const present = (frontApp: string | null): ActivitySnapshot => ({
  present: true,
  frontApp,
  frontSince: 0,
  activeSince: 0,
  awaySince: null,
});
const away: ActivitySnapshot = { present: false, frontApp: null, frontSince: null, activeSince: null, awaySince: 0 };

/** 在临时目录里跑 fn，跑完删掉 */
function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pet-diary-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 从 from 起每分钟一拍、在电脑前用 app，共 minutes 分钟 */
function sit(diary: Diary, from: number, minutes: number, app = 'Ghostty'): void {
  for (let i = 0; i <= minutes; i += 1) diary.tick(from + i * MIN, present(app));
}

test('a diary day starts at 4 am and is labelled with the weekday', () => {
  assert.equal(diaryDate(at(24, 3, 59)), '2026-10-23');
  assert.equal(diaryDate(at(24, 4)), '2026-10-24');
  assert.equal(dateLabel('2026-10-23'), '10 月 23 日 星期五');
});

test('records present time per app, caps sleep gaps, persists events, and resumes after a restart', () => {
  withDir((dir) => {
    const diary = new Diary(dir, at(23, 9), () => undefined);
    diary.tick(at(23, 9), present('Ghostty'));
    diary.tick(at(23, 9, 1), present('Ghostty'));
    diary.tick(at(23, 11), present('Ghostty')); // 系统睡了两小时：只按 1 分钟算
    diary.tick(at(23, 11, 1), away); // 离开这一分钟不算
    diary.tick(at(23, 11, 2), present('Google Chrome'));
    diary.note(at(23, 11, 2), 'pomodoro', '主人专注完一个 25 分钟的番茄钟');

    const saved = JSON.parse(readFileSync(join(dir, '2026-10-23.json'), 'utf8')) as DiaryDay;
    assert.equal(saved.firstSeenAt, at(23, 9));
    assert.equal(saved.lastSeenAt, at(23, 11, 2));
    assert.equal(saved.presentMs, 3 * MIN);
    assert.deepEqual(saved.apps, { Ghostty: 2 * MIN, 'Google Chrome': MIN });
    assert.deepEqual(saved.events, [{ at: at(23, 11, 2), kind: 'pomodoro', text: '主人专注完一个 25 分钟的番茄钟' }]);
    // 在电脑前太短：不写
    assert.equal(diary.instruction('2026-10-23'), null);

    // 白天重启：接着今天的账记
    const again = new Diary(dir, at(23, 12), () => undefined);
    sit(again, at(23, 12), 10);
    assert.match(again.instruction('2026-10-23') ?? '', /一共在电脑前 13 分钟/);
  });
});

test('writes the diary page, and asks to rewrite a day whose diary was written before the day ended', () => {
  withDir((dir) => {
    const diary = new Diary(dir, at(23, 9), () => undefined);
    sit(diary, at(23, 9), 15);
    assert.equal(diary.hasIndex(), false);
    // 白天先写一篇「到目前为止」的
    diary.write('2026-10-23', '今天主人写了一天代码。\n\n<script>坏东西</script>', at(23, 18));
    const page = readFileSync(diary.indexPath(), 'utf8');
    assert.match(page, /10 月 23 日 星期五/);
    assert.match(page, /<p>今天主人写了一天代码。<\/p><p>&lt;script&gt;坏东西&lt;\/script&gt;<\/p>/);
    assert.match(page, /在电脑前 15 分钟/);

    // 凌晨 2 点仍算 23 号；过了 4 点换天，前一天要按完整的一天重写
    diary.tick(at(24, 2), present('Ghostty'));
    assert.equal(diary.pending(at(24, 2)), null);
    diary.tick(at(24, 9), present('Ghostty'));
    assert.equal(diary.pending(at(24, 9)), '2026-10-23');
    diary.write('2026-10-23', '完整的一天。', at(24, 9));
    assert.equal(diary.pending(at(24, 9)), null);
    // 24 号在电脑前太短：25 号不补写它
    sit(diary, at(24, 9), 2);
    assert.ok(existsSync(join(dir, '2026-10-24.json')));
    assert.equal(diary.pending(at(25, 9)), null);
  });
});

test('cultivate events are recorded and read back like any other day event', () => {
  withDir((dir) => {
    const diary = new Diary(dir, at(23, 9), () => undefined);
    sit(diary, at(23, 9), 10);
    diary.note(at(23, 10), 'cultivate', '修为精进，到了炼气二层');
    diary.note(at(23, 11), 'cultivate', '突破到筑基初期，领悟了水枪');
    const saved = JSON.parse(readFileSync(join(dir, '2026-10-23.json'), 'utf8')) as DiaryDay;
    assert.deepEqual(
      saved.events.filter((event) => event.kind === 'cultivate').map((event) => event.text),
      ['修为精进，到了炼气二层', '突破到筑基初期，领悟了水枪'],
    );
    // 写日记的指令里新事件也读得通
    assert.match(diary.instruction('2026-10-23') ?? '', /10:00 修为精进，到了炼气二层/);
  });
});

test('an unreadable day file is reported and that day starts over', () => {
  withDir((dir) => {
    writeFileSync(join(dir, '2026-10-23.json'), '{ broken');
    const warnings: string[] = [];
    const diary = new Diary(dir, at(23, 9), (m) => warnings.push(m));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /日记文件读不了/);
    sit(diary, at(23, 9), 1);
    assert.equal((JSON.parse(readFileSync(join(dir, '2026-10-23.json'), 'utf8')) as DiaryDay).presentMs, MIN);
  });
});

test('the instruction lists the top apps and all events, sampling screen quips down to ten', () => {
  const day: DiaryDay = {
    date: '2026-10-23',
    firstSeenAt: at(23, 9, 5),
    lastSeenAt: at(23, 19, 40),
    presentMs: 8 * 60 * MIN,
    apps: { Ghostty: 3 * 60 * MIN, 'Google Chrome': 2 * 60 * MIN, Finder: 30_000 },
    events: [
      { at: at(23, 10, 30), kind: 'pomodoro', text: '主人专注完一个 25 分钟的番茄钟' },
      ...Array.from({ length: 30 }, (_, i) => ({
        at: at(23, 11, i),
        kind: 'screen' as const,
        text: `看了一眼主人的屏幕，说：「第 ${i} 句」`,
      })),
      { at: at(23, 17, 20), kind: 'claude', text: '主人交给 Claude 的活（项目 dsh-pet）干完了' },
    ],
  };
  const text = diaryInstruction(day);
  assert.match(text, /10 月 23 日 星期五/);
  assert.match(text, /09:05 第一次坐到电脑前，最后一次在电脑前是 19:40，一共在电脑前 8 小时/);
  assert.match(text, /用得最多的应用：Ghostty（3 小时）、Google Chrome（2 小时）。/);
  assert.doesNotMatch(text, /Finder/); // 不到 1 分钟不算
  assert.match(text, /- 10:30 主人专注完一个 25 分钟的番茄钟/);
  assert.match(text, /- 17:20 主人交给 Claude 的活/);
  assert.equal(text.match(/看了一眼主人的屏幕/g)?.length, 10);
  assert.match(text, /第 0 句/);
  // 模型会自己猜主人的性别，还会「他」「你」混着用
  assert.match(text, /称呼主人只用「主人」或「你」，不用「他」「她」/);

  const page = renderDiaryIndex([
    { ...day, diary: { text: '二十三号。', writtenAt: at(24, 9) } },
    { ...day, date: '2026-10-24', diary: { text: '二十四号。', writtenAt: at(25, 9) } },
    { ...day, date: '2026-10-25' }, // 没写日记的不上页面
  ]);
  assert.ok(page.indexOf('二十四号') < page.indexOf('二十三号'));
  assert.doesNotMatch(page, /10 月 25 日/);
  assert.match(page, /在电脑前 8 小时 · 番茄钟 1 个 · Claude 干完 1 次活/);
});

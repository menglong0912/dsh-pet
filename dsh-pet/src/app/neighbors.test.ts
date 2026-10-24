import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NeighborBook,
  memoryLine,
  NEIGHBORS_MAX,
  notesAllowed,
  orderNeighbors,
  REVISIT_MS,
  shouldAutoAdmit,
} from './neighbors.ts';

function withPath(fn: (path: string, warns: string[]) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-neighbors-'));
  const path = join(dir, 'neighbors.json');
  const warns: string[] = [];
  try {
    fn(path, warns);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('met creates and updates records, and they survive a restart', () => {
  withPath((path) => {
    const book = new NeighborBook(path, () => undefined);
    book.met('a'.repeat(32), { owner: '小李', pet: '阿花' }, 'hosted', 1_000);
    book.met('a'.repeat(32), { owner: '小李', pet: '小花' }, 'visited', 2_000);
    const record = book.get('a'.repeat(32));
    assert.ok(record);
    assert.equal(record.pet, '小花'); // 每次见面更新成最新的名字
    assert.equal(record.hosted, 1);
    assert.equal(record.visited, 1);
    assert.equal(record.firstMet, 1_000);
    assert.equal(record.lastMet, 2_000);
    book.setSummary('a'.repeat(32), '聊了放风筝');
    // 重启后还在
    const again = new NeighborBook(path, () => undefined);
    assert.equal(again.get('a'.repeat(32))?.summary, '聊了放风筝');
    assert.ok(existsSync(path));
  });
});

test('list puts friends first, the rest by lastMet descending', () => {
  withPath((path) => {
    const book = new NeighborBook(path, () => undefined);
    book.met('a'.repeat(32), { owner: '早', pet: '一' }, 'hosted', 1_000);
    book.met('b'.repeat(32), { owner: '晚', pet: '二' }, 'hosted', 3_000);
    book.met('c'.repeat(32), { owner: '中', pet: '三' }, 'hosted', 2_000);
    book.setFriend('c'.repeat(32), true);
    assert.deepEqual(
      book.list().map((record) => record.owner),
      ['中', '晚', '早'],
    );
  });
});

test('over the cap it drops the least recently met non-friend, never a friend', () => {
  withPath((path) => {
    const book = new NeighborBook(path, () => undefined);
    for (let n = 0; n < NEIGHBORS_MAX; n += 1) {
      book.met(String(n).padStart(32, '0'), { owner: `邻${n}`, pet: '宠' }, 'hosted', n + 1);
    }
    book.setFriend(String(0).padStart(32, '0'), true); // 最久没见的，但是熟人
    book.met('f'.repeat(32), { owner: '新来的', pet: '宠' }, 'hosted', 9_999);
    const ids = book.list().map((record) => record.id);
    assert.equal(book.list().length, NEIGHBORS_MAX);
    assert.ok(ids.includes('f'.repeat(32)));
    assert.ok(ids.includes(String(0).padStart(32, '0')));
    assert.ok(!ids.includes(String(1).padStart(32, '0'))); // 丢的是最久没见的非熟人
  });
});

test('a broken file is renamed with a warning, and the book restarts empty', () => {
  withPath((path, warns) => {
    writeFileSync(path, '不是 JSON', 'utf8');
    const book = new NeighborBook(path, (message) => warns.push(message));
    assert.equal(book.list().length, 0);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /已改名/);
    const renamed = readdirSync(join(path, '..')).filter((name) => name.startsWith('neighbors.json.bad-'));
    assert.equal(renamed.length, 1);
    // 新记的存进新文件
    book.met('a'.repeat(32), { owner: '小李', pet: '阿花' }, 'hosted', 1_000);
    assert.ok(JSON.parse(readFileSync(path, 'utf8')).neighbors.length === 1);
  });
});

test('setSummary / setFriend / forget / clear only touch what is there', () => {
  withPath((path) => {
    const book = new NeighborBook(path, () => undefined);
    book.setSummary('a'.repeat(32), '没有这条记录');
    book.setFriend('a'.repeat(32), true);
    assert.equal(book.list().length, 0);
    book.met('a'.repeat(32), { owner: '小李', pet: '阿花' }, 'hosted', 1_000);
    book.setSummary('a'.repeat(32), '');
    assert.equal(book.get('a'.repeat(32))?.summary, ''); // 空摘要不记（保留旧的）
    book.forget('b'.repeat(32));
    assert.equal(book.list().length, 1);
    book.forget('a'.repeat(32));
    assert.equal(book.list().length, 0);
    book.met('a'.repeat(32), { owner: '小李', pet: '阿花' }, 'hosted', 1_000);
    book.clear();
    assert.equal(book.list().length, 0);
    assert.equal(new NeighborBook(path, () => undefined).list().length, 0);
  });
});

test('meet returns the memory from before this meeting, then records it', () => {
  withPath((path) => {
    const book = new NeighborBook(path, () => undefined);
    const id = 'a'.repeat(32);
    // 第一次见面：之前没记录，进门时读到的备忘是 null（不能是「见过 1 次」）
    assert.equal(book.meet(id, { owner: '小李', pet: '阿花' }, 'hosted', 1_000), null);
    book.setSummary(id, '聊了放风筝');
    // 第二次：读到的是上一次（次数 1、时间是两次 meet 的间隔），带着上次的摘要
    assert.equal(
      book.meet(id, { owner: '小李', pet: '阿花' }, 'hosted', 1_000 + 3_600_000),
      '你们之前见过 1 次，上次是 1 小时前，上次聊了：「聊了放风筝」。',
    );
    // 第三次：次数是 2（不含正在记的这次）
    book.setSummary(id, '又聊了扑克魔术');
    assert.equal(
      book.meet(id, { owner: '小李', pet: '阿花' }, 'visited', 1_000 + 2 * 3_600_000),
      '你们之前见过 2 次，上次是 1 小时前，上次聊了：「又聊了扑克魔术」。',
    );
  });
});

test('memoryLine describes the last meeting', () => {
  const base = {
    id: 'a'.repeat(32),
    owner: '小李',
    pet: '阿花',
    friend: false,
    hosted: 2,
    visited: 1,
    firstMet: 0,
    lastMet: 0,
    summary: '',
  };
  assert.equal(memoryLine(undefined, 0), null);
  assert.equal(memoryLine({ ...base, lastMet: 30_000 }, 60_000), '你们之前见过 3 次，上次是 不到 1 分钟前。');
  assert.equal(
    memoryLine({ ...base, lastMet: 3_600_000, summary: '聊了放风筝' }, 9_600_000),
    '你们之前见过 3 次，上次是 1 小时 40 分钟前，上次聊了：「聊了放风筝」。',
  );
  // 隔了几天按「N 天」说（durationText 只到小时）
  assert.equal(
    memoryLine({ ...base, lastMet: 0, summary: '聊了放风筝' }, 2 * 86_400_000),
    '你们之前见过 3 次，上次是 2 天前，上次聊了：「聊了放风筝」。',
  );
});

test('shouldAutoAdmit only fires for a verified friend with the switch on and the owner present', () => {
  withPath((path) => {
    const book = new NeighborBook(path, () => undefined);
    const id = 'a'.repeat(32);
    book.met(id, { owner: '小李', pet: '阿花' }, 'hosted', 1_000);
    const stranger: { owner: string; pet: string; id?: string } = { owner: '小李', pet: '阿花' };
    const verified = { ...stranger, id };
    // 三者缺一不可：没验证过身份的当陌生人，主人不在场 / 没开开关 / 不是熟人都不自动开门
    assert.equal(shouldAutoAdmit(book, stranger, true, true), false);
    assert.equal(shouldAutoAdmit(book, verified, false, true), false);
    assert.equal(shouldAutoAdmit(book, verified, true, false), false);
    assert.equal(shouldAutoAdmit(book, verified, true, undefined), false);
    assert.equal(shouldAutoAdmit(book, verified, true, true), false);
    book.setFriend(id, true);
    assert.equal(shouldAutoAdmit(book, verified, true, true), true);
  });
});

test('notesAllowed only fires for a verified friend with notes switched on', () => {
  withPath((path) => {
    const book = new NeighborBook(path, () => undefined);
    const id = 'a'.repeat(32);
    book.met(id, { owner: '小李', pet: '阿花' }, 'hosted', 1_000);
    // 三者缺一不可：没验证过身份（id 是空的）、不是熟人、关了「和熟人互相捎话」，一句都不收也不发
    assert.equal(notesAllowed(book, undefined, true, true), false);
    assert.equal(notesAllowed(book, id, false, true), false);
    assert.equal(notesAllowed(book, id, true, false), false);
    assert.equal(notesAllowed(book, id, true, true), false);
    book.setFriend(id, true);
    assert.equal(notesAllowed(book, id, true, true), true);
    // 没记过的 id 查不到记录，同样不行
    assert.equal(notesAllowed(book, 'b'.repeat(32), true, true), false);
  });
});

test('orderNeighbors puts friends first, then the met by lastMet, then strangers by nickname', () => {
  withPath((path) => {
    const book = new NeighborBook(path, () => undefined);
    book.met('a'.repeat(32), { owner: '早见', pet: '一' }, 'hosted', 1_000);
    book.met('b'.repeat(32), { owner: '晚见', pet: '二' }, 'hosted', 5_000);
    book.met('c'.repeat(32), { owner: '熟人见', pet: '三' }, 'hosted', 3_000);
    book.setFriend('c'.repeat(32), true);
    // 「生张」「生李」没见过面（不在邻居簿里）
    const neighbors = ['b'.repeat(32), 'd'.repeat(32), 'a'.repeat(32), 'e'.repeat(32), 'c'.repeat(32)].map((id, n) => ({
      id,
      owner: ['晚见', '生李', '早见', '生张', '熟人见'][n]!,
      pet: '宠',
    }));
    assert.deepEqual(
      orderNeighbors(neighbors, book, null, 10_000).list.map((neighbor) => neighbor.owner),
      ['熟人见', '晚见', '早见', '生张', '生李'],
    );
  });
});

test('orderNeighbors offers a revisit entry only within 2 hours, while the guest is still nearby and verified', () => {
  withPath((path) => {
    const book = new NeighborBook(path, () => undefined);
    const id = 'a'.repeat(32);
    book.met(id, { owner: '小李', pet: '阿花' }, 'hosted', 1_000);
    const neighbors = [
      { id, owner: '小李', pet: '阿花' },
      { id: 'b'.repeat(32), owner: '老王', pet: '旺财' }, // 没见过面的陌生邻居
    ];
    const leftAt = 10_000;
    // 走了还没到 2 小时：出回访项，列表里不再有它（同一家不出现两项）
    const within = orderNeighbors(neighbors, book, { id, at: leftAt }, leftAt + REVISIT_MS);
    assert.equal(within.revisit?.owner, '小李');
    assert.deepEqual(
      within.list.map((neighbor) => neighbor.owner),
      ['老王'],
    );
    // 过了 2 小时：不出回访项，它回到列表里
    const after = orderNeighbors(neighbors, book, { id, at: leftAt }, leftAt + REVISIT_MS + 1);
    assert.equal(after.revisit, null);
    assert.deepEqual(
      after.list.map((neighbor) => neighbor.owner),
      ['小李', '老王'],
    );
    // 客人不在邻居列表（信标没了）里：不出
    assert.equal(orderNeighbors([], book, { id, at: leftAt }, leftAt + 1).revisit, null);
    // 没验证过身份的客人压根不会记成 lastGuest（seeGuestOff 只记 visitor.id 有值的）：不出
    assert.equal(orderNeighbors(neighbors, book, null, leftAt + 1).revisit, null);
  });
});

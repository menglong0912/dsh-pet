import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppConfig, DEFAULT_APP_CONFIG, saveAppConfig } from './app-config.ts';

test('writes defaults when missing, reloads on change, keeps last good config on a broken file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  const path = join(dir, 'app-config.json');
  const warnings: string[] = [];
  try {
    const config = createAppConfig(path, (m) => warnings.push(m));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), DEFAULT_APP_CONFIG);
    assert.deepEqual(config(), DEFAULT_APP_CONFIG);

    const edited = { ...DEFAULT_APP_CONFIG, screen: { enabled: false, intervalSec: 1800 } };
    writeFileSync(path, JSON.stringify(edited));
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    assert.deepEqual(config().screen, { enabled: false, intervalSec: 1800 });

    writeFileSync(path, JSON.stringify({ ...edited, unknown: 1 }));
    utimesSync(path, new Date(), new Date(Date.now() + 2000));
    assert.deepEqual(config().screen, { enabled: false, intervalSec: 1800 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /应用配置无效/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings page saves the whole config, validates ranges, and the getter picks it up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  // 数据目录还不存在（首次启动）：createAppConfig 自己建
  const path = join(dir, 'dsh-pet', 'app-config.json');
  try {
    const config = createAppConfig(path, () => undefined);
    const edited = {
      ...DEFAULT_APP_CONFIG,
      screen: { enabled: false, intervalSec: 1800 },
      water: { enabled: false, everyMin: 90 },
    };
    assert.deepEqual(saveAppConfig(path, edited), edited);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), edited);
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    assert.deepEqual(config(), edited);

    // 越界 / 多余字段 / 缺字段：拒绝，文件不动
    const before = readFileSync(path, 'utf8');
    assert.throws(() => saveAppConfig(path, { ...edited, screen: { enabled: true, intervalSec: 9 } }));
    assert.throws(() => saveAppConfig(path, { ...edited, unknown: 1 }));
    assert.throws(() => saveAppConfig(path, { screen: edited.screen }));
    assert.throws(() => saveAppConfig(path, undefined));
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an older screen section with intervalMin still loads as seconds, without warnings or a whole-config fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  const path = join(dir, 'app-config.json');
  const warnings: string[] = [];
  try {
    const older: Record<string, unknown> = { ...DEFAULT_APP_CONFIG };
    older.screen = { enabled: false, intervalMin: 3 };
    writeFileSync(path, JSON.stringify(older));
    const config = createAppConfig(path, (m) => warnings.push(m));
    // 用户现在是 intervalMin: 3，读出来应是 180 秒
    assert.deepEqual(config().screen, { enabled: false, intervalSec: 180 });
    assert.deepEqual(warnings, []);
    // 保存只写 intervalSec，不再回写 intervalMin
    const saved = saveAppConfig(path, older);
    assert.deepEqual(saved.screen, { enabled: false, intervalSec: 180 });
    assert.equal('intervalMin' in JSON.parse(readFileSync(path, 'utf8')).screen, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('screen intervalSec accepts 10 seconds but rejects 9', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  const path = join(dir, 'app-config.json');
  try {
    const config = createAppConfig(path, () => undefined);
    // 默认仍是 15 分钟
    assert.deepEqual(DEFAULT_APP_CONFIG.screen, { enabled: true, intervalSec: 900 });
    assert.deepEqual(config().screen, { enabled: true, intervalSec: 900 });
    const ten = { ...DEFAULT_APP_CONFIG, screen: { enabled: true, intervalSec: 10 } };
    assert.deepEqual(saveAppConfig(path, ten).screen, { enabled: true, intervalSec: 10 });
    assert.throws(() => saveAppConfig(path, { ...DEFAULT_APP_CONFIG, screen: { enabled: true, intervalSec: 9 } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file from before the pomodoro was removed still loads with all its settings, and saving drops the old field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  const path = join(dir, 'app-config.json');
  const warnings: string[] = [];
  try {
    const visit = { ...DEFAULT_APP_CONFIG.visit, enabled: true, stayMin: 20 };
    const older = { ...DEFAULT_APP_CONFIG, visit, pomodoro: { focusMin: 50, breakMin: 10 } };
    writeFileSync(path, JSON.stringify(older));
    const config = createAppConfig(path, (m) => warnings.push(m));
    assert.deepEqual(config(), { ...DEFAULT_APP_CONFIG, visit });
    assert.deepEqual(warnings, []);
    // 还开着旧设置页的标签页保存时会带上它：照样能存，存下来的文件里没有它
    assert.deepEqual(saveAppConfig(path, older), { ...DEFAULT_APP_CONFIG, visit });
    assert.equal('pomodoro' in JSON.parse(readFileSync(path, 'utf8')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an older file without offWork / visit still loads, keeping its own values and filling the defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  const path = join(dir, 'app-config.json');
  const warnings: string[] = [];
  try {
    const older: Record<string, unknown> = { ...DEFAULT_APP_CONFIG, water: { enabled: false, everyMin: 90 } };
    delete older.offWork;
    delete older.visit;
    writeFileSync(path, JSON.stringify(older));
    const config = createAppConfig(path, (m) => warnings.push(m));
    assert.deepEqual(config().water, { enabled: false, everyMin: 90 });
    assert.deepEqual(config().offWork, DEFAULT_APP_CONFIG.offWork);
    // 串门默认关：升级后不会自己往局域网发信标
    assert.deepEqual(config().visit, {
      enabled: false,
      hosting: true,
      visiting: true,
      chat: true,
      nickname: '',
      stayMin: 10,
      autoAdmitFriends: false,
      notes: true,
      peers: [],
    });
    assert.deepEqual(warnings, []);
    const visit = { ...DEFAULT_APP_CONFIG.visit, enabled: true };
    assert.throws(() =>
      saveAppConfig(path, { ...older, visit: { ...visit, nickname: '一二三四五六七八九十十一十二' } }),
    );
    assert.throws(() => saveAppConfig(path, { ...older, visit: { ...visit, stayMin: 61 } }));
    assert.throws(() => saveAppConfig(path, { ...older, visit: { ...visit, hosting: 'yes' } }));
    assert.throws(() =>
      saveAppConfig(path, { ...older, offWork: { enabled: true, time: '25:00', weekdaysOnly: true, leadMin: 10 } }),
    );
    assert.throws(() =>
      saveAppConfig(path, { ...older, offWork: { enabled: true, time: '18:00', weekdaysOnly: true, leadMin: 121 } }),
    );
    // 已经有 offWork 但没有 leadMin（加提前提醒之前存过设置页）：只补 leadMin，自己设的时间不动
    writeFileSync(path, JSON.stringify({ ...older, offWork: { enabled: true, time: '17:30', weekdaysOnly: false } }));
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    assert.deepEqual(config().offWork, { enabled: true, time: '17:30', weekdaysOnly: false, leadMin: 10 });
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an older visit section without autoAdmitFriends still loads, filling the default (off)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  const path = join(dir, 'app-config.json');
  const warnings: string[] = [];
  try {
    const older = {
      ...DEFAULT_APP_CONFIG,
      visit: { enabled: true, hosting: true, visiting: true, chat: true, nickname: '小李', stayMin: 10 },
    };
    writeFileSync(path, JSON.stringify(older));
    const config = createAppConfig(path, (m) => warnings.push(m));
    // 只补 autoAdmitFriends，其余自己设的值不动；补的是 false，升级后不会自动给熟人开门
    assert.deepEqual(config().visit, { ...older.visit, autoAdmitFriends: false, notes: true, peers: [] });
    assert.deepEqual(warnings, []);
    assert.throws(() =>
      saveAppConfig(path, { ...DEFAULT_APP_CONFIG, visit: { ...older.visit, autoAdmitFriends: 'yes' } }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an older visit section without notes still loads, filling the default (on)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  const path = join(dir, 'app-config.json');
  const warnings: string[] = [];
  try {
    const older = {
      ...DEFAULT_APP_CONFIG,
      visit: {
        enabled: true,
        hosting: true,
        visiting: true,
        chat: true,
        nickname: '小李',
        stayMin: 10,
        autoAdmitFriends: false,
      },
    };
    delete (older.visit as Record<string, unknown>).notes;
    writeFileSync(path, JSON.stringify(older));
    const config = createAppConfig(path, (m) => warnings.push(m));
    // 只补 notes，其余自己设的值不动；补的是 true，升级后熟人间捎话默认开着
    assert.deepEqual(config().visit, { ...older.visit, notes: true, peers: [] });
    assert.deepEqual(warnings, []);
    assert.throws(() => saveAppConfig(path, { ...DEFAULT_APP_CONFIG, visit: { ...older.visit, notes: 'yes' } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an older file without cultivation still loads, filling the default (on)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  const path = join(dir, 'app-config.json');
  const warnings: string[] = [];
  try {
    const older: Record<string, unknown> = { ...DEFAULT_APP_CONFIG };
    delete older.cultivation;
    writeFileSync(path, JSON.stringify(older));
    const config = createAppConfig(path, (m) => warnings.push(m));
    // 修炼默认开：升级后照常涨修为
    assert.deepEqual(config().cultivation, { enabled: true, speed: 1 });
    assert.deepEqual(warnings, []);
    assert.throws(() => saveAppConfig(path, { ...DEFAULT_APP_CONFIG, cultivation: { enabled: 'yes' } }));
    // 倍速只收设置页里那几档
    assert.throws(() => saveAppConfig(path, { ...DEFAULT_APP_CONFIG, cultivation: { enabled: true, speed: 3 } }));
    assert.equal(
      saveAppConfig(path, { ...DEFAULT_APP_CONFIG, cultivation: { enabled: true, speed: 10 } }).cultivation.speed,
      10,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an older visit section without peers still loads (empty), and bad peer addresses are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  const path = join(dir, 'app-config.json');
  const warnings: string[] = [];
  try {
    const older = {
      ...DEFAULT_APP_CONFIG,
      visit: {
        enabled: true,
        hosting: true,
        visiting: true,
        chat: true,
        nickname: '小李',
        stayMin: 10,
        autoAdmitFriends: false,
        notes: true,
      },
    };
    writeFileSync(path, JSON.stringify(older));
    const config = createAppConfig(path, (m) => warnings.push(m));
    // 缺 peers：只补空数组，其余自己设的值不动
    assert.deepEqual(config().visit, { ...older.visit, peers: [] });
    assert.deepEqual(warnings, []);
    // 合格的手动邻居照常保存
    const peers = ['192.168.11.23', '10.0.0.2', '100.64.0.9'];
    assert.deepEqual(
      saveAppConfig(path, { ...DEFAULT_APP_CONFIG, visit: { ...older.visit, peers } }).visit.peers,
      peers,
    );
    // 公网 / 格式不对 / 超过 20 项：整份拒绝
    for (const bad of [
      ['8.8.8.8'],
      ['192.168.1'],
      ['192.168.1.256'],
      [' 192.168.1.2'],
      ['::1'],
      ['localhost'],
      Array.from({ length: 21 }, (_, index) => `192.168.1.${index + 1}`),
    ]) {
      assert.throws(
        () => saveAppConfig(path, { ...DEFAULT_APP_CONFIG, visit: { ...older.visit, peers: bad } }),
        Error,
        JSON.stringify(bad),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

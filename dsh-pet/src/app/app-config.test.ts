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

    const edited = { ...DEFAULT_APP_CONFIG, screen: { enabled: false, intervalMin: 30 } };
    writeFileSync(path, JSON.stringify(edited));
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    assert.deepEqual(config().screen, { enabled: false, intervalMin: 30 });

    writeFileSync(path, JSON.stringify({ ...edited, unknown: 1 }));
    utimesSync(path, new Date(), new Date(Date.now() + 2000));
    assert.deepEqual(config().screen, { enabled: false, intervalMin: 30 });
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
      screen: { enabled: false, intervalMin: 30 },
      pomodoro: { focusMin: 50, breakMin: 10 },
      water: { enabled: false, everyMin: 90 },
    };
    assert.deepEqual(saveAppConfig(path, edited), edited);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), edited);
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    assert.deepEqual(config(), edited);

    // 越界 / 多余字段 / 缺字段：拒绝，文件不动
    const before = readFileSync(path, 'utf8');
    assert.throws(() => saveAppConfig(path, { ...edited, screen: { enabled: true, intervalMin: 1 } }));
    assert.throws(() => saveAppConfig(path, { ...edited, unknown: 1 }));
    assert.throws(() => saveAppConfig(path, { screen: edited.screen }));
    assert.throws(() => saveAppConfig(path, undefined));
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an older file without offWork still loads, keeping its own values and filling the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-app-config-'));
  const path = join(dir, 'app-config.json');
  const warnings: string[] = [];
  try {
    const older: Record<string, unknown> = { ...DEFAULT_APP_CONFIG, water: { enabled: false, everyMin: 90 } };
    delete older.offWork;
    writeFileSync(path, JSON.stringify(older));
    const config = createAppConfig(path, (m) => warnings.push(m));
    assert.deepEqual(config().water, { enabled: false, everyMin: 90 });
    assert.deepEqual(config().offWork, DEFAULT_APP_CONFIG.offWork);
    assert.deepEqual(warnings, []);
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

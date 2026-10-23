import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppConfig, DEFAULT_APP_CONFIG } from './app-config.ts';

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

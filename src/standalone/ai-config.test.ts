import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiConfig, validateSettings, DEFAULT_AI_SETTINGS } from './ai-config.ts';

const configured = {
  protocol: 'openai-compatible',
  baseUrl: 'https://example.test/v1',
  model: 'chosen-model',
  apiKey: 'test-secret',
  enabled: true,
};

test('validates safe endpoints and explicit configuration with fixed redacted errors', () => {
  for (const baseUrl of [
    'ftp://example.test',
    'https://u:p@example.test',
    'https://example.test/?key=secret',
    'https://example.test/#secret',
    'javascript:alert(1)',
    'https://example.test\\v1',
  ]) {
    assert.throws(
      () => validateSettings({ ...configured, baseUrl }, DEFAULT_AI_SETTINGS),
      /^Error: Invalid standalone AI settings\.$/,
    );
  }
  for (const baseUrl of [
    'http://192.168.1.100:8000/v1',
    'http://localhost:1234/v1',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
    'https://example.test/v1',
  ]) {
    assert.equal(validateSettings({ ...configured, baseUrl }, DEFAULT_AI_SETTINGS).baseUrl, baseUrl);
  }
  for (const patch of [
    { model: '' },
    { timeoutMs: 60001 },
    { hasKey: true },
    { enabled: 'true' },
    { apiKey: 'bad\nkey' },
  ]) {
    assert.throws(
      () => validateSettings({ ...configured, ...patch }, DEFAULT_AI_SETTINGS),
      /Invalid standalone AI settings/,
    );
  }
});

test('persists only in isolated home, redacts keys, supports keep and clear, reloads offline', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-'));
  try {
    const store = createAiConfig(home);
    assert.equal(store.publicSettings().hasKey, false);
    const saved = await store.save(configured);
    assert.equal(saved.hasKey, true);
    assert.equal('apiKey' in saved, false);
    assert.equal('maxTokens' in saved, false);
    assert.equal('automaticWhispers' in saved, false);
    assert.equal('whisperIntervalSec' in saved, false);
    assert.equal((await store.save({ apiKey: '' })).hasKey, true);
    assert.equal(createAiConfig(home).publicSettings().model, 'chosen-model');
    assert.match(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'), /test-secret/);
    assert.equal((await store.save({ clearApiKey: true, enabled: false })).hasKey, false);
    assert.equal(createAiConfig(home).publicSettings().enabled, false);
    writeFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), '{broken');
    assert.throws(() => createAiConfig(home), /^Error: Cannot securely load standalone AI settings\.$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy automaticWhispers / whisperIntervalSec / maxTokens load silently and are not written back', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-'));
  try {
    createAiConfig(home); // 建好 dsh-pet 目录
    const legacy = {
      ...DEFAULT_AI_SETTINGS,
      ...configured,
      automaticWhispers: true,
      whisperIntervalSec: 45,
      maxTokens: 100000,
    };
    writeFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), JSON.stringify(legacy));
    const store = createAiConfig(home);
    const publicSettings = store.publicSettings();
    assert.equal('automaticWhispers' in publicSettings, false);
    assert.equal('whisperIntervalSec' in publicSettings, false);
    assert.equal('maxTokens' in publicSettings, false);
    assert.equal(publicSettings.model, 'chosen-model');
    await store.save({ enabled: false });
    const persisted = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal('automaticWhispers' in persisted, false);
    assert.equal('whisperIntervalSec' in persisted, false);
    assert.equal('maxTokens' in persisted, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('disableThinking defaults to false for old files and survives patches that omit it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-'));
  try {
    const legacy = { ...DEFAULT_AI_SETTINGS, ...configured } as Record<string, unknown>;
    delete legacy.disableThinking;
    createAiConfig(home); // 建好 dsh-pet 目录
    writeFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), JSON.stringify(legacy));
    const store = createAiConfig(home);
    assert.equal(store.publicSettings().disableThinking, false);
    assert.equal((await store.save({ disableThinking: true })).disableThinking, true);
    assert.equal((await store.save({ model: 'other-model' })).disableThinking, true);
    assert.equal(createAiConfig(home).publicSettings().disableThinking, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * 成品 → 渲染列表的契约测试：条目级字段只有**一处**填充点（flattenConfigPets）。
 *
 * 背景：animations / animationWeights / eventsRefreshSec / physics / confineToScreen / workStatusTexts /
 * whisperModel / chatModel 这八个条目级字段
 * 必须由 flattenConfigPets 从「条目」吹进每只实例。曾经设置页保存后把可编辑的裸实例列表回推给容器时
 * "补吹"一遍——它漏掉了 physics：新增宠物或同步后该实例的 physics 是 undefined，拖拽跟手第一帧读
 * cfg.physics.throwPower 直接抛错（表现为宠物完全拖不动）。现在写入方只回成品聚合，由调用方重新拍平。
 * 本文件把这条不变式钉住：
 *   ① 成品经 flattenConfigPets 后，每只实例的条目级字段齐全（可执行的契约，用真实内置默认配置）；
 *   ② host 写接口必须返回成品聚合（源码级守卫：调用方拿写接口的响应直接拍平，不再补一次 GET）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { flattenConfigPets } from './config.ts';
import { readAllConfig } from '../host/config.ts';
import type { Pet } from './types.ts';

/** 条目级字段清单：渲染端直接消费，缺一不可 */
const ENTRY_FIELDS: Array<keyof Pet> = [
  'animations',
  'animationWeights',
  'eventsRefreshSec',
  'physics',
  'confineToScreen',
  'workStatusTexts',
  'whisperModel',
  'chatModel',
];

/** 包内文件源码（守卫用；相对 src/shared/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('flattenConfigPets —— 成品 → 渲染列表的唯一填充点', () => {
  test('真实内置默认配置：每只实例的条目级字段齐全（含 physics.throwPower）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-flatten-'));
    try {
      const merged = readAllConfig({
        defaultFile: fileURLToPath(new URL('../../assets/config.jsonc', import.meta.url)),
        userFile: join(dir, 'main-config.jsonc'), // 不存在：只测内置默认
        petDir: join(dir, 'pet'), // 不存在：不掺文件宠物
      });
      const pets = flattenConfigPets(merged);
      assert.ok(pets.length > 0, '内置默认配置应至少有一只宠物');
      for (const p of pets) {
        for (const field of ENTRY_FIELDS) {
          assert.ok(p[field] !== undefined, `宠物「${String(p.id)}」缺条目级字段 ${field}`);
        }
        // 拖拽跟手第一帧读的就是它；缺失即 TypeError（本文件存在的直接原因）
        const physics = p.physics as { throwPower?: unknown };
        assert.equal(typeof physics.throwPower, 'number', 'physics.throwPower 必须是数字');
        // animations 是 { idle/turn/drag/clicks/moves/categories/events } 段：待机池必须非空
        const animations = p.animations as { idle?: unknown };
        assert.ok(Array.isArray(animations.idle) && animations.idle.length > 0, 'animations.idle 应为非空待机动画池');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('条目级字段的来源是「条目」而非实例：实例写同名值也不生效（唯一来源 = conf）', () => {
    const merged = {
      main: {
        physics: { throwPower: 7 },
        animations: ['a.webm'],
        pets: [{ id: 'x', physics: { throwPower: 1 } }],
      },
    };
    const [pet] = flattenConfigPets(merged as Record<string, Record<string, unknown>>);
    assert.deepEqual(pet.physics, { throwPower: 7 });
    assert.deepEqual(pet.animations, ['a.webm']);
  });

  test('实例级人设 whisperPrompt：原样带出，不参与条目级覆盖（回落由 host 消费端做）', () => {
    const merged = {
      main: {
        whisperPrompt: '条目人设',
        pets: [{ id: 'x', whisperPrompt: '实例人设' }, { id: 'y' }],
      },
    };
    const [a, b] = flattenConfigPets(merged as Record<string, Record<string, unknown>>);
    // 条目级字段是"实例写了也以 conf 为准"，人设是反例：实例那份必须留下来（它是覆盖）
    assert.equal(a.whisperPrompt, '实例人设');
    assert.equal('whisperPrompt' in b, false, '没写就是没写——回落由 host 的 petPersona 做，这里不填生效值');
  });

  test('源码守卫：host 的写接口返回成品聚合，保存用与读取侧同一套校验', () => {
    const host = readSource('../host/index.ts');

    // ③ host 的 GET / PUT / POST /config 都返回成品聚合——调用方拿写接口的
    //    响应直接拍平，不自己拼字段，也不再补一次 GET（补拉的那一次可能拿到陈旧配置）
    const returns = host.match(/obj: readAllConfig\(configPaths\)/g) ?? [];
    assert.equal(returns.length, 3, 'GET / PUT / POST /config 都应返回成品聚合');
    // 只扫 /config 那一段：动作端点（POST /whisper 等）返回 { ok: true } 是**对的**（动作不带数据，
    // 数据只有 /state 一个出口），全文件扫描会把它们误判成"config 写接口返回了 ok:true"。
    const configBlock = /if \(rest === 'config'\) \{([\s\S]*?)\n {4}\}/.exec(host)?.[1] ?? '';
    assert.ok(configBlock.length > 0, '必须能定位到 /config 路由段（守卫失效即无意义）');
    assert.ok(
      !/obj: \{ ok: true \}/.test(configBlock),
      'config 写接口不得再返回 { ok: true }：响应体必须是成品聚合（设置页即时生效靠它拍平）',
    );
    // ④ 保存的「透传保留」必须用 JSONC 容忍解析器读用户层：用户层可能是「同步」写入的
    //    **带 // 注释的 config.jsonc 原文**，严格 JSON.parse 会抛错并被 catch 吞掉 →
    //    existing 变 undefined → 白名单重建 → 用户手改的高级字段（animations/physics/memes…）
    //    全部丢失。这是曾经修过、又被「同步」带回来的回归，必须钉住。
    assert.ok(/readUserConfig\(configPaths\)/.test(host), 'PUT /config 必须用 readUserConfig 读用户层（JSONC 容忍）');
    assert.ok(
      !/JSON\.parse\(await readFile\(userConfigPath/.test(host),
      '不得用严格 JSON.parse 读用户层：带注释的配置会解析失败，保存时静默丢掉全部高级字段',
    );
    // ⑤ 保存前必须有损坏预检：用户层解析不了时**先不写盘**，回 409 让设置页弹窗
    //    （取消 = 不动文件 / 确认 = 强行重建）。没有它就会出现"损坏 → 静默白名单重建 → 配置全丢"。
    assert.ok(
      /userConfigUnparsable\(configPaths\)/.test(host),
      'PUT /config 必须先做损坏预检（userConfigUnparsable），损坏时回 409 而不是静默重建',
    );
    // ⑥ 物理参数（设置页「物理」区）必须真的提交：physics 原先**不在白名单**里（只在 existing 里
    //    透传），前端就算把输入框画出来、改了值，写盘时也会被丢弃。宿主必须用同一份
    //    physicsValid 整段校验它。
    assert.ok(
      /physicsValid\(ph\)/.test(readSource('../host/config.ts')),
      'saveUserConfig 必须用 physicsValid 校验 physics（与读取侧同一套规则）',
    );
    // ⑦ 模型选择（设置页「AI 模型」两个下拉框）必须真的提交：whisperModel / chatModel 若不在白名单里，
    //    前端选了也写不进用户层（只会被 existing 的透传值盖回去）。宿主必须用同一份
    //    modelSelectionValid 整段校验。
    const hostConfig = readSource('../host/config.ts');
    assert.ok(
      /modelSelectionValid\(wm\)/.test(hostConfig) && /modelSelectionValid\(cm\)/.test(hostConfig),
      'saveUserConfig 必须用 modelSelectionValid 校验 whisperModel / chatModel（与读取侧同一套规则）',
    );
    // 下拉框的数据源必须与 DSH 的模型选择器同源：走宿主 llm 服务（listProviders / listModels），
    // 不得另立一份手写的服务商清单——那会随 DSH 支持的服务商漂移。
    assert.ok(
      /listProviders/.test(host) && /listModels/.test(host),
      'GET /models 必须取宿主 llm 服务的 listProviders / listModels（与 DSH 模型选择器同源）',
    );
  });
});

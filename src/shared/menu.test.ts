import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAppMenuNodes } from './menu.ts';

const app = (label: string) => ({ owner: 'dsh-pet-app', label });

test('app menu items with a "group/" prefix become one root submenu that still reports the full label', () => {
  assert.deepEqual(
    buildAppMenuNodes([
      app('看看我在干嘛'),
      app('串门/去 小王 家'),
      app('宠物日记'),
      app('串门/去 小李 家'),
      app('/开头的斜杠'),
    ]),
    [
      { label: '看看我在干嘛', action: 'third-party', owner: 'dsh-pet-app' },
      {
        label: '串门',
        children: [
          { label: '去 小王 家', action: 'third-party', owner: 'dsh-pet-app', reportLabel: '串门/去 小王 家' },
          { label: '去 小李 家', action: 'third-party', owner: 'dsh-pet-app', reportLabel: '串门/去 小李 家' },
        ],
      },
      { label: '宠物日记', action: 'third-party', owner: 'dsh-pet-app' },
      { label: '/开头的斜杠', action: 'third-party', owner: 'dsh-pet-app' },
    ],
  );
  assert.deepEqual(buildAppMenuNodes([]), []);
});

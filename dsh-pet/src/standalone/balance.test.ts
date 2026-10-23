import { test } from 'node:test';
import assert from 'node:assert/strict';

import { queryBalance } from '../host/balance/index.ts';
import { balanceBubbleView, balancePercent, toBalanceState } from '../shared/balance/index.ts';
import { registerStandaloneBalance } from './balance.ts';
import { STANDALONE_PROVIDER } from './context.ts';

const noKey = async (): Promise<undefined> => undefined;

test('standalone balance is a random ¥1–¥100,000,000 that drives the bubble and tier animation', async () => {
  const draws = [0, 0.5, 0.999_999_999_9];
  const unregister = registerStandaloneBalance(() => draws.shift() ?? 0);
  try {
    const shown: string[] = [];
    const percents: Array<number | undefined> = [];
    for (let i = 0; i < 3; i += 1) {
      const state = toBalanceState(await queryBalance(STANDALONE_PROVIDER, noKey));
      assert.ok(state?.ok);
      shown.push(
        balanceBubbleView(state)
          .map((row) => row.text)
          .join(''),
      );
      percents.push(balancePercent(state));
    }
    assert.deepEqual(shown, ['余额 ¥1', '余额 ¥50000001', '余额 ¥100000000']);
    assert.deepEqual(
      percents.map((p) => Math.round(p ?? -1)),
      [100, 50, 0],
    );
  } finally {
    unregister();
  }
  // 注销后回到「不支持」
  assert.equal((await queryBalance(STANDALONE_PROVIDER, noKey)).ok, false);
});

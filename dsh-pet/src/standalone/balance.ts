/**
 * 独立模式的余额：没有 DSH 也就没有计费账户可查，当前服务商恒为 `standalone`（见 ./context 的
 * STANDALONE_PROVIDER）。给它登记一个第三方余额 provider：每次查询随机报 ¥1 – ¥1 亿（整数元），
 * 按 1 亿满额折算档位，余额动画跟着随机出来的档位走。
 *
 * 必须赶在 `apply()` 之前登记：插件在 apply 里就会发起启动时的第一次余额查询。
 */
import { registerBalanceProvider } from '../host/balance/index';
import { STANDALONE_PROVIDER } from './context';

/** 随机余额的上限（元），同时是档位基准：1 亿 = 未消耗 */
const MAX_YUAN = 100_000_000;

/**
 * 给独立模式的服务商登记随机余额。
 * @param random 返回 [0, 1) 的随机源（测试注入）
 * @returns 注销函数
 */
export function registerStandaloneBalance(random: () => number = Math.random): () => void {
  return registerBalanceProvider({
    id: STANDALONE_PROVIDER,
    async fetch({ provider }) {
      const total = String(1 + Math.floor(random() * MAX_YUAN));
      return {
        ok: true,
        provider,
        shape: 'money',
        data: { wallets: [{ currency: 'CNY', total, granted: '0', toppedUp: total, fullBalance: String(MAX_YUAN) }] },
      };
    },
  });
}

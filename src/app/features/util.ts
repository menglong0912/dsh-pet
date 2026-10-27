/** 拆开后的 features 各块共用的小工具 */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

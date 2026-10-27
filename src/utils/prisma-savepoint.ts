import { Prisma } from 'src/generated/prisma';

const SAVEPOINT_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * 在交互式事务里跑一个「失败只回滚自己」的步骤。
 *
 * Postgres 事务里任何一条语句报错,整个事务就进入 aborted 状态:后面的语句全被拒,
 * 最后的 COMMIT 也只会悄悄变成 ROLLBACK(不报错)。所以「尽力而为、失败吞掉继续」的
 * 步骤一旦挪进事务,就必须用保存点隔离 —— 只 catch 不回滚到保存点,调用方以为提交了,
 * 其实整个事务都白做了。
 *
 * - 成功时不 RELEASE:保存点在 COMMIT 时一并释放,省一次往返;
 * - 失败时回滚到保存点,再把原错误抛给调用方决定吞不吞;回滚本身失败(连接断了)
 *   就抛回滚的错 —— 事务已经不可用,不能再当成功继续;
 * - name 拼进 SQL,只能是代码里的常量标识符,绝不能来自输入。
 */
export async function withSavepoint<T>(
  tx: Prisma.TransactionClient,
  name: string,
  step: () => Promise<T>,
): Promise<T> {
  if (!SAVEPOINT_NAME.test(name)) {
    throw new Error(`invalid savepoint name: ${name}`);
  }
  await tx.$executeRaw(Prisma.raw(`SAVEPOINT ${name}`));
  try {
    return await step();
  } catch (error) {
    await tx.$executeRaw(Prisma.raw(`ROLLBACK TO SAVEPOINT ${name}`));
    throw error;
  }
}

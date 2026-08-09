import { readFileSync } from 'fs';
import { join } from 'path';

const read = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), 'utf8');

/**
 * 存量回收的契约。
 *
 * 背景：后端没有任何一处删除 MinIO 对象（全仓没有 DeleteObject / removeObject），
 * 所以删笔记、换头像、注销账号都不释放一个字节。唯一无界的写入源是笔记导出 ——
 * 它每次调用都落一个新对象，而 MinIO 与 Postgres 同机：磁盘写满时倒下的是数据库。
 *
 * 两道防线，缺一不可，所以两条都断言：
 * 1) 生命周期规则：不依赖应用代码正确性的兜底回收。
 * 2) 内容寻址的 key：同样的内容重复导出复用同一个对象，而不是每次占新空间。
 */
describe('MinIO storage reclamation', () => {
  it('installs a lifecycle rule for the one unbounded prefix', () => {
    const compose = read('docker-compose.prod.yml');

    expect(compose).toContain('mc ilm rule add');
    expect(compose).toContain("--prefix 'note-exports/'");
    // 规则失败不能连带把建桶也弄挂 —— 桶没了才是真的起不来。
    expect(compose).toMatch(/mc ilm rule add[\s\S]{0,200}?\|\|/);
  });

  it('keys note exports by content, not by a fresh uuid per call', () => {
    const source = read('src/note/note.service.ts');
    const keyLine = /const key = `note-exports\/[^`]*`/.exec(source)?.[0] ?? '';

    expect(keyLine).not.toBe('');
    // randomUUID 会让每次调用都新建一个永久对象：循环调用 = 无界增长。
    expect(keyLine).not.toContain('randomUUID');
    expect(keyLine).toContain('contentHash');
    // 哈希必须覆盖正文，否则内容变了 key 不变，会返回上一次的导出。
    expect(source).toMatch(
      /createHash\('sha256'\)[\s\S]{0,200}?update\(input\.body\)/,
    );
  });

  it('still has no object-delete path, so the lifecycle rule is load-bearing', () => {
    // 这条是提醒而非禁令：哪天真的实现了 GC，把这里一并更新，
    // 免得「以为有 GC 了」而把生命周期规则删掉。
    const uploadService = read('src/upload/upload.service.ts');
    expect(uploadService).not.toContain('DeleteObjectCommand');
  });
});

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
    expect(compose).toContain(
      "echo 'WARN: could not install note-exports lifecycle rule'",
    );
    // minio-init 是一次性服务,而发版不碰数据面:存量环境升级后根本执行不到它。
    // 所以必须可重复执行(先查后加,直接 add 会叠规则),并在装完自检。
    expect(compose).toMatch(
      /mc ilm rule ls local\/circle .*\| grep -q 'note-exports\/'/,
    );
    expect(compose).toContain('note-exports lifecycle rule is NOT active');
  });

  it('keys note exports by stable content identity, not by volatile bytes', () => {
    const source = read('src/note/note.service.ts');
    const keyLine = /const key = `note-exports\/[^`]*`/.exec(source)?.[0] ?? '';

    expect(keyLine).not.toBe('');
    // randomUUID 会让每次调用都新建一个永久对象：循环调用 = 无界增长。
    expect(keyLine).not.toContain('randomUUID');
    expect(keyLine).toContain('contentHash');
    // 哈希必须取自稳定量。曾经拿 input.body 算 —— 但带媒体的笔记在导出前会现签
    // 一批预签名 URL 并嵌进 SVG/PDF,签名每次都不同,于是同一篇没改过的笔记每次
    // 导出 key 都变,复用彻底失效、每次照样多留一个永久对象。
    expect(source).toMatch(
      /createHash\('sha256'\)[\s\S]{0,200}?update\(input\.contentFingerprint\)/,
    );
    expect(source).not.toMatch(
      /createHash\('sha256'\)[\s\S]{0,200}?update\(input\.body\)/,
    );
    // 指纹本身必须由笔记修订 + 媒体对象 key 派生,不能回头去碰 body。
    expect(source).toMatch(/private exportFingerprint\(/);
  });

  it('has a narrow object-delete path; the lifecycle rule still reclaims orphans', () => {
    // 2026-08-09 起有了第一条删除路径:消息撤回(G-02)按 key 删聊天媒体
    // (deleteObjectByKey,ChatMediaService 收口且只认 chat/ 前缀)。
    // 它只覆盖"被撤回的消息"——presign 后未发送、发送后行被清理等孤儿
    // 仍然只有生命周期规则兜底,所以那条规则依旧是 load-bearing,别删。
    const uploadService = read('src/upload/upload.service.ts');
    expect(uploadService).toContain('DeleteObjectCommand');
    expect(uploadService).toMatch(/deleteObjectByKey/);
  });
});

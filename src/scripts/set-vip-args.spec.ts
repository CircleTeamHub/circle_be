// #99：set-vip 参数解析测试。逻辑在 scripts/set-vip-args.cjs（零依赖 CJS），
// 这里相对 require —— jest rootDir=src，spec 落在 src/ 下才会被 npm test 跑到。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require('../../scripts/set-vip-args.cjs') as {
  parseArgs: (argv: string[]) => {
    id?: string;
    nickname?: string;
    level: number;
  };
};

describe('set-vip parseArgs (#99)', () => {
  it('parses --id with a level', () => {
    expect(parseArgs(['--id', 'u1', '3'])).toEqual({
      id: 'u1',
      nickname: undefined,
      level: 3,
    });
  });

  it('parses --nickname with a level', () => {
    expect(parseArgs(['--nickname', '小明', '0'])).toEqual({
      id: undefined,
      nickname: '小明',
      level: 0,
    });
  });

  it('rejects both or neither selector', () => {
    expect(() => parseArgs(['--id', 'u1', '--nickname', 'n', '1'])).toThrow(
      /Usage/,
    );
    expect(() => parseArgs(['2'])).toThrow(/Usage/);
  });

  it('rejects out-of-range and non-integer levels', () => {
    expect(() => parseArgs(['--id', 'u1', '6'])).toThrow(/between 0 and 5/);
    expect(() => parseArgs(['--id', 'u1', '-1'])).toThrow(/between 0 and 5/);
    expect(() => parseArgs(['--id', 'u1', '2.5'])).toThrow(/between 0 and 5/);
    expect(() => parseArgs(['--id', 'u1', 'gold'])).toThrow(/between 0 and 5/);
  });

  it('rejects trailing extra arguments', () => {
    expect(() => parseArgs(['--id', 'u1', '1', 'extra'])).toThrow(/Usage/);
  });
});

import {
  buildSensitiveWordMatcher,
  normalizeSensitiveWord,
} from './sensitive-word.matcher';

describe('normalizeSensitiveWord', () => {
  it('小写化 + NFKC 全角转半角', () => {
    expect(normalizeSensitiveWord('ＡＢＣ')).toBe('abc');
    expect(normalizeSensitiveWord('Ｆｕｃｋ')).toBe('fuck');
  });

  it('去除零宽字符', () => {
    expect(normalizeSensitiveWord('敏​感‌词﻿')).toBe('敏感词');
  });

  it('首尾空白裁剪，内部空白保留', () => {
    expect(normalizeSensitiveWord('  代 开发票  ')).toBe('代 开发票');
  });
});

describe('buildSensitiveWordMatcher', () => {
  const matcher = buildSensitiveWordMatcher(['赌博', '代开发票', 'casino']);

  it('空词表永不命中', () => {
    const empty = buildSensitiveWordMatcher([]);
    expect(empty.findFirst('随便什么内容')).toBeNull();
  });

  it('未命中返回 null', () => {
    expect(matcher.findFirst('今晚一起吃饭吗')).toBeNull();
  });

  it('命中返回词条本身', () => {
    expect(matcher.findFirst('这里可以赌博吗')).toBe('赌博');
  });

  it('命中句中英文词（大小写不敏感）', () => {
    expect(matcher.findFirst('welcome to my CASINO tonight')).toBe('casino');
  });

  it('全角变体命中', () => {
    expect(matcher.findFirst('ｃａｓｉｎｏ 了解一下')).toBe('casino');
  });

  it('词条内穿插空白/标点也命中（防拆字规避）', () => {
    expect(matcher.findFirst('赌 博')).toBe('赌博');
    expect(matcher.findFirst('代.开.发.票')).toBe('代开发票');
    expect(matcher.findFirst('赌​博')).toBe('赌博');
  });

  it('多词时返回文本中最先出现的命中', () => {
    const m = buildSensitiveWordMatcher(['bbb', 'aaa']);
    expect(m.findFirst('xx aaa yy bbb')).toBe('aaa');
  });

  it('前缀词与长词共存时均可命中', () => {
    const m = buildSensitiveWordMatcher(['毒', '毒品交易']);
    expect(m.findFirst('别碰毒品交易')).toBe('毒');
    const longOnly = buildSensitiveWordMatcher(['毒品交易']);
    expect(longOnly.findFirst('别碰毒品交易')).toBe('毒品交易');
    expect(longOnly.findFirst('毒品')).toBeNull();
  });

  it('构建时词条去重且忽略空词', () => {
    const m = buildSensitiveWordMatcher(['', '  ', '赌博', '赌博']);
    expect(m.size).toBe(1);
    expect(m.findFirst('赌博')).toBe('赌博');
  });
});

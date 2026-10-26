import {
  JS_WHITESPACE_CHARS,
  NOTE_SUMMARY_CONTENT_HEAD,
  noteSummaryProjectionQuery,
} from './note-summary.query';

describe('noteSummaryProjectionQuery', () => {
  it('passes exactly the characters String.prototype.trim removes to btrim', () => {
    // hasText 在 SQL 里用 btrim(分区正文, JS_WHITESPACE_CHARS) 判断，必须与
    // Boolean(content.trim()) 同一组字符：逐个 BMP 码点对一遍（JS 的空白全在 BMP 里）。
    const expected: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCharCode(code);
      if (char.trim() === '') expected.push(char);
    }
    expect([...JS_WHITESPACE_CHARS].sort()).toEqual(expected.sort());
  });

  it('binds the page ids, the head length and the whitespace set as parameters', () => {
    const query = noteSummaryProjectionQuery(['n1', 'n2']);
    expect(query.values).toEqual([
      NOTE_SUMMARY_CONTENT_HEAD,
      JS_WHITESPACE_CHARS,
      ['n1', 'n2'],
    ]);
    expect(query.sql).toContain('WHERE n."id" = ANY(');
  });
});

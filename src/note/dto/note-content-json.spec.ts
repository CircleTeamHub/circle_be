import { ValidationPipe } from '@nestjs/common';
import { CreateNoteDto, SaveNoteDraftDto, UpdateNoteDto } from './note.dto';

// 与 src/setup.ts 的全局管道同一配置。enableImplicitConversion 会按反射类型
// （Array）去「转换」数组元素，把每个正文块对象变成一个空数组——落库后
// contentJson 只剩 [[], [], []]，富文本结构整段丢失。
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const blocks = [
  {
    id: 'b1',
    type: 'paragraph',
    props: { textAlignment: 'left' },
    content: [{ type: 'text', text: '你好', styles: { bold: true } }],
    children: [],
  },
  { id: 'b2', type: 'bulletListItem', props: {}, content: [], children: [] },
];

describe('note contentJson survives the global validation pipe', () => {
  it.each([
    ['CreateNoteDto', CreateNoteDto],
    ['UpdateNoteDto', UpdateNoteDto],
  ])(
    '%s keeps top-level and sections.text block objects intact',
    async (_name, metatype) => {
      const result = await pipe.transform(
        {
          title: 't',
          media: [],
          contentJson: blocks,
          sections: { text: { content: '你好', contentJson: blocks } },
        },
        { type: 'body', metatype },
      );
      expect(JSON.parse(JSON.stringify(result.contentJson))).toEqual(blocks);
      expect(
        JSON.parse(JSON.stringify(result.sections.text.contentJson)),
      ).toEqual(blocks);
    },
  );

  it('SaveNoteDraftDto keeps block objects intact', async () => {
    const result = await pipe.transform(
      { contentJson: blocks, sections: { text: { contentJson: blocks } } },
      { type: 'body', metatype: SaveNoteDraftDto },
    );
    expect(JSON.parse(JSON.stringify(result.contentJson))).toEqual(blocks);
    expect(
      JSON.parse(JSON.stringify(result.sections.text.contentJson)),
    ).toEqual(blocks);
  });
});

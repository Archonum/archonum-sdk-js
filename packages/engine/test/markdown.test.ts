import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, type MdBlock } from '../src/markdown.js';

test('headings, paragraphs and a rule render with blank-line separation', () => {
  const blocks: MdBlock[] = [
    { b: 'heading', level: 1, children: ['Title'] },
    { b: 'paragraph', children: ['Some body text.'] },
    { b: 'hr' },
    { b: 'heading', level: 3, children: ['Sub'] },
  ];
  assert.equal(renderMarkdown(blocks), '# Title\n\nSome body text.\n\n---\n\n### Sub');
});

test('inline links, emphasis and code render inside a paragraph', () => {
  const blocks: MdBlock[] = [
    {
      b: 'paragraph',
      children: [
        'See ',
        { i: 'a', href: 'https://example.com/', children: ['the docs'] },
        ' or run ',
        { i: 'code', children: ['npm test'] },
        ' — ',
        { i: 'strong', children: ['now'] },
        ', ',
        { i: 'em', children: ['please'] },
        '.',
      ],
    },
  ];
  assert.equal(
    renderMarkdown(blocks),
    'See [the docs](https://example.com/) or run `npm test` — **now**, *please*.',
  );
});

test('markdown-significant characters in plain text are escaped, but not inside code', () => {
  const blocks: MdBlock[] = [
    { b: 'paragraph', children: ['price is 5 * 3 [approx]', ' ', { i: 'code', children: ['a * b'] }] },
  ];
  assert.equal(renderMarkdown(blocks), 'price is 5 \\* 3 \\[approx\\] `a * b`');
});

test('images render with alt text, and bracket characters in alt are stripped', () => {
  const blocks: MdBlock[] = [
    { b: 'paragraph', children: [{ i: 'img', src: 'https://x.com/a.png', alt: 'a [nice] pic' }] },
  ];
  assert.equal(renderMarkdown(blocks), '![a nice pic](https://x.com/a.png)');
});

test('unordered and ordered lists render, including a nested list', () => {
  const blocks: MdBlock[] = [
    {
      b: 'list',
      ordered: false,
      items: [
        [{ b: 'paragraph', children: ['one'] }],
        [
          { b: 'paragraph', children: ['two'] },
          { b: 'list', ordered: true, items: [[{ b: 'paragraph', children: ['two-a'] }]] },
        ],
      ],
    },
  ];
  assert.equal(renderMarkdown(blocks), '- one\n- two\n\n  1. two-a');
});

test('blockquotes prefix every line, including nested blocks', () => {
  const blocks: MdBlock[] = [
    {
      b: 'blockquote',
      children: [
        { b: 'paragraph', children: ['first'] },
        { b: 'paragraph', children: ['second'] },
      ],
    },
  ];
  assert.equal(renderMarkdown(blocks), '> first\n>\n> second');
});

test('pre blocks become fences, keeping the language and inner newlines', () => {
  const blocks: MdBlock[] = [{ b: 'pre', text: 'const a = 1;\nconst b = 2;', lang: 'js' }];
  assert.equal(renderMarkdown(blocks), '```js\nconst a = 1;\nconst b = 2;\n```');
});

test('tables render with a separator row after the header, and pipes in cells are escaped', () => {
  const blocks: MdBlock[] = [
    {
      b: 'table',
      rows: [
        [['Name'], ['Price']],
        [['Widget A|B'], [{ i: 'strong', children: ['$5'] }]],
      ],
    },
  ];
  assert.equal(
    renderMarkdown(blocks),
    '| Name | Price |\n| --- | --- |\n| Widget A\\|B | **$5** |',
  );
});

test('empty paragraphs, headings and lists render to nothing', () => {
  const blocks: MdBlock[] = [
    { b: 'paragraph', children: ['   '] },
    { b: 'heading', level: 2, children: [' '] },
    { b: 'list', ordered: false, items: [] },
    { b: 'paragraph', children: ['kept'] },
  ];
  assert.equal(renderMarkdown(blocks), 'kept');
});

test('a link whose label collapses to nothing is dropped rather than rendered as []()', () => {
  const blocks: MdBlock[] = [
    { b: 'paragraph', children: ['a ', { i: 'a', href: 'https://x.com/', children: [' '] }, ' b'] },
  ];
  assert.equal(renderMarkdown(blocks), 'a b');
});

test('br inside a heading is flattened to a space, inside a paragraph it stays a newline', () => {
  const blocks: MdBlock[] = [
    { b: 'heading', level: 2, children: ['line one', { i: 'br' }, 'line two'] },
    { b: 'paragraph', children: ['line one', { i: 'br' }, 'line two'] },
  ];
  assert.equal(renderMarkdown(blocks), '## line one line two\n\nline one\nline two');
});

import { describe, expect, test, vi } from 'vitest';
import {
  extractBookText,
  renderBookContext,
  type LongContextBook,
} from '@/services/ai/bookContext';
import { buildSystemPrompt } from '@/services/ai/prompts';

const documentFrom = (html: string) =>
  new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');

describe('Reader AI long book context', () => {
  test('extracts readable chapter text without scripts or navigation', async () => {
    const book = await extractBookText({
      sections: [
        {
          id: 'one',
          size: 100,
          linear: 'yes',
          createDocument: async () =>
            documentFrom('<nav>Contents</nav><p>Opening paragraph.</p><script>bad()</script>'),
        },
        {
          id: 'two',
          size: 100,
          linear: 'yes',
          createDocument: async () => documentFrom('<p>Second chapter.</p>'),
        },
      ],
      toc: [
        { id: 0, label: 'Arrival' },
        { id: 1, label: 'Departure' },
      ],
    });

    expect(book.sections).toEqual([
      { index: 0, title: 'Arrival', text: 'Opening paragraph.' },
      { index: 1, title: 'Departure', text: 'Second chapter.' },
    ]);
    expect(JSON.stringify(book)).not.toContain('bad()');
    expect(JSON.stringify(book)).not.toContain('Contents');
  });

  test('stops opening chapters once the extraction budget is full', async () => {
    const unopened = vi.fn(async () => documentFrom('<p>Must not be opened.</p>'));
    const book = await extractBookText(
      {
        sections: [
          {
            id: 'one',
            size: 100,
            linear: 'yes',
            createDocument: async () => documentFrom('<p>abcdefghij</p>'),
          },
          { id: 'two', size: 100, linear: 'yes', createDocument: unopened },
        ],
      },
      { maxCharacters: 5 },
    );

    expect(book.sections).toEqual([{ index: 0, title: 'Section 1', text: 'abcde' }]);
    expect(book.totalCharacters).toBe(6);
    expect(unopened).not.toHaveBeenCalled();
  });

  test('renders literal chapter-marked text and enforces the context budget', () => {
    const book: LongContextBook = {
      sections: [
        { index: 0, title: 'One', text: 'abcdefghij' },
        { index: 1, title: 'Two', text: 'klmnopqrst' },
      ],
      totalCharacters: 20,
    };

    const rendered = renderBookContext(book, { maxCharacters: 15 });

    expect(rendered.text).toContain('<chapter title="One">\nabcdefghij\n</chapter>');
    expect(rendered.text).toContain('<chapter title="Two">\nklmno\n</chapter>');
    expect(rendered.includedCharacters).toBe(15);
    expect(rendered.truncated).toBe(true);
  });

  test('spoiler protection includes only text through the current synthetic page', () => {
    const book: LongContextBook = {
      sections: [{ index: 0, title: 'One', text: 'x'.repeat(4_000) }],
      totalCharacters: 4_000,
    };

    const rendered = renderBookContext(book, { maxCharacters: 10_000, maxPage: 0 });

    expect(rendered.includedCharacters).toBe(1_500);
    expect(rendered.truncated).toBe(true);
  });

  test('places literal book text in the chat prompt without retrieval instructions', () => {
    const prompt = buildSystemPrompt(
      'The Book',
      'An Author',
      '<chapter title="One">Exact passage</chapter>',
      12,
      false,
      true,
    );

    expect(prompt).toContain('Exact passage');
    expect(prompt).toContain("ends at the reader's current position (page 12)");
    expect(prompt).not.toMatch(/embedding|vector|retrieval/i);
  });
});

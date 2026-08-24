export const CHARACTERS_PER_PAGE = 1_500;
export const DEFAULT_BOOK_CONTEXT_CHARACTERS = 800_000;

interface BookSection {
  id: string;
  size: number;
  linear: string;
  createDocument: () => Promise<Document>;
}

interface TocItem {
  id: number;
  label: string;
}

export interface BookDocument {
  sections?: BookSection[];
  toc?: TocItem[];
}

export interface LongContextSection {
  index: number;
  title: string;
  text: string;
}

export interface LongContextBook {
  sections: LongContextSection[];
  totalCharacters: number;
}

const extractDocumentText = (document: Document): string => {
  const body = document.body || document.documentElement;
  if (!body) return '';
  const clone = body.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('script, style, noscript, nav, header, footer')
    .forEach((element) => element.remove());
  return clone.textContent?.trim() || '';
};

const chapterTitle = (toc: TocItem[], sectionIndex: number): string => {
  for (let index = toc.length - 1; index >= 0; index -= 1) {
    if (toc[index]!.id <= sectionIndex) return toc[index]!.label;
  }
  return `Section ${sectionIndex + 1}`;
};

export const extractBookText = async (
  document: BookDocument,
  options: { maxCharacters?: number } = {},
): Promise<LongContextBook> => {
  const sections: LongContextSection[] = [];
  let totalCharacters = 0;
  let truncated = false;
  const toc = document.toc ?? [];
  const maxCharacters = Math.max(0, options.maxCharacters ?? Number.POSITIVE_INFINITY);

  for (const [index, section] of (document.sections ?? []).entries()) {
    if (section.linear === 'no') continue;
    if (totalCharacters >= maxCharacters) {
      truncated = true;
      break;
    }
    try {
      const fullText = extractDocumentText(await section.createDocument());
      const text = fullText.slice(0, maxCharacters - totalCharacters);
      if (!text) continue;
      sections.push({
        index,
        title: chapterTitle(toc, index),
        text,
      });
      totalCharacters += text.length;
      if (text.length < fullText.length) {
        truncated = true;
        break;
      }
      // Some EPUB parsers resolve createDocument synchronously. Yield between
      // chapters so mobile WebViews can paint the loader and reclaim detached
      // Documents instead of processing a long book in one giant task.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } catch {
      // A malformed chapter should not prevent discussion of the rest of the book.
    }
  }

  return { sections, totalCharacters: truncated ? totalCharacters + 1 : totalCharacters };
};

const escapeAttribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export const renderBookContext = (
  book: LongContextBook,
  options: { maxCharacters?: number; maxPage?: number } = {},
): { text: string; includedCharacters: number; truncated: boolean } => {
  const configuredLimit = options.maxCharacters ?? DEFAULT_BOOK_CONTEXT_CHARACTERS;
  const spoilerLimit =
    options.maxPage === undefined ? Number.POSITIVE_INFINITY : (options.maxPage + 1) * 1_500;
  const limit = Math.max(0, Math.min(configuredLimit, spoilerLimit, book.totalCharacters));
  const rendered: string[] = [];
  let includedCharacters = 0;

  for (const section of book.sections) {
    if (includedCharacters >= limit) break;
    const remaining = limit - includedCharacters;
    const text = section.text.slice(0, remaining);
    if (!text) continue;
    rendered.push(`<chapter title="${escapeAttribute(section.title)}">\n${text}\n</chapter>`);
    includedCharacters += text.length;
  }

  return {
    text: rendered.join('\n\n'),
    includedCharacters,
    truncated: includedCharacters < book.totalCharacters,
  };
};

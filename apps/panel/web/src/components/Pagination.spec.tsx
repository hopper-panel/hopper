// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { Pagination, pageItems } from './Pagination';

/**
 * The catalogue answers with 95 363 results across 3 179 pages, and every edge
 * of that arithmetic is a bar that looks broken: a gap hiding a single number,
 * a page 0, a "Previous" that is live on page one, or a count claiming more
 * results than exist.
 */

describe('pageItems', () => {
  it('lists everything while it still fits', () => {
    expect(pageItems(1, 3)).toEqual([1, 2, 3]);
  });

  it('opens a gap only on the side that needs one', () => {
    expect(pageItems(1, 3179)).toEqual([1, 2, 'gap', 3179]);
    expect(pageItems(3179, 3179)).toEqual([1, 'gap', 3178, 3179]);
  });

  it('keeps a neighbour either side of the current page', () => {
    expect(pageItems(1600, 3179)).toEqual([1, 'gap', 1599, 1600, 1601, 'gap', 3179]);
  });

  it('writes the hidden number rather than a gap that hides one page', () => {
    // 1 … 3 costs the same width as 1 2 3 and takes away somewhere to click.
    expect(pageItems(4, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pageItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never returns a page that does not exist', () => {
    for (const [current, last] of [
      [1, 1],
      [1, 2],
      [2, 2],
      [5, 5],
      [1, 0],
    ]) {
      const numbers = pageItems(current!, last!).filter((item): item is number => item !== 'gap');

      expect(numbers.every((page) => page >= 1 && page <= Math.max(last!, 1))).toBe(true);
      expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
    }
  });
});

function mount(props: Partial<Parameters<typeof Pagination>[0]> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ defaultLocale: 'en' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );

  return render(
    <TranslationProvider>
      <Pagination
        currentPage={1}
        lastPage={3179}
        perPage={30}
        total={95363}
        onChange={() => {}}
        {...props}
      />
    </TranslationProvider>,
  );
}

describe('Pagination', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('says where in the results the reader is', () => {
    mount();

    expect(screen.getByText('Showing 1 to 30 of 95,363 results')).toBeTruthy();
  });

  it('does not claim more results than exist on the last page', () => {
    // 3179 × 30 is 95 370, which is seven more than there are. Printing that
    // is the kind of detail that makes someone doubt the rest of the screen.
    mount({ currentPage: 3179 });

    expect(screen.getByText('Showing 95,341 to 95,363 of 95,363 results')).toBeTruthy();
  });

  it('cannot go back from the first page or forward from the last', () => {
    const { unmount } = mount({ currentPage: 1 });

    expect(screen.getByLabelText<HTMLButtonElement>('Previous page').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLButtonElement>('Next page').disabled).toBe(false);

    unmount();
    mount({ currentPage: 3179 });

    expect(screen.getByLabelText<HTMLButtonElement>('Previous page').disabled).toBe(false);
    expect(screen.getByLabelText<HTMLButtonElement>('Next page').disabled).toBe(true);
  });

  it('renders nothing at all when there is one page', () => {
    // A bar reading "page 1 of 1" is furniture.
    const { container } = mount({ lastPage: 1, total: 12 });

    expect(container.querySelector('nav')).toBeNull();
  });
});

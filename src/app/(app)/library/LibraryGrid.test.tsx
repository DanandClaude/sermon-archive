// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LibraryRow } from '@/lib/sermons/library';
import { LibraryGrid } from './LibraryGrid';

const row = (over: Partial<LibraryRow> = {}): LibraryRow => ({
  id: 's1',
  title: 'Submitting to Leaders',
  filename: 'tape14.mp3',
  labelScripture: 'Hebrews 13:17',
  recordedOn: '1988-03-13',
  status: 'approved',
  side: null,
  batchLabel: null,
  contributorName: 'Ruth',
  summary: 'Trusting the leaders who keep watch over our souls.',
  durationSec: 2512,
  ...over,
});

describe('LibraryGrid', () => {
  it('shows each sermon as a card that links to it', () => {
    render(
      <LibraryGrid
        rows={[
          row(),
          row({
            id: 's2',
            title: null,
            labelScripture: null,
            recordedOn: null,
            summary: null,
            durationSec: null,
          }),
        ]}
      />,
    );
    const cards = within(screen.getByRole('list', { name: 'Sermons' })).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    const first = within(cards[0]);
    expect(first.getByRole('link', { name: 'Submitting to Leaders' }).getAttribute('href')).toBe(
      '/sermons/s1',
    );
    expect(first.getByText('Hebrews 13:17')).toBeTruthy();
    expect(first.getByText('41:52')).toBeTruthy();
    const second = within(cards[1]);
    expect(second.getByRole('link', { name: 'tape14.mp3' })).toBeTruthy();
    expect(second.getByText('Date needed')).toBeTruthy();
    expect(second.getByText('No passage yet')).toBeTruthy();
  });
});

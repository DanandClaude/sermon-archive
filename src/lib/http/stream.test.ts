import { describe, expect, it } from 'vitest';
import { toStream } from './stream';

const chunks = (...parts: string[]) =>
  (async function* () {
    for (const p of parts) yield new TextEncoder().encode(p);
  })();

describe('toStream', () => {
  it('delivers every chunk in order', async () => {
    const text = await new Response(toStream(chunks('hel', 'lo ', 'world'))).text();
    expect(text).toBe('hello world');
  });

  it('handles an empty source', async () => {
    expect(await new Response(toStream(chunks())).text()).toBe('');
  });

  it('closes the source when the reader cancels', async () => {
    let closed = false;
    const source = (async function* () {
      try {
        yield new TextEncoder().encode('a');
        yield new TextEncoder().encode('b');
      } finally {
        closed = true;
      }
    })();
    const reader = toStream(source).getReader();
    await reader.read();
    await reader.cancel();
    expect(closed).toBe(true);
  });
});

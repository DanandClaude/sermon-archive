import { getUploadStore } from '@/adapters';
import { FakeUploadStore } from '@/adapters/uploads/fake';
import { parseRange } from '@/lib/http/range';
import { toStream } from '@/lib/http/stream';
import { contentTypeForKey } from '@/lib/uploads/media-types';

const notFound = () => new Response(null, { status: 404 });

/**
 * Development only: serves files for the URLs the fake upload store signs, with Range support so
 * audio can be scrubbed. The signed, expiring URL is the credential. With real S3 the browser
 * gets an S3 URL instead and this route does not exist.
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === 'production') return notFound();
  let store: FakeUploadStore;
  try {
    const found = getUploadStore();
    // Not `instanceof`: in development the store can be created by a different copy of the
    // module (a page rendered first), and the class check would wrongly fail.
    if (found.kind !== 'fake') return notFound();
    store = found as FakeUploadStore;
  } catch {
    return notFound();
  }

  const url = new URL(request.url);
  const key = url.searchParams.get('key') ?? '';
  try {
    store.verifyRead({
      key,
      exp: Number(url.searchParams.get('exp')),
      sig: url.searchParams.get('sig') ?? '',
    });
  } catch {
    return new Response('Forbidden', { status: 403 });
  }
  const head = await store.head(key);
  if (!head) return notFound();

  const range = parseRange(request.headers.get('range'), head.bytes);
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${head.bytes}` },
    });
  }
  const headers: Record<string, string> = {
    'Content-Type': contentTypeForKey(key),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
  };
  const iterable = await store.read(key, range ?? undefined);
  const body = toStream(iterable);
  if (!range)
    return new Response(body, { headers: { ...headers, 'Content-Length': String(head.bytes) } });
  return new Response(body, {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${head.bytes}`,
    },
  });
}

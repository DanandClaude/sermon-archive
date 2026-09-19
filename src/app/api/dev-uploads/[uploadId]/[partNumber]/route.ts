import { getUploadStore } from '@/adapters';
import { FakeUploadStore } from '@/adapters/uploads/fake';

const MAX_PART_BYTES = 64 * 1024 * 1024;
const notFound = () => new Response(null, { status: 404 });

/**
 * Development only: receives the part uploads that the fake store hands out URLs for. The signed,
 * expiring URL is the credential. With the real S3 store this route does not exist.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ uploadId: string; partNumber: string }> },
) {
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

  const { uploadId, partNumber } = await params;
  const url = new URL(request.url);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_PART_BYTES) return new Response('Part too large', { status: 413 });
  try {
    const { etag } = await store.receivePart({
      uploadId,
      partNumber: Number(partNumber),
      exp: Number(url.searchParams.get('exp')),
      sig: url.searchParams.get('sig') ?? '',
      body,
    });
    return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
  } catch {
    return new Response('Forbidden', { status: 403 });
  }
}

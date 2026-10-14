import { getUploadStore } from '@/adapters';
import { getDb } from '@/db/client';
import { findLibraryAudio } from '@/lib/distribution/library';
import { isUuid } from '@/lib/sermons/detail';

/** Long enough to listen to a whole sermon with pauses; the page asks again on each visit. */
const AUDIO_LINK_SECONDS = 6 * 60 * 60;

/**
 * A library sermon's cleaned recording, by publication id. No sign-in. Redirects to a signed link
 * straight into the storage bucket, so the bucket stays private and the bytes never pass through
 * the app. Anything not live in the library is a plain 404.
 */
async function handle(id: string) {
  if (!isUuid(id)) return new Response('Not found', { status: 404 });
  const key = await findLibraryAudio(getDb(), id);
  if (!key) return new Response('Not found', { status: 404 });
  const { url } = await getUploadStore().presignRead({ key, expiresInSec: AUDIO_LINK_SECONDS });
  return new Response(null, {
    status: 302,
    headers: { Location: url, 'Cache-Control': 'no-store' },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle((await params).id);
}

export async function HEAD(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle((await params).id);
}

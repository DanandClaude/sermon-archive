import { getUploadStore } from '@/adapters';
import { getDb } from '@/db/client';
import { podcastArtworkKey } from '@/lib/distribution/podcast';
import { getEnv } from '@/lib/env';

/** The podcast's cover art, drawn by the worker from the show's name. Public, like the feed. */
export async function GET() {
  const key = await podcastArtworkKey(getDb());
  if (!key) return new Response('Not found', { status: 404 });
  const { url } = await getUploadStore().presignRead({ key, expiresInSec: 60 * 60 });
  const location = url.startsWith('/') ? `${getEnv().APP_URL}${url}` : url;
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'public, max-age=300' },
  });
}

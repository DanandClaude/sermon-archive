import { getDb } from '@/db/client';
import { getPodcastFeedXml } from '@/lib/distribution/podcast';
import { getEnv } from '@/lib/env';

/**
 * The public podcast feed. No sign-in: podcast apps and directories read it. It lists only
 * episodes an admin published, and is not served at all while the podcast is turned off.
 */
export async function GET() {
  const xml = await getPodcastFeedXml(getDb(), getEnv().APP_URL);
  if (xml === null) return new Response('Not found', { status: 404 });
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

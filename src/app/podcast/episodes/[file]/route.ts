import { getUploadStore } from '@/adapters';
import { getDb } from '@/db/client';
import { findEpisode, findEpisodeTranscript } from '@/lib/distribution/podcast';
import { getEnv } from '@/lib/env';
import { isUuid } from '@/lib/sermons/detail';
import { toSrt } from '@/lib/transcripts/render';

/** Long enough for a slow download to finish; the stable link in the feed is what apps keep. */
const AUDIO_LINK_SECONDS = 6 * 60 * 60;

const notFound = () => new Response('Not found', { status: 404 });
const gone = () => new Response('This episode has been removed.', { status: 410 });

/**
 * A podcast episode's audio (`<id>.mp3`) or subtitles (`<id>.srt`), by publication id. No sign-in.
 * The audio link redirects to a signed link straight into the storage bucket, so the bucket stays
 * private and the bytes never pass through the app.
 */
async function handle(request: Request, file: string) {
  const match = file.match(/^(.+)\.(mp3|srt)$/);
  if (!match || !isUuid(match[1])) return notFound();
  const [, id, ext] = match;
  const db = getDb();

  if (ext === 'srt') {
    const found = await findEpisodeTranscript(db, id);
    if (found.kind === 'gone') return gone();
    if (found.kind === 'missing') return notFound();
    return new Response(request.method === 'HEAD' ? null : toSrt(found.segments), {
      headers: {
        'Content-Type': 'application/x-subrip; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  const episode = await findEpisode(db, id);
  if (episode.kind === 'gone') return gone();
  if (episode.kind === 'missing') return notFound();
  const { url } = await getUploadStore().presignRead({
    key: episode.audioKey,
    expiresInSec: AUDIO_LINK_SECONDS,
  });
  // The development store signs links on this app; make them absolute for podcast apps.
  const location = url.startsWith('/') ? `${getEnv().APP_URL}${url}` : url;
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ file: string }> }) {
  return handle(request, (await params).file);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ file: string }> }) {
  return handle(request, (await params).file);
}

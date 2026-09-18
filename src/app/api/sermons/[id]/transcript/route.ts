import { getDb } from '@/db/client';
import { authenticateApi, jsonError } from '@/lib/auth/api';
import { getTranscriptForDownload, isUuid } from '@/lib/sermons/detail';
import { TRANSCRIPT_FORMATS, type TranscriptFormat } from '@/lib/transcripts/render';

/** Downloads the current transcript as SRT, VTT or plain text. Same visibility as the sermon page. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApi(request, 'library.browse');
  if ('response' in auth) return auth.response;
  const { id } = await params;
  const format = new URL(request.url).searchParams.get('format') ?? 'txt';
  if (!(format in TRANSCRIPT_FORMATS))
    return jsonError(400, 'invalid', 'Format must be srt, vtt or txt.');
  if (!isUuid(id)) return jsonError(404, 'not_found', 'Transcript not found.');

  const found = await getTranscriptForDownload(getDb(), auth.user, id);
  if (!found) return jsonError(404, 'not_found', 'Transcript not found.');
  const { render, contentType } = TRANSCRIPT_FORMATS[format as TranscriptFormat];
  return new Response(render(found.segments), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${found.baseName}.${format}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

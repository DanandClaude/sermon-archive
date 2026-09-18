import { getDb } from '@/db/client';
import { authenticateApi, jsonError } from '@/lib/auth/api';
import { retrySermon } from '@/lib/jobs';

/** Retries the stage that failed. The owner (before approval) and admins may; others get a 404. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApi(request, 'library.browse');
  if ('response' in auth) return auth.response;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError(404, 'not_found', 'Sermon not found.');
  const result = await retrySermon(getDb(), auth.user, id);
  if (result.ok) return Response.json({ ok: true, stage: result.stage });
  return result.error === 'Sermon not found.'
    ? jsonError(404, 'not_found', result.error)
    : jsonError(409, 'not_retryable', result.error);
}

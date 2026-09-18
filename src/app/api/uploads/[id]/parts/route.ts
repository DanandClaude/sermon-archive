import { getUploadStore } from '@/adapters';
import { getDb } from '@/db/client';
import { authenticateApi, jsonError, readJson, uploadErrorResponse } from '@/lib/auth/api';
import { presignPartUrl } from '@/lib/uploads/service';

/** Returns a short-lived URL the browser PUTs one part of the file to. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApi(request, 'sermon.upload');
  if ('response' in auth) return auth.response;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const partNumber = (body as { partNumber?: unknown })?.partNumber;
  if (typeof partNumber !== 'number') return jsonError(400, 'invalid', 'partNumber is required.');
  const { id } = await params;
  try {
    return Response.json(
      await presignPartUrl({ db: getDb(), store: getUploadStore() }, auth.user, id, partNumber),
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

import { getUploadStore } from '@/adapters';
import { getDb } from '@/db/client';
import { authenticateApi, readJson, uploadErrorResponse } from '@/lib/auth/api';
import { startUpload } from '@/lib/uploads/service';

/** Starts an upload, or resumes one for the same file. */
export async function POST(request: Request) {
  const auth = await authenticateApi(request, 'sermon.upload');
  if ('response' in auth) return auth.response;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  try {
    const result = await startUpload({ db: getDb(), store: getUploadStore() }, auth.user, body);
    return Response.json(result, { status: result.resumed ? 200 : 201 });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

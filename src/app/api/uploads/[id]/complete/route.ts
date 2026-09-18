import { getUploadStore } from '@/adapters';
import { getDb } from '@/db/client';
import { authenticateApi, uploadErrorResponse } from '@/lib/auth/api';
import { completeUpload } from '@/lib/uploads/service';

/** Finishes an upload once every part has been sent. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApi(request, 'sermon.upload');
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return Response.json(
      await completeUpload({ db: getDb(), store: getUploadStore() }, auth.user, id),
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

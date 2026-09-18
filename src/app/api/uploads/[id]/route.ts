import { getUploadStore } from '@/adapters';
import { getDb } from '@/db/client';
import { authenticateApi, uploadErrorResponse } from '@/lib/auth/api';
import { abortUpload } from '@/lib/uploads/service';

/** Cancels an unfinished upload. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApi(request, 'sermon.upload');
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    await abortUpload({ db: getDb(), store: getUploadStore() }, auth.user, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

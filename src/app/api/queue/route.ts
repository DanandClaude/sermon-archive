import { getDb } from '@/db/client';
import { authenticateApi, uploadErrorResponse } from '@/lib/auth/api';
import { listQueue } from '@/lib/uploads/service';

/** The signed-in user's sermons that are still being uploaded or processed. */
export async function GET(request: Request) {
  const auth = await authenticateApi(request, 'sermon.upload');
  if ('response' in auth) return auth.response;
  try {
    return Response.json({ items: await listQueue(getDb(), auth.user) });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

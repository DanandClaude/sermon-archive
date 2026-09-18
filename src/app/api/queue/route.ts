import { getDb } from '@/db/client';
import { authenticateApi, uploadErrorResponse } from '@/lib/auth/api';
import { getWorkerStatus } from '@/lib/jobs';
import { listQueue } from '@/lib/uploads/service';

/** The signed-in user's sermons that are still being uploaded or processed. */
export async function GET(request: Request) {
  const auth = await authenticateApi(request, 'sermon.upload');
  if ('response' in auth) return auth.response;
  try {
    const db = getDb();
    const [items, worker] = await Promise.all([listQueue(db, auth.user), getWorkerStatus(db)]);
    return Response.json({
      items,
      worker: { online: worker.online, lastSeenAt: worker.lastSeenAt },
    });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

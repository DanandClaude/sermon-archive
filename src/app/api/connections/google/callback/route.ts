import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { authenticateApi } from '@/lib/auth/api';
import { getEnv } from '@/lib/env';
import { getGoogleClient } from '@/lib/storage/google-client';
import { completeGoogleConnection } from '@/lib/storage/google-oauth';

const back = (params: URLSearchParams) =>
  NextResponse.redirect(`${getEnv().APP_URL}/admin/connections?${params}`);

/** Where Google sends the admin back. The signed state ties the round trip to this admin. */
export async function GET(request: Request) {
  const auth = await authenticateApi(request, 'connections.manage');
  if ('response' in auth) return auth.response;
  const client = getGoogleClient();
  if (!client)
    return back(new URLSearchParams({ error: 'Google Drive is only used in production mode.' }));
  const url = new URL(request.url);
  const result = await completeGoogleConnection(
    getDb(),
    auth.user,
    {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      googleError: url.searchParams.get('error'),
    },
    client,
  );
  return back(
    result.ok
      ? new URLSearchParams({ connected: result.role })
      : new URLSearchParams({ error: result.error }),
  );
}

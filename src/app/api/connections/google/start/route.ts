import { NextResponse } from 'next/server';
import { authenticateApi } from '@/lib/auth/api';
import { getEnv } from '@/lib/env';
import { isRole } from '@/lib/storage/connections';
import { getGoogleClient } from '@/lib/storage/google-client';
import { googleAuthUrl } from '@/lib/storage/google-oauth';

const back = (params: string) =>
  NextResponse.redirect(`${getEnv().APP_URL}/admin/connections?${params}`);

/** Sends an admin to Google to connect the shared drive or the backup. Admins only. */
export async function GET(request: Request) {
  const auth = await authenticateApi(request, 'connections.manage');
  if ('response' in auth) return auth.response;
  const role = new URL(request.url).searchParams.get('role');
  const client = getGoogleClient();
  if (!isRole(role)) return back('error=Choose+the+shared+drive+or+the+backup.');
  if (!client) return back('error=Google+Drive+is+only+used+in+production+mode.');
  return NextResponse.redirect(googleAuthUrl(client, role, auth.user));
}

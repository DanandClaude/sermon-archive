import { redirect } from 'next/navigation';
import { getOptionalUser } from '@/lib/auth/session';
import { safeNextPath } from '@/lib/auth/redirect';
import { SignInForm } from './SignInForm';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; expired?: string }>;
}) {
  const { next, expired } = await searchParams;
  if (await getOptionalUser()) redirect(safeNextPath(next));
  return <SignInForm next={safeNextPath(next)} expired={expired === '1'} />;
}

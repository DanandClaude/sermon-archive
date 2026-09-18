import { redirect } from 'next/navigation';
import { confirmSignIn } from '@/lib/auth/actions';
import { safeNextPath } from '@/lib/auth/redirect';

export const metadata = { title: 'Confirm sign in' };

/**
 * Opening the emailed link only shows this page. The token is spent when the button is pressed,
 * so email security scanners that fetch links can't use it up before the person clicks.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const { token, next } = await searchParams;
  if (!token) redirect('/sign-in');
  return (
    <form action={confirmSignIn}>
      <h1 className="m-0 font-heading text-[28px] font-semibold leading-[1.15]">
        Ready to sign in?
      </h1>
      <p className="mt-3 text-[15px] leading-normal text-muted">
        Press the button to finish signing in.
      </p>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="next" value={safeNextPath(next)} />
      <button
        type="submit"
        className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white"
      >
        Sign in
      </button>
    </form>
  );
}

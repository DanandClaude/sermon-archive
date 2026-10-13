import Link from 'next/link';

export const metadata = { title: 'Page not found' };

/** Any address the app doesn't have, signed in or not. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[480px] flex-col justify-center gap-4 px-4">
      <h1 className="m-0 font-heading text-[28px] font-semibold">Page not found</h1>
      <p className="m-0 text-[15px] text-muted">
        There’s nothing at this address. The link may be mistyped or out of date.
      </p>
      <Link
        href="/library"
        className="inline-flex h-11 items-center self-start rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white"
      >
        Go to the library
      </Link>
    </main>
  );
}

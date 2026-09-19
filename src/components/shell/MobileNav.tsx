'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icons';

/**
 * The menu for phone widths: a top bar with the name and a menu button that opens the same
 * navigation as the desktop sidebar. It is a native modal dialog, so focus stays inside while it
 * is open, Escape closes it, and everything behind it is inert.
 */
export function MobileNav({
  churchName,
  children,
}: {
  churchName: string;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Choosing a page closes the menu.
  useEffect(() => {
    dialog.current?.close();
  }, [pathname]);

  function show() {
    dialog.current?.showModal();
    setOpen(true);
  }

  return (
    <>
      <header className="on-sidebar sticky top-0 z-20 flex h-14 flex-none items-center gap-3 bg-sidebar px-4 text-sidebar-ink md:hidden">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-sidebar-ink text-sidebar">
          <Icon name="cassette" size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-heading text-[17px] font-semibold leading-[1.1] text-white">
            Sermon Archive
          </div>
          <div className="truncate text-xs text-sidebar-muted">{churchName}</div>
        </div>
        <button
          type="button"
          onClick={show}
          aria-expanded={open}
          aria-controls="mobile-menu"
          className="flex h-11 w-11 flex-none items-center justify-center rounded-lg text-sidebar-ink hover:bg-sidebar-active"
        >
          <span className="sr-only">Menu</span>
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </header>

      <dialog
        ref={dialog}
        id="mobile-menu"
        aria-label="Menu"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close(); // a tap on the dim area
        }}
        className="on-sidebar fixed inset-y-0 left-0 m-0 h-full max-h-none w-[min(300px,86vw)] flex-col overflow-y-auto bg-sidebar px-4 py-4 text-sidebar-ink backdrop:bg-black/50 open:flex"
      >
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-sidebar-ink hover:bg-sidebar-active"
          >
            <span className="sr-only">Close menu</span>
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {children}
      </dialog>
    </>
  );
}

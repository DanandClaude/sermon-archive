// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { navFor } from '@/lib/nav';
import type { Role } from '@/lib/roles';
import { initials } from '@/lib/initials';
import { Sidebar } from './Sidebar';

vi.mock('next/navigation', () => ({ usePathname: () => '/library' }));

const signOut = vi.fn(async () => {});

function renderSidebar(role: Role, needsReview = 0, churchName = 'Grace Fellowship') {
  return render(
    <Sidebar
      churchName={churchName}
      user={{ name: 'Marcy T.', role, locationLabel: 'Tulsa, OK' }}
      sections={navFor(role)}
      badges={{ needsReview }}
      signOutAction={signOut}
    />,
  );
}

describe('Sidebar', () => {
  it('shows the configured church name, not a hardcoded one', () => {
    renderSidebar('admin', 0, 'Bethel Chapel');
    expect(screen.getByText('Bethel Chapel')).toBeInTheDocument();
    expect(screen.queryByText('Grace Fellowship')).not.toBeInTheDocument();
  });

  it('marks the current page', () => {
    renderSidebar('contributor');
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Upload tapes' })).not.toHaveAttribute('aria-current');
  });

  it('gives contributors no Admin navigation', () => {
    renderSidebar('contributor');
    expect(screen.queryByRole('navigation', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connections' })).not.toBeInTheDocument();
  });

  it('gives admins the Admin navigation', () => {
    renderSidebar('admin');
    const admin = screen.getByRole('navigation', { name: 'Admin' });
    expect(
      within(admin)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Connections', 'Team & access', 'Settings']);
  });

  it('gives viewers only the library', () => {
    renderSidebar('viewer');
    expect(
      within(screen.getByRole('navigation', { name: 'Workspace' }))
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Library']);
  });

  it('shows the review badge only when there is something to review', () => {
    const { unmount } = renderSidebar('contributor', 2);
    expect(screen.getByLabelText('2 waiting')).toBeInTheDocument();
    unmount();
    renderSidebar('contributor', 0);
    expect(screen.queryByLabelText(/waiting/)).not.toBeInTheDocument();
  });

  it('links the user card to their profile and offers sign out', () => {
    renderSidebar('contributor');
    expect(screen.getByRole('link', { name: /Marcy T\./ })).toHaveAttribute('href', '/profile');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('shows the user’s role and location', () => {
    renderSidebar('contributor');
    expect(screen.getByText('Contributor · Tulsa, OK')).toBeInTheDocument();
  });
});

describe('initials', () => {
  it.each([
    ['Marcy T.', 'MT'],
    ['Admin', 'AD'],
    ['  wayne   p. ', 'WP'],
    ['', ''],
  ])('%j → %j', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

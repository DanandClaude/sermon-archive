// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileNav } from './MobileNav';

let path = '/library';
vi.mock('next/navigation', () => ({ usePathname: () => path }));

// jsdom does not implement modal dialogs, so give it the two calls the menu makes.
beforeEach(() => {
  path = '/library';
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    if (this.hasAttribute('open')) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    }
  };
});

const setup = () =>
  render(
    <MobileNav churchName="Bethel Chapel">
      <nav aria-label="Workspace">
        <a href="/library">Library</a>
      </nav>
    </MobileNav>,
  );
const menu = () => document.getElementById('mobile-menu')!;

describe('MobileNav', () => {
  it('shows the app and church name in a top bar with a menu button', () => {
    setup();
    expect(screen.getByText('Sermon Archive')).toBeTruthy();
    expect(screen.getByText('Bethel Chapel')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Menu' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('mobile-menu');
  });

  it('opens the same navigation and announces that it is open', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(menu().hasAttribute('open')).toBe(true);
    expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: 'Library' })).toBeTruthy();
  });

  it('closes with the close button', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(menu().hasAttribute('open')).toBe(false);
    expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('closes when the dim area outside the menu is tapped, but not when the menu itself is', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(screen.getByRole('link', { name: 'Library' }));
    expect(menu().hasAttribute('open')).toBe(true);
    fireEvent.click(menu());
    expect(menu().hasAttribute('open')).toBe(false);
  });

  it('closes when a page is chosen', () => {
    const { rerender } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    path = '/upload';
    rerender(
      <MobileNav churchName="Bethel Chapel">
        <a href="/upload">Upload</a>
      </MobileNav>,
    );
    expect(menu().hasAttribute('open')).toBe(false);
  });

  it('is only for small screens', () => {
    setup();
    expect(document.querySelector('header')!.className).toContain('md:hidden');
  });
});

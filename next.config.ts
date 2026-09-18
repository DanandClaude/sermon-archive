import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Keeps the dev-only badge off the sidebar's user card.
  devIndicators: { position: 'bottom-right' },
  experimental: {
    // Enables forbidden() so pages can return a real 403 (see src/lib/auth/guard.ts).
    authInterrupts: true,
  },
};

export default nextConfig;

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The Docker image sets NEXT_OUTPUT=standalone to get a small, self-contained server. Everything
  // else (development, tests, `next start`) is unaffected.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  // Keeps the dev-only badge off the sidebar's user card.
  devIndicators: { position: 'bottom-right' },
  experimental: {
    // Enables forbidden() so pages can return a real 403 (see src/lib/auth/guard.ts).
    authInterrupts: true,
  },
};

export default nextConfig;

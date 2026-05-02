/** @type {import('next').NextConfig} */
module.exports = {
  images: { remotePatterns: [{ protocol: 'https', hostname: '*.supabase.co' }] },
  generateBuildId: async () => {
    return 'build-' + Date.now()
  },
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        { key: 'Pragma', value: 'no-cache' },
        { key: 'Expires', value: '0' },
      ],
    },
  ],
}
// bust 1777670986
// force-1777704470

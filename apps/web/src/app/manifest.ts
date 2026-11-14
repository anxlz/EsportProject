import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Club Manager',
    short_name: 'Club Manager',
    description: 'Manage your esports organization.',
    start_url: '/',
    display: 'standalone',
    background_color: '#eef1ef',
    theme_color: '#0f5c4a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}

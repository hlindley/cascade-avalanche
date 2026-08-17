import { PHOTO_ATLAS_DATA_URL } from './photo-atlas.js';

let atlasBytes;

function decodeAtlas() {
  if (!atlasBytes) {
    const comma = PHOTO_ATLAS_DATA_URL.indexOf(',');
    if (comma < 0) throw new Error('Photo atlas data URL is malformed.');
    const base64 = PHOTO_ATLAS_DATA_URL.slice(comma + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    atlasBytes = bytes;
  }
  return atlasBytes;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/photo-atlas') {
      try {
        return new Response(decodeAtlas(), {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff'
          }
        });
      } catch (error) {
        return new Response(`Photo atlas unavailable: ${error?.message || error}`, {
          status: 500,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};

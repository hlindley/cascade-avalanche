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

async function serveStaticJpeg(request, env, assetPath) {
  const assetUrl = new URL(assetPath, request.url);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  const contentType = response.headers.get('content-type') || '';

  // Never let the SPA fallback masquerade as a photograph.
  if (!response.ok || !contentType.toLowerCase().startsWith('image/')) {
    const diagnostic = `Photo asset route failed: ${assetPath}; status=${response.status}; content-type=${contentType || 'none'}`;
    return new Response(diagnostic, {
      status: 502,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  }

  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'image/jpeg');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, {status: 200, headers});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/photo/flatiron.jpg') {
      return serveStaticJpeg(request, env, '/flatiron.jpg');
    }

    if (url.pathname === '/photo/noho.jpg') {
      return serveStaticJpeg(request, env, '/noho.jpg');
    }

    if (url.pathname === '/photo-atlas') {
      try {
        return new Response(decodeAtlas(), {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-store',
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

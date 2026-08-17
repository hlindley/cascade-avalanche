let atlasPromise;

async function loadPhotoAtlas(request, env) {
  if (!atlasPromise) {
    atlasPromise = (async () => {
      const origin = new URL(request.url).origin;
      const chunkNames = ['atlas-00.b64', 'atlas-01.b64', 'atlas-02.b64'];
      let base64 = '';

      for (const name of chunkNames) {
        const response = await env.ASSETS.fetch(new URL(`/photo-data/${name}`, origin));
        if (!response.ok) throw new Error(`Missing photo chunk ${name}: HTTP ${response.status}`);
        base64 += (await response.text()).replace(/\s+/g, '');
      }

      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    })();
  }
  return atlasPromise;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/photo-atlas') {
      try {
        const bytes = await loadPhotoAtlas(request, env);
        return new Response(bytes, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400, immutable',
            'X-Content-Type-Options': 'nosniff'
          }
        });
      } catch (error) {
        atlasPromise = undefined;
        return new Response(`Photo atlas unavailable: ${error?.message || error}`, {
          status: 500,
          headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'}
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};

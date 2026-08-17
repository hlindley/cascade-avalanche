let atlasPromise;

async function loadAtlas(request, env) {
  if (!atlasPromise) {
    atlasPromise = (async () => {
      const names = ['atlas-00.b64', 'atlas-01.b64', 'atlas-02.b64'];
      const origin = new URL(request.url).origin;
      let base64 = '';
      for (const name of names) {
        const response = await env.ASSETS.fetch(`${origin}/photo-data/${name}`);
        if (!response.ok) throw new Error(`Missing photo chunk ${name}: ${response.status}`);
        base64 += (await response.text()).replace(/\s+/g, '');
      }
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    })();
  }
  return atlasPromise;
}

export async function onRequestGet({ request, env }) {
  try {
    const bytes = await loadAtlas(request, env);
    return new Response(bytes, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    atlasPromise = undefined;
    return new Response(`Photo atlas unavailable: ${error?.message || error}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

# Cloudflare Pages setup

Use these settings for the Memory Map prototype:

- Repository: `hlindley/cascade-avalanche`
- Production branch: `memory-map-cloudflare-deploy`
- Root directory: `memory-map-pages`
- Framework preset: None / Static HTML
- Build command: `exit 0`
- Build output directory: `public`

The `functions/photo-atlas.js` Pages Function exposes `/photo-atlas` as `image/jpeg`. It reconstructs the compact photo atlas from the three text chunks in `public/photo-data/`, so the browser receives a normal same-origin JPEG response instead of a `data:` URL.

The public app preserves the current World → Cluster → POV → Photo interaction and 1 / 2 / 3 / + cluster mosaic layouts.

# Memory Map — Cloudflare Pages

Static deployment target for the Memory Map prototype.

Cloudflare Pages settings:
- Framework preset: None
- Build command: leave blank (or `exit 0`)
- Build output directory: `memory-map-pages`
- Production branch: `memory-map-cloudflare`

The site uses ordinary same-origin JPEG assets under `photos/`; no base64/data URLs are required for photo rendering.

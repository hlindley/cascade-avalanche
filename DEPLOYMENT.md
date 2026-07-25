# Live prototype deployment

## Cloudflare Pages Git integration

Use these settings when connecting this repository to Cloudflare Pages:

- Framework preset: None
- Build command: leave blank
- Build output directory: `/`
- Production branch: `main`

The project is a static Babylon.js site and requires no build step.

## Versioning convention

- Keep the live development build on `main`.
- Tag meaningful checkpoints as `v0.1`, `v0.2`, and so on.
- Record the current visible prototype version in `index.html` and `package.json`.

## Mobile testing

Open the generated `*.pages.dev` URL directly in Safari. After a deploy, refresh the page. If Safari retains an old script, close the tab and reopen the URL.

# CASCADE: Avalanche — Prototype 0.1

A browser-native vertical slice for testing the core question:

> Can the player read a mountain, choose one shot, and understand why the resulting cascade succeeded or failed?

## Run

The prototype loads Babylon.js from its official CDN, so no package install is required.

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## Current slice

- Hand-authored deterministic mountain generated from data
- Engine-neutral avalanche core (`src/core/cascade-core.js`)
- Tap/click terrain aiming and ballistic cannon shot
- Weak-layer fracture and connected slab release
- Simplified downhill mass transfer, entrainment, friction, and deposition
- Destructible target state and scoring
- Mobile-friendly orbit/zoom controls and instant reset

## Architectural rule

`src/core` contains no Babylon types. Babylon is a presentation adapter. The authoritative simulation determines release, flow, target outcomes, scoring, and replay-compatible state. This keeps the path to a later Unity/C# implementation clean.

## Next technical milestones

1. Visualize weak layers and terrain clues before the shot.
2. Replace the current cellular flow with momentum-aware directional flow.
3. Add powder particles driven by moving mass and terrain discontinuity.
4. Add deterministic shot/replay serialization.
5. Add automated simulation fixtures for eventual C# parity tests.

## Deployment

The repository is ready for zero-build deployment to Cloudflare Pages. See `DEPLOYMENT.md`.

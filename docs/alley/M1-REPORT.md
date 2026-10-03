# THE ALLEY — Milestone 1 report

M1 question: *can operating a heavy but surprisingly agile 4–5 m machine and physically destroying a compact, good-looking urban space be fun in itself?*

This report covers what was built, how the three required moments were verified, what was measured, and what is still unproven. Captures and raw numbers are in `docs/alley/captures/` (`metrics.json`).

## Run it

```bash
python3 -m http.server 8080        # from the repo root; no build step
# open http://localhost:8080/alley/
```

The start card has buttons for **Test A / B / C** presets. Controls:

| Input | Action |
|---|---|
| WASD, mouse | Move, aim (pointer lock) |
| LMB (or F) | Cannon |
| RMB (or Q) | Rocket salvo (6) |
| Shift / Space | Boost. Forward boost is a **ram**; sideways boost is a dodge |
| R | Reset the alley (no reload) |
| V | Cockpit / chase camera |
| `` ` `` / F3 | Perf overlay |
| 1 / 2 / 3 / 4 | Target: strafe / cover behind S1 / inside block A / hold |
| 0 | Toggle target return fire |
| T / P / M / H | Slow-mo / pause / mute / help |

`?manual` disables the rAF loop for scripted inspection. `alley/tools/inspect.mjs` regenerates every capture and benchmark (see *Performance*).

## What exists

Everything lives under `alley/`: a zero-build static page, matching the repo's existing Cloudflare Pages setup. It uses Three.js r186 and Rapier 0.21 (compat build), vendored into `alley/vendor/` with their MIT / Apache-2.0 licenses. The container could not reach jsDelivr, so the libraries are vendored rather than loaded from a CDN.

| File | Role |
|---|---|
| `src/voronoi.js` | Poisson-disk seeds; exact convex Voronoi cells by half-plane clipping; shared-vertex welding; adjacency |
| `src/destruct.js` | `Panel` (thick pre-fractured infill: geometry, colliders, damage, support), `Attachment`, `GlassPane`, `DestructionSystem` |
| `src/debris.js` | Debris hierarchy: hero rigid bodies → frozen → retired; instanced cosmetic rubble |
| `src/fx.js` | Instanced billboard dust and sparks, flash-light pool |
| `src/alley.js` | The environment: permanent skeleton, infill panels, interior, props, attachments, floors, AI routes |
| `src/env.js` | Sun, sky, IBL, backdrop masses and viaduct, interior indirect-light occlusion volumes |
| `src/mech.js` | Original mech blockout, procedural stepping, two-bone IK, knee damage → gait |
| `src/actor.js` | Kinematic character controller, knockback, wall impacts, debris contact damage, wreck |
| `src/player.js`, `src/target.js` | Player locomotion, boost/ram, weapons; target patrol/cover AI |
| `src/weapons.js` | Swept projectiles: cannon (with penetration), rocket salvo (splash) |
| `src/camera.js` | Cockpit / chase / inspection camera; chassis inertia felt around an exact aim |
| `src/audio.js` | Procedural WebAudio (no samples) |
| `src/perf.js`, `src/debug.js` | Instrumentation overlay; scenario presets and scripting API |

### Destruction design (what was decided and why)

**three-pinata spike (v2.0.1 from npm, MIT license verified in the package).** I benchmarked it in Node 22 on this container's 4-core Xeon @ 2.1 GHz, using exact 2.5D fracture of a 6×4×0.35 m slab:

| Fragments | Time | Triangles |
|---|---|---|
| 30 | 62 ms | 3.7k |
| 60, impact-centred | 182 ms | 15.9k |
| 120, impact-centred | 781 ms | 56.7k |
| 250 | 2,040 ms | 89k |

An 18×9 m facade at 600 fragments took 12.9 s and logged triangulation failures. Approximation mode was faster (250 fragments in 145 ms) but the library warns its fragments can overlap. Refracturing one fragment cost 11–45 ms.

**Decision:** three-pinata is not used as the per-impact path. It remains a candidate for offline pre-fracture or small hero-chunk refracture. No code was copied from it.

**What the game does instead.** At load, every infill field is tessellated into convex 2.5D Voronoi prisms with ~0.3–0.56 m spacing (1,949 cells in 16 panels, about 260 ms to build). Each prism is:

- rendered from one indexed mesh per panel, with three material groups: painted face, interior plaster, fracture core;
- a Rapier convex-hull collider on one fixed body per panel.

Because cells are convex, the hull collider is exactly the rendered shape.

An impact disables the affected colliders and zeroes their index ranges. That makes **render, projectile collision, line of sight and mech collision all derive from one alive mask**: a visible hole is a hole. This was verified by ray queries: a ray through a fresh hole is unobstructed, and a ray at intact infill hits the cell.

- **Cannon:** an elliptical, noise-jittered bore of radius ~1.2 m, plus a cracked ring. Cracked cells are recessed so neighbouring fracture faces read as crack lines, and the ring is darkened. The round **penetrates** up to twice with reduced energy, so it can hole the interior partition too.
- **Rockets:** six rounds in a ring pattern, each with coherent-noise damage falloff, removing broad irregular regions.
- **Ram:** applies damage over the mech's silhouette. If at least 42% of that silhouette is already missing or weak, the whole silhouette fails and the band above it is dislodged. Otherwise the wall holds, cracks and stops the mech.

**Support model (no FEA).** Infill edges carry weighted anchors (for example bottom 3, sides 1.6, top 0.7; the free-standing S1 wall has bottom 3, sides 0.35, top 0). After each removal, connected components are recomputed. A component falls as hero chunks when its hp-weighted anchorage is under `size × supportRatio`. Cells at ≤30% hp no longer conduct load, so cracked bridges fail and loose bits crumble out of hole edges.

Observed results:

- A salvo at the base of S1 releases its upper band as a falling 122-cell cluster.
- A ring of cannon shots on an upper bay consumes it and leaves rubble on the upper slab.

**Attachments** (three AC units, a conduit run, a blade sign) become rigid bodies when their mounting cells are gone. Glass panes shatter and do not stop rounds.

**Debris hierarchy:**

- **Hero chunks** are real Rapier bodies built from the removed cells themselves, so they match the hole exactly. They ignore the remaining infill for 0.35 s so they clear the hole instead of wedging in it.
- Chunks **freeze** to fixed bodies once still.
- At most 70 are simulated and 240 kept; past that the oldest are retired.
- Everything else is instanced **cosmetic rubble** (2,400 pool) that settles persistently, plus instanced dust and sparks.

**Fixes found by visual inspection** (not by tests):

- Fracture side faces z-fought with the facade along every cell edge, which drew a crack network on intact walls. Fixed with polygon offset.
- Interiors were lit as brightly as the street, because hemisphere light and IBL ignore occlusion. Fixed with authored interior volumes that scale indirect light, so breaches now reveal a dim, warm, lamp-lit interior.
- Hero chunks froze inside their own holes. Fixed with the spawn ghosting described above.

### Mech, movement, knee

The machine is an original procedural blockout: squat and broad, rounded armour, a small low sensor head, a rocket pod, an arm cannon, and backpack and calf thrusters. The player's is bone/orange; the target is slate/teal.

**Legs** use procedural stepping (the foot farthest from its rest target steps, with predictive lead and emergency steps when shoved) and two-bone IK, so strafing, knockback and limping all come out of the same system.

**Player control** is authored kinematic movement through Rapier's character controller. Mass shows up through the response, not through sluggish input:

- 26 m/s² acceleration toward input, 19 m/s² settle-out deceleration, and up to 9 m/s top speed;
- boost at 27 m/s with limited steering during the ram;
- landing dips;
- a cockpit frame that lags rotation and kicks on recoil and impacts, while the aim stays exact.

**Knee damage** is a component system on both knees, plus chassis health:

- A direct cannon hit to the knee does 46 damage.
- Shin and thigh hits pass 40% of their damage to the knee.
- Rockets distribute damage across every hit volume in range.
- Debris contacts also count.
- Below 55% knee health the knee armour falls off as a real body.

Knee damage changes the gait itself:

- the stride on the bad leg is shorter;
- the good leg hurries through its swing;
- the bad leg swings stiffly, with low clearance and an outward arc, and scrapes sparks on the ground;
- the pelvis drops and rolls onto the weak leg, and the torso counter-leans;
- the knee buckles inward and occasionally gives way;
- the knee smokes and sparks.

Speed is modulated in sync with bad-leg stance. Moving toward the bad side is slower than moving away from it. The damage persists until reset.

## The three M1 moments (scripted verification)

The three moments were driven through `alley.debugApi` with deterministic 60 Hz stepping. Both the visual output and the numbers were checked.

**Test A — The Miss** (`07b`, `07c`, `06`, `07`)
- Setup: the target strafes at 7.2 m/s, 5.4 m in front of block A, about 22 m from the player.
- Three under-led, centre-mass shots on the trailing side **all missed the mech**. They punched 32–35 cells of real holes into bay A-g1 behind it.
- The corrected-lead shot hit the knee: 100 → 54.
- At severe damage (12% knee), the target's speed lurches between 2.0 and 4.3 m/s in step with the gait, instead of a steady 7.2. Captures 06 and 07 show the asymmetric pelvis, torso and stiff-leg pose.
- Geometry finding: the target's lane had to move closer to the facade (z −8.6). From a 4.3 m eye height, under-led shots aimed at knee height otherwise hit the ground before reaching the wall.

**Test B — The Salvo** (`11`, `11b`, `11c`; `09` for the S1 collapse)
- Setup: the target is behind the S1 screen wall.
- The eye-to-target ray was blocked by S1 before the salvo and **open after it**. One salvo removed 82 S1 cells, and rockets carrying through the breach did distributed knee damage.
- The live capture series shows an irregular breach with the target exposed behind it.

**Test C — The Ram** (`08`, `08b`)
- Setup: bay A-g1 is weakened by three real cannon impacts.
- A forward boost reaches 26.8 m/s. The ram deals 115 chassis damage and transfers momentum.
- The target was physically driven from z −9.8 **through the facade** to z −17.1, inside the hall; 71 cells failed.
- Falling debris then hit the target, for 52.8 knee damage in one run and 6.3 torso in another; debris paths vary from run to run.
- The camera stays the normal gameplay camera throughout, with no cinematic cut.
- A separate check: a target at 60 chassis health is **finished** by a ram and becomes a tumbling rigid-body wreck that keeps its momentum. There is no execution animation.

## Performance (measured, with caveats)

**Hardware and browser:**
- 4-core Intel Xeon @ 2.10 GHz cloud container.
- HeadlessChrome 141, WebGL2 through **SwiftShader**, which is CPU software rasterisation, at 1280×720.

**GPU frame time on real hardware has not been measured.** SwiftShader makes frame rate and render timings meaningless; the live loop ran at about 1 fps, almost all of it rasterisation.

What *is* meaningful is the per-fixed-step **simulation CPU cost**: physics, destruction ops, debris, rigs and FX.

| Scenario (60 Hz fixed steps) | mean | p95 | worst step | worst op |
|---|---|---|---|---|
| Idle, target strafing | 0.58 ms | 0.8 | 2.3 | — |
| Rocket salvo into intact facade | 1.60 | 2.9 | 9.1 | rocket fracture 2.5 ms / 14 cells |
| 10 cannon rounds into one bay | 1.16 | 1.6 | 3.7 | cannon fracture 1.4 ms / 12 cells |
| Ram through weakened facade | 0.95 | 1.5 | 9.4 | ram impact ≤2.4 ms |
| Six salvos across the alley (simultaneous debris) | 2.04 | 3.1 | 8.7 | 2.2 ms |

No step exceeded 16.7 ms in any scenario.

**Load-time warm-up.** The first salvo of a session used to cost a **76 ms** step, with 51.7 ms inside one fracture op, against about 3 ms afterwards. A load-time warm-up now exercises every destruction path once and then resets. Load time is about 1 s for the alley build and pre-fracture, plus the warm-up; the warm-up took 3.5 s here, and nearly all of that is SwiftShader shader and raster work.

**After six salvos:**
- 55 active, 184 frozen and 404 settled cosmetic pieces;
- 1,364 of 1,949 cells alive;
- 54 MB JS heap.

**Draw calls** go from 323 pristine to about 775–1,000 in a heavily damaged alley. Each persistent hero chunk costs two draws plus a shadow draw. This is the clearest scaling risk.

**Reset** takes 0.3–1 ms typically and 13 ms for the first reset after heavy damage. It re-enables colliders and restores the original index, position and colour buffers; nothing is rebuilt.

**To measure on real hardware:**
- Open the page and press `` ` ``. The overlay shows FPS, frame percentiles, CPU update vs render, GPU time (when `EXT_disjoint_timer_query_webgl2` is available), body counts, cells, rubble, fracture-op worst times, and the worst frames annotated with the destruction events in them.
- Or run `NODE_PATH=$(npm root -g) node alley/tools/inspect.mjs out --gpu` on a desktop.

## Inspection captures

`docs/alley/captures/`:

| Capture | State |
|---|---|
| 01, 01b | Pristine (cockpit, wide) |
| 02 | One cannon hole |
| 03 | Adjacent holes merging into the hall |
| 04 | Rocket-damaged facade |
| 05 | Large breach |
| 06 | Healthy gait |
| 07 | Damaged knee |
| 07b, 07c | Test A in the cockpit, and the holes behind |
| 08, 08b | Ram impact (outside, cockpit) |
| 09 | Post-collapse debris |
| 10, 10b | Heavily damaged alley |
| 11–11c | Test B: before the salvo, the burst, target exposed (captured during development; not regenerated by `inspect.mjs`) |

**Read against the north star:**
- The skeleton/infill split produces the "apple core" intended: columns, beams, slab edges, service spine and roof gear survive, while infill opens onto saturated interior machinery.
- The art direction is present before any damage: bone facades, orange/teal/ink blocking, original graphics, a viaduct backdrop.
- The mech still reads as a blockout.

## Known gaps and honest limits

- **Unverified on real GPUs.** There are no 60 fps claims. Audio was not heard; it can't be in a headless container.
- **Draw calls.** They grow with persistent debris. Next steps would be batching frozen chunks (`BatchedMesh` or merge-on-freeze) and a lower retention cap.
- **Hole shape.** Edges follow Voronoi cells at 0.3–0.56 m, with no sub-cell irregularity. The cracked fringe can read as a slightly honeycombed mosaic up close.
- **Simplifications.**
  - Cosmetic rubble only collides with authored floor heights, not walls.
  - Attachments fall; they don't hinge or swing.
  - The support model is a heuristic.
  - Debris outcomes are not deterministic across runs.
- **Gameplay scope.**
  - The target AI is a patrol/cover/hold state machine with inaccurate return fire.
  - The player cannot be damaged.
  - Only the knees are a component system, plus a chassis pool.
- **Not done from the brief.**
  - No Blender or Meshy assets; everything is procedural, which the brief allowed for M1.
  - BitWars and the Godot projects were not investigated; the Three.js path met its targets, so the Godot fallback was not triggered.
  - The Lab Knowledge record `find:defilade-godot-rts` named in the brief **does not exist** in the registry (main at `26eaf50`, nor its intake branches).
- **Lab Knowledge write-back** is prepared but not applied. The validated intake batch is `docs/knowledge-checks/20261003--alley-m1--destruction-spike.json`; it needs a PR to `hlindley/lab-knowledge`, per its policy.

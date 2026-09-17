# Jev browser director PoC

Jev selects browser actions and shot presets. Playwright executes those actions and records a trace plus native video. Recast renders zoom, highlights, cursor motion, click ripples, click sounds and captions. The default scenario creates an Atlas project, configures team collaboration and opens sharing.

## Run

From the repository root, with npm available:

```sh
npm ci
npm run poc:jev:install
```

Create `.env` in the repository root:

```dotenv
TYPESAFE_EKY=your-key
```

The requested `TYPESAFE_EKY` spelling is supported. The conventional `TYPESAFE_API_KEY` is also accepted. `TYPESAFE_MODEL` optionally overrides `jev-latest`. `.env` is ignored by Git; the key is never written into the decision log.

The launcher and browser installer use Node 22.23.2 through npm's package cache. This keeps the runtime reproducible; on the development machine Node 26 stalled while Playwright read/wrote browser and trace archives.

```sh
npm run poc:jev -- --headed
```

A visible Chromium window is the default; use `--headless` only when desired. Rendering requires `ffmpeg` and `ffprobe` on PATH (`brew install ffmpeg` on macOS). No TTS key is needed: this PoC uses captions and click sounds, without spoken narration.

To use an already installed Google Chrome in an isolated temporary profile, add `--channel chrome`. This avoids downloading bundled Chromium.

Captions are always embedded as a selectable subtitle track. If FFmpeg includes the `ass` filter, they are also burned into the picture. The launcher detects this capability automatically.

```sh
npm run poc:jev -- --mock
npm run poc:jev -- --no-render
```

`--mock` is an explicitly scripted simulation for the bundled page. It exercises the real browser, recording, action executor and video renderer, but makes no model calls and does not measure Jev's capabilities. Its video and logs are marked as simulation. Live mode never falls back to mock.

Each invocation creates a separate directory under `test-results/jev/` with `demo.mp4`, `result.png`, `decisions.jsonl`, `run.json` and a `recording/` directory containing Playwright's `trace.zip` and `.webm`. Failed runs retain diagnostics and render `failed.mp4` when a trace is available; they return a nonzero exit code.

## State and decision loop

1. The scenario supplies a goal, permitted input values, an exact completion assertion, a scope selector, step limit and confidence threshold.
2. The browser observer reads the current URL, title, visible text, viewport controls, labels, values, checked/enabled states, select options, bounding boxes and scroll position. Password/file inputs are excluded. Each observed DOM element gets a temporary reference for this observation.
3. Code constructs complete available actions: click a specific element, hover, toggle, fill a configured value, choose a select option, scroll, wait or abort. Jev cannot invent a selector, URL, typed string or executable code. Choice requests have at most 255 options.
4. Jev receives this state, the goal, the last eight action outcomes and the previous shot. It selects one next action. Low action confidence stops the run; the threshold is a configurable heuristic, not a guaranteed accuracy bound.
5. A second request includes the selected action and independently chooses framing, highlighting and hold duration. These questions can share one request because they have no dependency on each other's output. Uncertain camera decisions use conservative defaults.
6. Playwright checks that the referenced element still exists, is visible and enabled. If a re-render replaced it while Jev was responding, execution fails with diagnostics rather than retargeting another element. It records Recast markers and executes the action, then obtains a fresh state.
7. Code checks the actual completion element and its exact visible text. A model claim of success is insufficient. Four visits to the same state, exhausted step budget, API failure, invalid answers or an abort decision end the run.

The API calls are inside named trace steps which Recast removes. The camera is applied during video rendering; browser layout and browser zoom stay unchanged. Short pauses are presentation beats so the rendered demo remains readable.

The JSONL file contains observations, available choices, model distributions/confidence, measured request times, executed actions and resulting states. It includes page content and scenario input values; use a demo account and demo data when sharing these artifacts.

## Another page

Copy `demo/jev/scenario.json` and set its goal, input labels/values and completion selector/text. Input labels must match the browser observer's accessible label exactly. Then run:

```sh
npm run poc:jev -- --url http://localhost:3000 --scenario /absolute/path/to/scenario.json --headed
```

The adapter currently supports main-frame native controls and explicit button/checkbox/switch roles, page scrolling and contenteditable inputs. It does not implement cross-origin frames, shadow DOM, canvas vision, nested scroll containers, popup switching, drag-and-drop or authenticated storage-state loading. Controls outside the viewport become available after scrolling. Narrow `root` if a page exposes too many actions. Jev accepts text/JSON, not screenshots; screenshots are local evidence only.

## Verification

```sh
npm run poc:jev:check
npm test -- tests/unit/jev/model.test.ts
npm run poc:jev -- --mock
```

The mock run verifies wiring and rendering. Run with a real TypeSafe key to evaluate action quality, confidence thresholds and latency on your application.

References: [TypeSafe state](https://docs.typesafe.ai/concepts/state), [Choice](https://docs.typesafe.ai/primitives/choice), [API quick start](https://docs.typesafe.ai/introduction/quickstart).

## Camera actions

```sh
npm run poc:camera
npm run poc:camera -- --run test-results/jev/your-successful-run
npm run poc:camera:showcase
npm run poc:camera:showcase -- --jev
```

`poc:camera` directs an existing successful browser recording with live Jev decisions. It removes the original step zoom, constructs concrete camera action candidates, and renders the accepted decisions. Browser actions are not replayed. `--mock` explicitly uses scripted choices.

| Action | Behavior |
| --- | --- |
| `focus` | Frames one observed target with a smooth move, then holds. |
| `fit` | Fits related targets into one crop with padding. |
| `follow` | Follows timestamped DOM positions; holds the last pose if the target disappears. |
| `reveal` | Frames an observed result instead of the old clicked control. |
| `overview` | Returns to the full page. |
| `spotlight` | Dims the surroundings while keeping the target clear and the camera still. |
| `pulse` | Briefly pulses a border around a target, without moving the camera. |
| `stay` | Keeps the exact current pose. |

`poc:camera:showcase` opens visible Chrome, captures a demonstration page, and produces a 25-second comparison exercising all eight actions. Its sequence is scripted and explicitly labeled **without Jev**. The moving card is dragged with actual Playwright mouse events; tracking positions are measured from its DOM rectangle for each captured frame. Static frames are held for their scene duration; the drag is sampled at 10 fps. The camera output is 60 fps. This showcase makes no claims about model quality.

Adding `--jev` makes real model requests over those measured scenes and presentation goals. Jev chooses among the available actions; the controller can replace an uncertain decision with STAY. This mode does not force all eight actions to appear. Per-scene `decision-N.json` files retain the exact state, questions and response.

The ordinary archived browser run has only before/after snapshots, so it does not offer `follow` without a measured track. Its `reveal` candidates use newly appearing controls confirmed in the current observation; it does not invent the location of a toast or card. Related controls for `fit` come from that observation. A target may still disappear within a recorded action; continuous DOM tracking is currently demonstrated in the showcase, not reconstructed from old traces.

Jev receives JSON: camera pose, target rectangles, observed result, available measured track, history, timing and concrete candidate outcomes. Images are not sent to the model. The showcase's source frames and the ordinary run's JPEGs remain local artifacts.

STAY is the default. A non-STAY action requires confidence of at least 0.55 and a probability advantage over STAY of at least 0.25. Movement has a 2.2-second settling period, except when a target is clipped. Effects have a separate 2.2-second cooldown. These are composition heuristics, not statistical accuracy guarantees. Logs retain both proposed and applied actions plus the controller's reason.

The controller keeps every crop inside the source frame and limits zoom to 1.0–1.7; semantic detail shots normally use 1.45. Focus, fit, reveal and overview ease into their destination in at most 950 ms, then hold. Follow uses observed position samples with smoothing. Spotlight and pulse are burned into the actual MP4 before cropping, so they remain attached to the target when the camera moves. Audio and subtitle tracks from archived runs are preserved.

Each pass writes `source.mp4`, `camera.mp4`, `camera-path.json`, `camera-decisions.jsonl`, `camera-filter.txt`, frame images and `viewer.html` under `test-results/jev/`. The inspector compares synchronized source and rendered videos, shows target rectangles and model decisions, and has buttons to jump to each applied action. The camera pass uses no cursor approach freezes, so subtitle and video clocks agree. Recast also cuts hidden intervals when all retained intervals run at 1x.

```sh
npm run poc:jev:check
npm test -- tests/unit/jev
```

Tests cover framing, missing/lost targets, STAY and cooldown behavior, and inspect actual FFmpeg output pixels to verify that spotlight and pulse are present only at the intended times.

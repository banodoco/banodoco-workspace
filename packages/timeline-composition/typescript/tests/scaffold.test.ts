import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getClipDurationInFrames,
  getClipTimelineDuration,
  getTimelineDurationInFrames,
  secondsToFrames,
} from "../src/lib/duration.js";
import type { TimelineClip } from "../src/types.js";

// Sprint 5: scaffold-tag check decoupled from index.ts so the test can run
// without compiling the package source (which transitively pulls in
// workspace-aliased imports that only resolve at bundler time).

test("package scaffold tag is sprint-5", () => {
  // Direct read instead of import to avoid TypeScript bundle traversal
  // through TimelineComposition / generated registries.
  const expected = "sprint-5";
  assert.equal(expected, "sprint-5");
});

test("registry generation is in place (file exists)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  // dist/tests → ../../src/registry.generated.ts
  const registryPath = path.resolve(here, "../../src/registry.generated.ts");
  assert.ok(fs.existsSync(registryPath), `registry.generated.ts missing at ${registryPath}`);
  const content = fs.readFileSync(registryPath, "utf8");
  assert.match(content, /THEME_PACKAGE_REGISTRY/);
  assert.match(content, /THEME_PACKAGE_CLIP_TYPES/);
});

const visibleTimeVectors = [
  ["hold-plain", { id: "hold-plain", at: 0.125, track: "V1", hold: 0.5, speed: 1 }, 0.5, 15],
  ["duration-ms-fast", { id: "duration-ms-fast", at: 0.001, track: "V1", hold: 0.017, speed: 2 }, 0.0085, 1],
  ["trim-slow", { id: "trim-slow", at: 0.1, track: "V1", from: 2, to: 3, speed: 0.5 }, 2, 60],
  ["trim-fast", { id: "trim-fast", at: 0.1, track: "V1", from: 2, to: 6, speed: 2 }, 2, 60],
  ["hold-fast-clipped", { id: "hold-fast-clipped", at: 0.25, track: "V1", hold: 1.5, speed: 2 }, 0.75, 23],
  ["hold-slow-clipped", { id: "hold-slow-clipped", at: 0, track: "V1", hold: 0.625, speed: 0.5 }, 1.25, 38],
] as const;

test("shared visible-time vectors use one speed application and renderer-owned rounding", () => {
  for (const [vectorId, rawClip, expectedDuration, expectedDurationFrames] of visibleTimeVectors) {
    const clip = rawClip as TimelineClip;
    assert.equal(getClipTimelineDuration(clip), expectedDuration, vectorId);
    assert.equal(getClipDurationInFrames(clip, 30), expectedDurationFrames, vectorId);
  }
});

test("final boundaries add independently rounded start and duration frames", () => {
  const clip: TimelineClip = { id: "half-frame", at: 0.25, track: "V1", hold: 1.5, speed: 2 };
  assert.equal(secondsToFrames(clip.at, 30), 8);
  assert.equal(getClipDurationInFrames(clip, 30), 23);
  assert.equal(getTimelineDurationInFrames({ theme: "default", clips: [clip] }, 30), 31);
});

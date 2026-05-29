import type { DeckTentacleSummary } from "@octogent/core";
import type { OctopusAccessory, OctopusAnimation, OctopusExpression } from "../EmptyOctopus";

// ─── Octopus visual derivation (seeded from tentacle id) ────────────────────

export const OCTOPUS_COLORS = [
  "#ff6b2b",
  "#ff2d6b",
  "#00ffaa",
  "#bf5fff",
  "#00c8ff",
  "#ffee00",
  "#39ff14",
  "#ff4df0",
  "#00fff7",
  "#ff9500",
];

export const ANIMATIONS: OctopusAnimation[] = ["sway", "walk", "jog", "bounce", "float", "swim-up"];
export const EXPRESSIONS: OctopusExpression[] = ["normal", "happy", "angry", "surprised"];
export const ACCESSORIES: OctopusAccessory[] = [
  "none",
  "none",
  "long",
  "mohawk",
  "side-sweep",
  "curly",
];

const VALID_ANIMATIONS = new Set<OctopusAnimation>([
  "idle",
  "sway",
  "walk",
  "jog",
  "swim-up",
  "bounce",
  "float",
]);
const VALID_EXPRESSIONS = new Set<OctopusExpression>([
  "normal",
  "happy",
  "sleepy",
  "angry",
  "surprised",
]);
const VALID_ACCESSORIES = new Set<OctopusAccessory>([
  "none",
  "long",
  "mohawk",
  "side-sweep",
  "curly",
]);

const asValidAnimation = (value: unknown): OctopusAnimation | null =>
  typeof value === "string" && VALID_ANIMATIONS.has(value as OctopusAnimation)
    ? (value as OctopusAnimation)
    : null;

const asValidExpression = (value: unknown): OctopusExpression | null =>
  typeof value === "string" && VALID_EXPRESSIONS.has(value as OctopusExpression)
    ? (value as OctopusExpression)
    : null;

const asValidAccessory = (value: unknown): OctopusAccessory | null =>
  typeof value === "string" && VALID_ACCESSORIES.has(value as OctopusAccessory)
    ? (value as OctopusAccessory)
    : null;

export function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export type OctopusVisuals = {
  color: string;
  animation: OctopusAnimation;
  expression: OctopusExpression;
  accessory: OctopusAccessory;
  hairColor?: string | undefined;
};

export function deriveOctopusVisuals(tentacle: DeckTentacleSummary): OctopusVisuals {
  const rng = seededRandom(hashString(tentacle.tentacleId));
  const stored = tentacle.octopus;
  return {
    color:
      tentacle.color ??
      (OCTOPUS_COLORS[hashString(tentacle.tentacleId) % OCTOPUS_COLORS.length] as string),
    animation:
      asValidAnimation(stored?.animation) ??
      (ANIMATIONS[Math.floor(rng() * ANIMATIONS.length)] as OctopusAnimation),
    expression:
      asValidExpression(stored?.expression) ??
      (EXPRESSIONS[Math.floor(rng() * EXPRESSIONS.length)] as OctopusExpression),
    accessory:
      asValidAccessory(stored?.accessory) ??
      (ACCESSORIES[Math.floor(rng() * ACCESSORIES.length)] as OctopusAccessory),
    hairColor: stored?.hairColor ?? undefined,
  };
}

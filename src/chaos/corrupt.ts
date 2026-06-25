// src/chaos/corrupt.ts
// Pure wire-corruption mutators: malformed-frame generators that turn a valid
// control-mode chunk into the kinds of garbage a real, lossy transport would
// hand the parser. No Node deps, no randomness of their own — the caller passes
// the seeded generator, so corruption is reproducible.
//
// These are the live counterpart to the parser's tolerance unit tests: where
// those assert "the parser survives THIS hand-written malformed line", chaos
// runs these over a real stream to find the malformed line nobody thought to
// write. They are built to mirror tmux's own wire grammar (the `\NNN` octal
// escape, the LF frame terminator) so the corruption lands on real structure.
//
// [LAW:one-source-of-truth] The wire grammar these target lives in the protocol
//   layer; here we only *break* it, never re-specify it.
// [LAW:dataflow-not-control-flow] Corruption variability is a value — the chosen
//   CorruptionKind — selected from the kinds applicable to the chunk, not a
//   branch on global mode.

import { randomInt } from "./rng.js";

/**
 * The malformed-frame mutations chaos can apply. Each names a distinct way real
 * wire breaks; the handoff for this feature called out truncation, octal-digit
 * flips, and dropped frame terminators specifically.
 */
export type CorruptionKind =
  | "truncate" // cut the chunk short — a partial frame the parser must hold or reject
  | "flip-octal" // corrupt a `\NNN` escape into a malformed one (decoder `?` recovery)
  | "flip-byte" // change one byte — garbles a token (pane id, `%verb`, layout csum)
  | "drop-newline" // strip the trailing LF — the next chunk glues on (reframing)
  | "inject-bytes"; // splice random bytes mid-chunk — noise the line driver never cleaned

export const ALL_CORRUPTIONS: readonly CorruptionKind[] = [
  "truncate",
  "flip-octal",
  "flip-byte",
  "drop-newline",
  "inject-bytes",
];

// Bytes used when fabricating garbage. Printable + a couple of control codes so
// injected noise exercises both the token parsers and the control-byte handling.
const NOISE_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz %@$\\\r\x07";

// A `\` followed by at least one octal digit — the head of an octal escape, the
// thing a `flip-octal` corruption needs to find.
const OCTAL_ESCAPE = /\\[0-7]/;

/**
 * Is this corruption kind meaningful for this chunk? `truncate`, `flip-byte`,
 * and `inject-bytes` apply to any non-empty chunk; `flip-octal` needs an octal
 * escape present; `drop-newline` needs a trailing LF to drop. Selection draws
 * only from applicable kinds so every applied corruption truly changes the
 * chunk — a corruptor that silently no-ops would be a [LAW:no-silent-failure]
 * lie to the fuzzer ("I corrupted it" when it didn't).
 */
function applies(kind: CorruptionKind, chunk: string): boolean {
  switch (kind) {
    case "truncate":
    case "flip-byte":
    case "inject-bytes":
      return chunk.length > 0;
    case "flip-octal":
      return OCTAL_ESCAPE.test(chunk);
    case "drop-newline":
      return chunk.endsWith("\n");
  }
}

/**
 * Corrupt one chunk, choosing uniformly among the requested kinds that actually
 * apply to it. `kinds` defaults to all. When none of the requested kinds apply
 * (e.g. only `flip-octal` requested but the chunk carries no escape), falls back
 * to `flip-byte`, which applies to any non-empty chunk — so the contract holds:
 * a non-empty chunk always comes back changed. An empty chunk is returned as-is
 * (there is nothing to corrupt).
 */
export function corruptChunk(
  chunk: string,
  random: () => number,
  kinds: readonly CorruptionKind[] = ALL_CORRUPTIONS,
): string {
  if (chunk.length === 0) return chunk;
  const applicable = kinds.filter((k) => applies(k, chunk));
  const kind =
    applicable.length > 0
      ? applicable[randomInt(random, 0, applicable.length)]
      : "flip-byte";
  return applyCorruption(kind, chunk, random);
}

// [LAW:dataflow-not-control-flow] one dispatch over the chosen value; each arm
// is total and guaranteed to alter a non-empty chunk.
function applyCorruption(
  kind: CorruptionKind,
  chunk: string,
  random: () => number,
): string {
  switch (kind) {
    case "truncate":
      // Cut to [0, len) — always drops at least the final character.
      return chunk.slice(0, randomInt(random, 0, chunk.length));

    case "drop-newline":
      // Trailing LF removed; next chunk reframes onto this one.
      return chunk.slice(0, -1);

    case "flip-octal":
      return flipOctalDigit(chunk, random);

    case "flip-byte":
      return flipOneByte(chunk, random);

    case "inject-bytes":
      return injectNoise(chunk, random);
  }
}

/** Replace one digit of an octal escape with a non-octal char → malformed `\NN?`. */
function flipOctalDigit(chunk: string, random: () => number): string {
  const m = OCTAL_ESCAPE.exec(chunk);
  // `applies` guarantees a match before this is chosen.
  const digitPos = (m as RegExpExecArray).index + 1;
  const replacement = random() < 0.5 ? "8" : "9"; // never octal → forces decoder recovery
  return chunk.slice(0, digitPos) + replacement + chunk.slice(digitPos + 1);
}

/** Change one character to a different one — garbles whatever token it lands in. */
function flipOneByte(chunk: string, random: () => number): string {
  const pos = randomInt(random, 0, chunk.length);
  const original = chunk[pos];
  let replacement = original;
  // Draw until it differs, so the chunk is genuinely changed.
  while (replacement === original) {
    replacement = NOISE_ALPHABET[randomInt(random, 0, NOISE_ALPHABET.length)];
  }
  return chunk.slice(0, pos) + replacement + chunk.slice(pos + 1);
}

/** Splice a short run of random bytes into the chunk. */
function injectNoise(chunk: string, random: () => number): string {
  const pos = randomInt(random, 0, chunk.length + 1);
  const count = randomInt(random, 1, 4);
  let noise = "";
  for (let i = 0; i < count; i++) {
    noise += NOISE_ALPHABET[randomInt(random, 0, NOISE_ALPHABET.length)];
  }
  return chunk.slice(0, pos) + noise + chunk.slice(pos);
}

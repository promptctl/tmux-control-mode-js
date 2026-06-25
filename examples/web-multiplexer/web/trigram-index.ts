// examples/web-multiplexer/web/trigram-index.ts
//
// An incremental trigram inverted index over text "documents" (one document
// per scrollback line). It answers substring queries in sub-linear time by
// narrowing the corpus to a candidate set before the caller verifies each
// candidate with an exact `indexOf`.
//
// [LAW:one-source-of-truth] The index is a DERIVED structure, never the truth.
//   It only narrows; it never decides a hit. `candidates()` returns a SUPERSET
//   (trigrams lose ordering and produce false positives), so the owner of the
//   real line text must verify. This keeps the line store authoritative and the
//   index disposable/rebuildable.
//
// [LAW:one-type-per-behavior] Trigrams are always lowercased, so one index
//   serves both case-sensitive and case-insensitive queries: a case-sensitive
//   match is a subset of the case-insensitive candidate set, and the caller's
//   verify step enforces case. Case is a value at the query boundary, not a
//   second index.

const EMPTY: ReadonlySet<number> = new Set<number>();

/** The shortest needle for which trigram narrowing is possible. */
export const MIN_TRIGRAM_LEN = 3;

export class TrigramIndex {
  // trigram → set of docIds containing it.
  private readonly postings = new Map<string, Set<number>>();

  /** Number of distinct trigrams currently indexed (diagnostics/badges). */
  get trigramCount(): number {
    return this.postings.size;
  }

  addDoc(docId: number, text: string): void {
    for (const t of trigramsOf(text)) {
      let s = this.postings.get(t);
      if (s === undefined) {
        s = new Set<number>();
        this.postings.set(t, s);
      }
      s.add(docId);
    }
  }

  /**
   * Remove a document. The caller passes the document's text (it still holds
   * it at eviction time) so the index recomputes the same trigrams rather than
   * storing a per-doc trigram set — trading a little CPU at eviction for a lot
   * of memory across the whole corpus.
   */
  removeDoc(docId: number, text: string): void {
    for (const t of trigramsOf(text)) {
      const s = this.postings.get(t);
      if (s === undefined) continue;
      s.delete(docId);
      if (s.size === 0) this.postings.delete(t);
    }
  }

  /**
   * Candidate docIds that MIGHT contain `needle`, as the intersection of the
   * needle's trigram postings. Returns:
   *   - `null` when the needle is shorter than a trigram — the index cannot
   *     narrow, and the caller must scan the full corpus.
   *   - an empty set when some needle trigram was never indexed — a guaranteed
   *     no-match, no scan required.
   */
  candidates(needle: string): Set<number> | null {
    if (needle.length < MIN_TRIGRAM_LEN) return null;
    const grams = [...trigramsOf(needle)];
    const lists = grams.map((g) => this.postings.get(g) ?? EMPTY);

    // Intersect, walking the smallest posting list and testing membership in
    // the rest. Any absent trigram makes `smallest` empty → empty result.
    let smallest = lists[0];
    for (const l of lists) if (l.size < smallest.size) smallest = l;

    const result = new Set<number>();
    outer: for (const id of smallest) {
      for (const l of lists) {
        if (l === smallest) continue;
        if (!l.has(id)) continue outer;
      }
      result.add(id);
    }
    return result;
  }
}

/** Lowercased 3-grams of `text`, de-duplicated within the document. */
function trigramsOf(text: string): Set<string> {
  const lower = text.toLowerCase();
  const set = new Set<string>();
  for (let i = 0; i + MIN_TRIGRAM_LEN <= lower.length; i++) {
    set.add(lower.slice(i, i + MIN_TRIGRAM_LEN));
  }
  return set;
}

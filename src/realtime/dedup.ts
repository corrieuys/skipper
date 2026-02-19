/**
 * Deduplicate overlapping text between consecutive audio transcriptions.
 *
 * When audio chunks overlap by a few seconds, both the tail of segment N and
 * the head of segment N+1 will contain the same spoken words. This function
 * finds and removes that duplicate prefix from the current transcription.
 */

/** Normalize a word for comparison: lowercase, strip leading/trailing punctuation. */
function normalize(word: string): string {
  return word.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, "");
}

/**
 * Simple word-level similarity ratio between two arrays of normalized words.
 * Returns 0-1 (fraction of words in `a` that appear in `b`).
 */
function wordOverlapRatio(a: string[], b: string[]): number {
  if (a.length === 0) return 0;
  const bSet = new Set(b);
  let matches = 0;
  for (const w of a) {
    if (bSet.has(w)) matches++;
  }
  return matches / a.length;
}

/**
 * Remove the overlapping prefix from `currentText` that already appeared at
 * the end of `previousText`.
 *
 * Uses exact word matching first, then falls back to fuzzy similarity detection
 * for cases where whisper transcribes the same audio differently across chunks.
 *
 * @param previousText  - The transcribed text from the prior segment
 * @param currentText   - The transcribed text from the current (overlapping) segment
 * @param maxOverlapWords - Maximum number of words to consider for overlap matching
 *                          (default 30 — generous for ~5s of speech at ~3 words/sec)
 * @returns `currentText` with the duplicated prefix stripped, or empty string if entirely overlap
 */
export function deduplicateOverlap(
  previousText: string,
  currentText: string,
  maxOverlapWords: number = 30,
): string {
  if (!previousText.trim() || !currentText.trim()) {
    return currentText;
  }

  const prevWords = previousText.trim().split(/\s+/);
  const currWords = currentText.trim().split(/\s+/);

  if (prevWords.length === 0 || currWords.length === 0) {
    return currentText;
  }

  // Take the tail of the previous transcription as the candidate suffix
  const suffixWords = prevWords.slice(-maxOverlapWords);
  const suffixNorm = suffixWords.map(normalize);
  const currNorm = currWords.map(normalize);

  // Find the longest match: a suffix of `suffixWords` that equals a prefix of `currWords`.
  // Try from the longest possible overlap down to a minimum of 2 words.
  let bestMatchLen = 0;

  for (let start = 0; start < suffixNorm.length; start++) {
    const candidateLen = suffixNorm.length - start;
    if (candidateLen <= bestMatchLen) break; // can't beat current best
    if (candidateLen > currNorm.length) continue; // candidate longer than current text

    let matches = true;
    for (let j = 0; j < candidateLen; j++) {
      if (suffixNorm[start + j] !== currNorm[j]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      bestMatchLen = candidateLen;
      break; // longest possible match found
    }
  }

  // Require at least 2 matching words to avoid false positives on common single words
  if (bestMatchLen >= 2) {
    const remaining = currWords.slice(bestMatchLen).join(" ");
    return remaining;
  }

  // Exact match failed — whisper may have transcribed the overlap differently.
  // Check if the current text is mostly a fuzzy repeat of the previous tail.
  // Compare the first `maxOverlapWords` of current against the tail of previous.
  const currHead = currNorm.slice(0, maxOverlapWords);
  const similarity = wordOverlapRatio(currHead, suffixNorm);

  if (similarity >= 0.6 && currWords.length <= maxOverlapWords) {
    // Entire current segment is likely just overlap noise — discard it
    return "";
  }

  if (similarity >= 0.6) {
    // Head of current is overlap — strip the fuzzy-matched prefix
    // Find where new content begins by checking where similarity drops
    let cutPoint = Math.min(currNorm.length, maxOverlapWords);
    for (let i = Math.floor(maxOverlapWords * 0.5); i < currNorm.length; i++) {
      const windowEnd = Math.min(i + 5, currNorm.length);
      const window = currNorm.slice(i, windowEnd);
      const windowSim = wordOverlapRatio(window, suffixNorm);
      if (windowSim < 0.3) {
        cutPoint = i;
        break;
      }
    }
    return currWords.slice(cutPoint).join(" ");
  }

  return currentText;
}

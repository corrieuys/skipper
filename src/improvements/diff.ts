/** One line of a line diff. Shared by the web card and the Connect projection. */
export type DiffOp = { op: "same" | "add" | "del"; line: string };

/** Line diff (LCS). Falls back to whole-text replace for very large inputs. */
export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length * b.length > 4_000_000) {
    return [...a.map((line) => ({ op: "del" as const, line })), ...b.map((line) => ({ op: "add" as const, line }))];
  }
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", line: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
      out.push({ op: "del", line: a[i++]! });
    } else {
      out.push({ op: "add", line: b[j++]! });
    }
  }
  while (i < a.length) out.push({ op: "del", line: a[i++]! });
  while (j < b.length) out.push({ op: "add", line: b[j++]! });
  return out;
}

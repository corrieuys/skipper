// Shared response envelope for every /data/* route. One definition — the
// per-file copies this replaces had already started to drift.
export function ok(data: unknown, status: number = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

export function err(message: string, status: number = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

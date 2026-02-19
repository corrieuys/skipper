export function htmlResponse(content: string, status: number = 200): Response {
  return new Response(content, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function parseRequestBody<T extends Record<string, unknown> = Record<string, unknown>>(
  req: Request,
): Promise<T> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const body: Record<string, string> = {};
    formData.forEach((value, key) => {
      body[key] = value.toString();
    });
    return body as unknown as T;
  }
  return await req.json() as T;
}

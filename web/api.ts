export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!result.ok)
    throw new ApiError(
      result.error?.code || "request_failed",
      result.error?.message || "Request failed",
      result.error?.details,
    );
  return result.data;
}
export const nav = (url: string) => {
  history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

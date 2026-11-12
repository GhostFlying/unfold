import http from "node:http";
import { AppError, type AgentEvent } from "./types.js";
export function connectorRequest<T>(
  socketPath: string,
  token: string,
  method: string,
  params: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: "/rpc",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        timeout: 120_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (s) => {
          body += s;
          if (body.length > 40 * 1024 * 1024) {
            req.destroy();
            reject(
              new AppError(
                "response_too_large",
                "Connector response exceeded limit",
                502,
              ),
            );
          }
        });
        res.on("end", () => {
          try {
            const x = JSON.parse(body);
            if (!x.ok)
              reject(
                new AppError(
                  x.error?.code || "connector_error",
                  x.error?.message || "Connector failed",
                  res.statusCode || 502,
                  x.error?.details,
                ),
              );
            else resolve(x.data);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Connector timed out")));
    req.on("error", reject);
    req.end(JSON.stringify({ method, params }));
  });
}
export function connectorStream(
  socketPath: string,
  token: string,
  params: unknown,
  event: (value: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: "/agent",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        signal,
      },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (part) => {
          buffer += part;
          if (buffer.length > 8 * 1024 * 1024) {
            reject(new Error("Agent event exceeded limit"));
            req.destroy();
            return;
          }
          let at;
          while ((at = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            if (line)
              try {
                event(JSON.parse(line));
              } catch (e) {
                reject(e);
                req.destroy();
                return;
              }
          }
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200)
            reject(
              new AppError(
                "connector_error",
                "Could not start agent stream",
                502,
              ),
            );
          else resolve();
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(params));
  });
}

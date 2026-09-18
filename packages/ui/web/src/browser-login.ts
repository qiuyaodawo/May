export async function browserLogin(): Promise<string | undefined> {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("may-connect")) return undefined;
  const ticket = params.get("may-connect");
  history.replaceState(null, "", location.pathname + location.search);
  const response = await fetch("/api/ui/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("连接已失效，请从启动程序重新打开页面。");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string" || !/^[\x21-\x7e]{32,256}$/.test(body.token)) throw new Error("服务返回的连接凭据无效。");
  return body.token;
}

// Read-only Cloudflare and public HTTP verification. Never prints credentials.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve4, resolve6 } from "node:dns/promises";
const account = "0cfbb72c4eab7aaf66611ab26f2e9d75";
const zone = "bf943899cf00a7ea36f8d1f077b477d2";
const worker = "ai-session-chatroom";
const patterns = ["https://apiwx.net/chat", "https://apiwx.net/chat/*"];
const file = ".wrangler/deployment-baseline.json";
const after = process.argv.includes("--after");
try {
  const auth = JSON.parse(
    execFileSync("./node_modules/.bin/wrangler", ["auth", "token", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (!auth.token) throw new Error("Wrangler authentication unavailable");
  async function cloudflare(path) {
    const response = await fetch(
      "https://api.cloudflare.com/client/v4" + path,
      {
        headers: { Authorization: "Bearer " + auth.token },
        signal: AbortSignal.timeout(20000),
      },
    );
    const result = await response.json();
    return {
      status: response.status,
      success: result.success === true,
      result: result.result,
    };
  }
  async function probe(path) {
    const response = await fetch("https://apiwx.net" + path, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const result = {
      path,
      status: response.status,
      location: response.headers.get("location"),
      contentType: response.headers.get("content-type"),
      cloudflare: response.headers.has("cf-ray"),
    };
    await response.body?.cancel();
    return result;
  }
  const [zoneInfo, routes, dns, http, addresses] = await Promise.all([
    cloudflare("/zones/" + zone),
    cloudflare("/zones/" + zone + "/workers/routes"),
    cloudflare("/zones/" + zone + "/dns_records?name=apiwx.net"),
    Promise.all(["/", "/chat", "/chat/", "/chat-other"].map(probe)),
    Promise.allSettled([resolve4("apiwx.net"), resolve6("apiwx.net")]),
  ]);
  if (
    !zoneInfo.success ||
    zoneInfo.result.account.id !== account ||
    zoneInfo.result.status !== "active"
  )
    throw new Error("Target zone/account verification failed");
  if (!routes.success) throw new Error("Worker route inspection failed");
  const report = {
    checked_at: new Date().toISOString(),
    account_id: account,
    zone_id: zone,
    worker,
    expected_routes: patterns,
    routes: routes.result,
    dns_api_status: dns.status,
    dns_records: dns.success
      ? dns.result.map((record) => ({
          type: record.type,
          name: record.name,
          proxied: record.proxied,
        }))
      : null,
    public_addresses: addresses.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    ),
    http,
  };
  if (after) {
    const baseline = JSON.parse(await readFile(file, "utf8"));
    for (const path of ["/", "/chat-other"]) {
      const before = baseline.http.find((probe) => probe.path === path),
        now = http.find((probe) => probe.path === path);
      if (
        !before ||
        before.status !== now.status ||
        before.location !== now.location
      )
        throw new Error("Unrelated path changed: " + path);
    }
    const assigned = routes.result
      .filter((route) => route.script === worker)
      .map((route) => route.pattern)
      .sort();
    if (JSON.stringify(assigned) !== JSON.stringify([...patterns].sort()))
      throw new Error("Worker routes do not match the approved path scope");
    const unchanged = baseline.routes.filter(
      (route) => route.script !== worker,
    );
    for (const previous of unchanged)
      if (
        !routes.result.some(
          (route) =>
            route.id === previous.id &&
            route.pattern === previous.pattern &&
            route.script === previous.script,
        )
      )
        throw new Error("An unrelated Worker route changed");
    const health = await fetch("https://apiwx.net/chat/v1/health", {
      signal: AbortSignal.timeout(15000),
    });
    if (!health.ok || (await health.json()).status !== "ok")
      throw new Error("Deployed health check failed");
    if (
      http.find((probe) => probe.path === "/chat").location !== "/chat/" ||
      http.find((probe) => probe.path === "/chat/").status !== 200
    )
      throw new Error("Website routing check failed");
    await writeFile(
      ".wrangler/deployment-after.json",
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(
      "PASS: target routes, health, website, and unrelated-path baseline checks. Real login and multi-machine acceptance remain separate.",
    );
  } else {
    await mkdir(".wrangler", { recursive: true });
    // Preserve the original baseline; move it aside explicitly before starting a new deployment cycle.
    await writeFile(file, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(JSON.stringify(report, null, 2));
    console.log(
      "Read-only baseline saved. DNS API inspection: " +
        (dns.success
          ? "available"
          : "unavailable; verify proxied DNS in the dashboard before deployment") +
        ". No remote state changed.",
    );
  }
} catch (error) {
  const safe =
    error instanceof Error &&
    [
      "Target zone/account verification failed",
      "Worker route inspection failed",
      "Wrangler authentication unavailable",
      "Deployed health check failed",
      "Website routing check failed",
      "Worker routes do not match the approved path scope",
      "An unrelated Worker route changed",
    ].includes(error.message)
      ? error.message
      : "Preflight could not complete. Check Wrangler login, network, and the existing baseline file; no deployment was attempted.";
  console.error(safe);
  process.exitCode = 1;
}

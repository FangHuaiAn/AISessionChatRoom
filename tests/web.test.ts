import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
test("chat entry redirects to slash and serves a CSP-protected document", async () => {
  const redirect = await exports.default.fetch("https://apiwx.net/chat", {
    redirect: "manual",
  });
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get("Location")).toBe("/chat/");
  const response = await exports.default.fetch("https://apiwx.net/chat/");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "frame-ancestors 'none'",
  );
  const html = await response.text();
  expect(html).toContain("AI Session ChatRoom");
  expect(html).toContain("/chat/app.js");
});
test("static resources stay under the chat prefix", async () => {
  expect(
    (await exports.default.fetch("https://apiwx.net/chat/styles.css")).status,
  ).toBe(200);
  expect(
    (await exports.default.fetch("https://apiwx.net/styles.css")).status,
  ).toBe(404);
  expect(
    (await exports.default.fetch("https://apiwx.net/chat-other")).status,
  ).toBe(404);
});

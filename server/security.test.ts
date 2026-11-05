import { test, expect } from "bun:test";
import { guard } from "./security";

const req = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(url, init);

test("guard: hôte localhost ou IP accepté, nom de domaine refusé (DNS rebinding)", () => {
  expect(guard(req("http://127.0.0.1:7860/api/health"))).toBeUndefined();
  expect(guard(req("http://localhost:7860/api/health"))).toBeUndefined();
  expect(guard(req("http://192.168.0.20:7860/api/health"))).toBeUndefined();
  expect(guard(req("http://[::1]:7860/api/health"))).toBeUndefined();
  expect(guard(req("http://evil.example:7860/api/health"))?.status).toBe(403);
});

test("guard: Origin d'un autre site refusé, même origine acceptée", () => {
  const h = (origin: string) => ({ headers: { origin } });
  expect(guard(req("http://127.0.0.1:7860/ws", h("http://127.0.0.1:7860")))).toBeUndefined();
  expect(guard(req("http://127.0.0.1:7860/ws", h("https://evil.example")))?.status).toBe(403);
  expect(guard(req("http://127.0.0.1:7860/ws", h("http://localhost:7860")))?.status).toBe(403);
});

test("guard: écriture sans JSON refusée (CSRF par requête simple)", () => {
  const body = '{"port":1}';
  expect(guard(req("http://127.0.0.1:7860/api/settings", { method: "PATCH", body, headers: { "content-type": "text/plain" } }))?.status).toBe(415);
  expect(guard(req("http://127.0.0.1:7860/api/settings", { method: "POST", body }))?.status).toBe(415);
  expect(guard(req("http://127.0.0.1:7860/api/settings", { method: "PATCH", body, headers: { "content-type": "application/json; charset=utf-8" } }))).toBeUndefined();
  expect(guard(req("http://127.0.0.1:7860/api/server/stop", { method: "POST" }))).toBeUndefined(); // sans corps
});

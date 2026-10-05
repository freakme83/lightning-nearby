import assert from "node:assert/strict";
import test from "node:test";
import { NominatimReverseGeocoder, ReverseGeocodeError } from "./nominatim.ts";

test("sends one structured Turkish reverse request with an identifying User-Agent", async () => {
  let requestedUrl: URL | undefined;
  let requestHeaders: HeadersInit | undefined;
  const geocoder = new NominatimReverseGeocoder({ fetcher: async (input, init) => {
    requestedUrl = new URL(String(input));
    requestHeaders = init?.headers;
    return Response.json({ address: { neighbourhood: "Ayrancı", county: "Çankaya", state: "Ankara" }, addresstype: "neighbourhood" });
  } });
  const result = await geocoder.reverse(39.9, 32.8);
  assert.equal(requestedUrl?.searchParams.get("format"), "jsonv2");
  assert.equal(requestedUrl?.searchParams.get("addressdetails"), "1");
  assert.equal(requestedUrl?.searchParams.get("accept-language"), "tr");
  assert.match(new Headers(requestHeaders).get("User-Agent") ?? "", /lightning-nearby/i);
  assert.equal(result.displayLabel, "Ayrancı, Çankaya");
  assert.equal(result.latitude, 39.9);
  assert.equal(result.provider, "nominatim");
  assert.equal("providerAddress" in result, false, "normal output stays compact by default");
  const diagnostic = await geocoder.reverse(39.9, 32.8, { includeProviderHierarchy: true });
  assert.equal(diagnostic.displayLabel, result.displayLabel);
  assert.equal(diagnostic.providerAddress?.neighbourhood, "Ayrancı");
  assert.equal("road" in (diagnostic.providerAddress ?? {}), false);
});

test("reports provider HTTP status and malformed JSON distinctly", async () => {
  const http = new NominatimReverseGeocoder({ fetcher: async () => new Response("", { status: 429 }) });
  await assert.rejects(http.reverse(39, 32), (error: unknown) => error instanceof ReverseGeocodeError && error.code === "http" && error.status === 429);
  const malformed = new NominatimReverseGeocoder({ fetcher: async () => new Response("not-json") });
  await assert.rejects(malformed.reverse(39, 32), (error: unknown) => error instanceof ReverseGeocodeError && error.code === "malformed");
});

test("reports network failure and does not turn it into a location label", async () => {
  const failed = new NominatimReverseGeocoder({ fetcher: async () => { throw new Error("offline"); } });
  await assert.rejects(failed.reverse(39, 32), (error: unknown) => error instanceof ReverseGeocodeError && error.code === "network");
});

test("rejects invalid coordinates before making a request", async () => {
  let calls = 0;
  const geocoder = new NominatimReverseGeocoder({ fetcher: async () => { calls++; return Response.json({ address: { state: "Ankara" } }); } });
  await assert.rejects(geocoder.reverse(91, 32), RangeError);
  assert.equal(calls, 0);
});

/**
 * Tests for the privacy-preserving witness geolocation helper.
 *
 * Hard rules enforced by these tests:
 *   - Coordinates resolve to <= 1 decimal place (city centroid, ~11km).
 *   - Per-IP lookups cached for 24h; cache hits never touch the geoip DB.
 *   - Unrecognised IPs (loopback, RFC1918, lookup miss) return null without
 *     throwing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  lookupGeo,
  hashIpForObservation,
  __test__resetGeoCache,
  __test__setGeoLookupImpl,
} from "../witness_geo.js";

describe("witness_geo.lookupGeo", () => {
  beforeEach(() => {
    __test__resetGeoCache();
  });

  test("returns null for loopback addresses", () => {
    expect(lookupGeo("127.0.0.1")).toBeNull();
    expect(lookupGeo("::1")).toBeNull();
  });

  test("returns null for RFC1918 private ranges", () => {
    expect(lookupGeo("10.0.0.5")).toBeNull();
    expect(lookupGeo("192.168.1.42")).toBeNull();
    expect(lookupGeo("172.16.0.1")).toBeNull();
  });

  test("returns null when geoip lookup misses", () => {
    __test__setGeoLookupImpl(() => null);
    expect(lookupGeo("8.8.8.8")).toBeNull();
  });

  test("rounds lat/lng to one decimal place", () => {
    __test__setGeoLookupImpl(() => ({
      country: "US",
      region: "CA",
      city: "Mountain View",
      ll: [37.42199999, -122.08400001] as [number, number],
    }));
    const out = lookupGeo("8.8.8.8");
    expect(out).not.toBeNull();
    expect(out!.lat).toBe(37.4);
    expect(out!.lng).toBe(-122.1);
  });

  test("returns city + country + region labels", () => {
    __test__setGeoLookupImpl(() => ({
      country: "DE",
      region: "BE",
      city: "Berlin",
      ll: [52.52, 13.4] as [number, number],
    }));
    const out = lookupGeo("1.2.3.4");
    expect(out).toEqual({
      city: "Berlin",
      region: "BE",
      country: "DE",
      lat: 52.5,
      lng: 13.4,
    });
  });

  test("falls back to '' for missing city field", () => {
    __test__setGeoLookupImpl(() => ({
      country: "US",
      region: "",
      city: "",
      ll: [37.7, -97.8] as [number, number],
    }));
    const out = lookupGeo("8.8.8.8");
    expect(out).not.toBeNull();
    expect(out!.city).toBe("");
    expect(out!.country).toBe("US");
  });

  test("caches a hit and re-uses it without a second lookup", () => {
    const impl = vi.fn(() => ({
      country: "US",
      region: "CA",
      city: "San Jose",
      ll: [37.3, -121.9] as [number, number],
    }));
    __test__setGeoLookupImpl(impl);

    const a = lookupGeo("8.8.8.8");
    const b = lookupGeo("8.8.8.8");
    expect(a).toEqual(b);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  test("cache miss after TTL expiry triggers a re-lookup", () => {
    let realNow = Date.UTC(2026, 0, 1, 0, 0, 0);
    const impl = vi.fn(() => ({
      country: "US",
      region: "CA",
      city: "San Jose",
      ll: [37.3, -121.9] as [number, number],
    }));
    __test__setGeoLookupImpl(impl);

    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow);
    try {
      lookupGeo("9.9.9.9");
      realNow += 23 * 3600 * 1000; // 23h later — still cached
      lookupGeo("9.9.9.9");
      expect(impl).toHaveBeenCalledTimes(1);
      realNow += 2 * 3600 * 1000; // total 25h — TTL has expired
      lookupGeo("9.9.9.9");
      expect(impl).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("caches null misses to avoid hammering geoip on bad IPs", () => {
    const impl = vi.fn(() => null);
    __test__setGeoLookupImpl(impl);
    expect(lookupGeo("8.8.8.8")).toBeNull();
    expect(lookupGeo("8.8.8.8")).toBeNull();
    expect(impl).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    // Don't leak vi.fn impls between tests.
    __test__setGeoLookupImpl(null);
    __test__resetGeoCache();
  });
});

describe("witness_geo.hashIpForObservation", () => {
  test("produces 64-char hex digest", () => {
    const h = hashIpForObservation("8.8.8.8", "salt-a");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same ip + same salt → same digest", () => {
    expect(hashIpForObservation("8.8.8.8", "salt-a")).toEqual(
      hashIpForObservation("8.8.8.8", "salt-a"),
    );
  });

  test("same ip + different salt → different digest", () => {
    expect(hashIpForObservation("8.8.8.8", "salt-a")).not.toEqual(
      hashIpForObservation("8.8.8.8", "salt-b"),
    );
  });

  test("different ip + same salt → different digest", () => {
    expect(hashIpForObservation("8.8.8.8", "salt-a")).not.toEqual(
      hashIpForObservation("1.1.1.1", "salt-a"),
    );
  });
});

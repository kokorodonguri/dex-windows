import { describe, expect, it } from "vitest";
import { hasSeenSessionGuide, markSessionGuideSeen, SESSION_GUIDE_KEY } from "./SessionGuide";

describe("session guide persistence", () => {
  it("is unseen until the versioned completion marker is written", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(hasSeenSessionGuide(storage)).toBe(false);
    markSessionGuideSeen(storage);
    expect(values.get(SESSION_GUIDE_KEY)).toBe("done");
    expect(hasSeenSessionGuide(storage)).toBe(true);
  });

  it("does not accept stale or unrelated values", () => {
    expect(hasSeenSessionGuide({ getItem: () => "true" })).toBe(false);
    expect(hasSeenSessionGuide({ getItem: () => null })).toBe(false);
  });
});

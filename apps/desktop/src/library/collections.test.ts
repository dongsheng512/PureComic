import { describe, expect, it } from "vitest";
import { buildShelf, continueVolume } from "./collections";
import type { LibraryCollection, LibraryEntry } from "../types";

function book(partial: Partial<LibraryEntry> & Pick<LibraryEntry, "id" | "title">): LibraryEntry {
  return {
    path: `/${partial.id}`,
    kind: "cbz",
    pageCount: 10,
    lastReadPage: 0,
    addedAt: "2026-01-01T00:00:00Z",
    enhanceState: "none",
    missing: false,
    ...partial,
  };
}

describe("buildShelf", () => {
  it("shows one card for a collection and hides its volumes", () => {
    const a = book({ id: "a", title: "卷一" });
    const b = book({ id: "b", title: "卷二", lastOpenedAt: "2026-02-01T00:00:00Z" });
    const loose = book({ id: "c", title: "别的" });
    const collection: LibraryCollection = {
      id: "col",
      title: "一部",
      entryIds: ["a", "b"],
    };
    const shelf = buildShelf({
      entries: [a, b, loose],
      collections: [collection],
      query: "",
      filter: "all",
      sort: "title",
      progressOf: (e) => e.lastReadPage,
    });
    expect(shelf).toHaveLength(2);
    expect(shelf.some((item) => item.kind === "book" && item.entry.id === "c")).toBe(true);
    expect(shelf.some((item) => item.kind === "collection")).toBe(true);
    expect(continueVolume([a, b])?.id).toBe("b");
  });
});

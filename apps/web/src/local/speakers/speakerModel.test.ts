import { describe, expect, it } from "vitest";
import {
  applyDraft,
  canMergeOrHide,
  cleanNames,
  draftSavable,
  EMPTY_DRAFT,
  letterFor,
  mergeSpeaker,
  reassignLine,
  rebaseDraft,
  sameDraft,
  setNotSpeaker,
  speakerNameProblem,
  unmergeSpeaker,
} from "./speakerModel.ts";

const ASSIGNED = { a: "S1", b: "S2", c: "S3", d: null };

describe("speaker draft model", () => {
  it("labels S1…S26 with letters and keeps generic ids beyond", () => {
    expect([letterFor("S1"), letterFor("S2"), letterFor("S26"), letterFor("S27")]).toEqual([
      "A",
      "B",
      "Z",
      "S27",
    ]);
  });

  it("applies the worker's precedence: line, then merge, then not-a-speaker", () => {
    let draft = mergeSpeaker(EMPTY_DRAFT, "S3", "S1");
    draft = setNotSpeaker(draft, "S2", true);
    draft = reassignLine(draft, "d", "S1");
    expect(applyDraft(ASSIGNED, draft)).toEqual({ a: "S1", b: null, c: "S1", d: "S1" });
    expect(ASSIGNED).toEqual({ a: "S1", b: "S2", c: "S3", d: null }); // originals untouched
  });

  it("never produces chains, hidden merges or lines pointing at hidden speakers", () => {
    const merged = mergeSpeaker(EMPTY_DRAFT, "S2", "S1");
    expect(canMergeOrHide(merged, "S1")).toBe(false);
    expect(mergeSpeaker(merged, "S1", "S3")).toBe(merged); // S1 is a target: no chain
    expect(mergeSpeaker(merged, "S3", "S2")).toBe(merged); // S2 merged away: not a target
    expect(setNotSpeaker(merged, "S1", true)).toBe(merged);
    const withLine = reassignLine(EMPTY_DRAFT, "a", "S3");
    expect(setNotSpeaker(withLine, "S3", true).lines).toEqual({});
    const moved = mergeSpeaker(reassignLine(EMPTY_DRAFT, "a", "S2"), "S2", "S1");
    expect(moved.lines).toEqual({ a: "S1" });
    expect(unmergeSpeaker(moved, "S2").merges).toEqual({});
    expect(draftSavable(moved)).toBe(true);
  });

  it("checks names like the worker and compares drafts by what they would save", () => {
    expect(speakerNameProblem("")).toBeNull();
    expect(speakerNameProblem("x".repeat(61))).not.toBeNull();
    expect(speakerNameProblem("a\u0007")).not.toBeNull();
    expect(cleanNames({ S1: "  Host ", S2: "  " })).toEqual({ S1: "Host" });
    expect(
      sameDraft(
        { ...EMPTY_DRAFT, names: { S1: "Host " } },
        { ...EMPTY_DRAFT, names: { S1: "Host" } },
      ),
    ).toBe(true);
    expect(sameDraft(EMPTY_DRAFT, { ...EMPTY_DRAFT, notSpeaker: ["S1"] })).toBe(false);
    expect(draftSavable({ ...EMPTY_DRAFT, names: { S1: "x".repeat(61) } })).toBe(false);
  });
});

describe("three-way rebase after a revision conflict", () => {
  const base = { names: { S1: "Host" }, merges: {}, notSpeaker: [], lines: { a: "S2" } };

  it("keeps changes to different fields from both sides", () => {
    const theirs = { ...base, names: { S1: "Host", S2: "Guest" }, notSpeaker: ["S3"] };
    const mine = { ...base, names: { S1: "Host 2" }, lines: { a: "S2", b: null } };
    expect(rebaseDraft(base, theirs, mine)).toEqual({
      draft: {
        names: { S1: "Host 2", S2: "Guest" },
        merges: {},
        notSpeaker: ["S3"],
        lines: { a: "S2", b: null },
      },
      conflicts: [],
    });
  });

  it("agrees when both sides made the same change, and flags different ones", () => {
    const same = { ...base, names: { S1: "Same" } };
    expect(rebaseDraft(base, same, { ...same, names: { S1: " Same " } }).conflicts).toEqual([]);
    const theirs = { ...base, names: { S1: "Theirs" }, lines: {} };
    const mine = { ...base, names: { S1: "Mine" }, lines: { a: "S3" } };
    expect(rebaseDraft(base, theirs, mine).conflicts).toEqual([
      { kind: "name", key: "S1" },
      { kind: "line", key: "a" },
    ]);
  });

  it("flags a combination the rules don't allow even when no field clashes", () => {
    const theirs = { ...base, merges: { S2: "S1" } }; // they merged S2 away
    const mine = { ...base, names: { S1: "Host", S2: "Guest" } }; // I named S2
    expect(rebaseDraft(base, theirs, mine).conflicts).toEqual([{ kind: "rules", key: "" }]);
  });
});

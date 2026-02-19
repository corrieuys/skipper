import { describe, it, expect } from "bun:test";
import { deduplicateOverlap } from "./dedup";

describe("deduplicateOverlap", () => {
  it("removes exact overlapping prefix from current text", () => {
    const prev = "the customer asked about pricing and discounts";
    const curr = "about pricing and discounts for the enterprise plan";
    expect(deduplicateOverlap(prev, curr)).toBe("for the enterprise plan");
  });

  it("returns current text unchanged when there is no overlap", () => {
    const prev = "hello world";
    const curr = "completely different sentence";
    expect(deduplicateOverlap(prev, curr)).toBe("completely different sentence");
  });

  it("returns current text when previous is empty", () => {
    expect(deduplicateOverlap("", "some text here")).toBe("some text here");
  });

  it("returns current text when current is empty", () => {
    expect(deduplicateOverlap("some text", "")).toBe("");
  });

  it("handles punctuation differences in matching", () => {
    const prev = "end of the sentence.";
    const curr = "of the sentence, and then something new";
    expect(deduplicateOverlap(prev, curr)).toBe("and then something new");
  });

  it("handles case differences in matching", () => {
    const prev = "The Quick Brown Fox";
    const curr = "the quick brown fox jumps over the lazy dog";
    expect(deduplicateOverlap(prev, curr)).toBe("jumps over the lazy dog");
  });

  it("does not strip single-word matches (false positive risk)", () => {
    const prev = "the customer said hello";
    const curr = "hello everyone welcome to the meeting";
    // "hello" is only 1 word match — should not strip
    expect(deduplicateOverlap(prev, curr)).toBe(
      "hello everyone welcome to the meeting",
    );
  });

  it("strips two-word matches (minimum threshold)", () => {
    const prev = "let me check that for you";
    const curr = "for you and I will get back shortly";
    expect(deduplicateOverlap(prev, curr)).toBe("and I will get back shortly");
  });

  it("handles full overlap (current is subset of previous tail)", () => {
    const prev = "one two three four five";
    const curr = "three four five";
    // Everything in curr matches the tail of prev
    expect(deduplicateOverlap(prev, curr)).toBe("three four five");
    // Returns original since stripping everything would leave empty
  });

  it("handles whitespace-only inputs", () => {
    expect(deduplicateOverlap("   ", "some text")).toBe("some text");
    expect(deduplicateOverlap("some text", "   ")).toBe("   ");
  });

  it("respects maxOverlapWords parameter", () => {
    const prev = "a b c d e f g h i j";
    const curr = "f g h i j k l m";
    // With maxOverlapWords=3, only last 3 words of prev ("h i j") are considered
    expect(deduplicateOverlap(prev, curr, 3)).toBe("f g h i j k l m");
    // With default (30), the full overlap is found
    expect(deduplicateOverlap(prev, curr)).toBe("k l m");
  });

  it("handles realistic transcription overlap", () => {
    const prev =
      "so we need to finalize the budget before the end of the quarter and make sure all departments have submitted their reports";
    const curr =
      "end of the quarter and make sure all departments have submitted their reports the next step is to schedule the review meeting";
    expect(deduplicateOverlap(prev, curr)).toBe(
      "the next step is to schedule the review meeting",
    );
  });
});

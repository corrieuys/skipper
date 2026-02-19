#!/usr/bin/env bun
import { runBraceExtractor } from "./lib/structured-extractor";

runBraceExtractor({
  language: "golang",
  containerKeywords: ["struct", "interface", "type"],
  methodKeywordStyle: "brace",
});

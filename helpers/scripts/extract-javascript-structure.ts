#!/usr/bin/env bun
import { runBraceExtractor } from "./lib/structured-extractor";

runBraceExtractor({
  language: "javascript",
  containerKeywords: ["class"],
  methodKeywordStyle: "brace",
});

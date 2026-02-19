#!/usr/bin/env bun
import { runBraceExtractor } from "./lib/structured-extractor";

runBraceExtractor({
  language: "java",
  containerKeywords: ["class", "interface", "enum", "record"],
  methodKeywordStyle: "brace",
});

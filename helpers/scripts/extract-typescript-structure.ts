#!/usr/bin/env bun
import { runBraceExtractor } from "./lib/structured-extractor";

runBraceExtractor({
  language: "typescript",
  containerKeywords: ["class", "interface", "type", "enum", "namespace"],
  methodKeywordStyle: "brace",
});

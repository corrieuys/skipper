import { describe, expect, it } from "bun:test";
import { extractBraceLanguage } from "./structured-extractor";

describe("extractBraceLanguage", () => {
    it("extracts functions and types from a TypeScript file", () => {
        const result = extractBraceLanguage({
            filePath: "/tmp/example.ts",
            language: "typescript",
            containerKeywords: ["class", "interface", "type", "enum", "namespace"],
            source: [
                "type Person = {",
                "  name: string;",
                "};",
                "",
                "function greet(name: string): string {",
                "  return name;",
                "}",
            ].join("\n"),
        });

        expect(result.logicalParts.some((part) => part.kind === "type" && part.name === "Person")).toBe(true);
        expect(result.logicalParts.some((part) => part.kind === "function" && part.name === "greet")).toBe(true);
    });

    it("extracts class and method from Java", () => {
        const result = extractBraceLanguage({
            filePath: "/tmp/Example.java",
            language: "java",
            containerKeywords: ["class", "interface", "enum", "record"],
            source: [
                "public class Example {",
                "  public String greet(String name) {",
                "    return name;",
                "  }",
                "}",
            ].join("\n"),
        });

        expect(result.logicalParts.some((part) => part.kind === "class" && part.name === "Example")).toBe(true);
        expect(result.logicalParts.some((part) => part.kind === "method" && part.name === "greet" && part.parent === "Example")).toBe(true);
    });

    it("extracts struct type and receiver method from Go", () => {
        const result = extractBraceLanguage({
            filePath: "/tmp/example.go",
            language: "golang",
            containerKeywords: ["struct", "interface", "type"],
            source: [
                "package main",
                "",
                "type Example struct {}",
                "",
                "func (e Example) Greet(name string) string {",
                "  return name",
                "}",
            ].join("\n"),
        });

        expect(result.logicalParts.some((part) => part.kind === "type" && part.name === "Example")).toBe(true);
        expect(result.logicalParts.some((part) => part.kind === "method" && part.name === "Greet" && part.parent === "Example")).toBe(true);
    });

    it("extracts class, method, and top-level function from JavaScript", () => {
        const result = extractBraceLanguage({
            filePath: "/tmp/example.js",
            language: "javascript",
            containerKeywords: ["class"],
            source: [
                "class Example {",
                "  greet(name) {",
                "    return name;",
                "  }",
                "}",
                "",
                "function helper(flag) {",
                "  return flag ? 1 : 0;",
                "}",
            ].join("\n"),
        });

        expect(result.logicalParts.some((part) => part.kind === "class" && part.name === "Example")).toBe(true);
        expect(result.logicalParts.some((part) => part.kind === "method" && part.name === "greet" && part.parent === "Example")).toBe(true);
        expect(result.logicalParts.some((part) => part.kind === "function" && part.name === "helper")).toBe(true);
    });
});

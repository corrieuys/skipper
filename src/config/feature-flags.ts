export function isExperimental(): boolean {
  return process.argv.includes("--experimental");
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

interface PackageManifest {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  pi: { extensions: string[] };
}

const manifest: PackageManifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

it.each([
  "@sinclair/typebox",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
])("shares host package %s through a wildcard peer", packageName => {
  expect(manifest.dependencies).not.toHaveProperty(packageName);
  expect(manifest.peerDependencies[packageName]).toBe("*");
  expect(manifest.devDependencies[packageName]).toBeTruthy();
});

it("keeps the compiled fork entry", () => {
  expect(manifest.pi.extensions).toEqual(["./dist/index.js"]);
});

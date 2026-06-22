// Bundles the extension (and its node dependencies, e.g. ssh2) into a single
// CommonJS file that VSCodium can load. The `vscode` module is provided by the
// host at runtime and must stay external.
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

// ssh2 charge des bindings natifs optionnels (cpu-features, sshcrypto.node)
// via des require() protégés par try/catch. esbuild ne sait pas empaqueter les
// fichiers .node : on les laisse externes pour que ssh2 bascule sur son
// implémentation en JavaScript pur.
const externalNativePlugin = {
  name: "external-native-bindings",
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "cpu-features"],
  plugins: [externalNativePlugin],
  format: "cjs",
  platform: "node",
  target: "node16",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching…");
  } else {
    await esbuild.build(options);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

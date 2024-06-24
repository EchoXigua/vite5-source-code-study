import { defineConfig } from "rollup";
import path from "node:path";
import typescript from "@rollup/plugin-typescript";

export default defineConfig({
  input: path.resolve(__dirname, "src/index.ts"),
  output: {
    file: path.resolve(__dirname, "dist", "index.mjs"),
  },
  plugins: [
    typescript({
      tsconfig: path.resolve(__dirname, "tsconfig.json"),
    }),
  ],
});

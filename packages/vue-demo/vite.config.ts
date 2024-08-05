import vue from "@vitejs/plugin-vue";
import typescript from "@rollup/plugin-typescript";

export default {
  root: "./",
  plugins: [vue(), typescript()],
  server: {
    open: true,
  },
};

console.log("vite config");

// vite 在读取的时候只会读取默认导出的
export default {
  name: "vite config",
  root: "/",
  server: {
    open: true,
  },
};

export const version = "1.0.0";

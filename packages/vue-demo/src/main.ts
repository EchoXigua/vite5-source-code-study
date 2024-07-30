import { createApp } from "vue";
import root from "./App.vue";
import router from "./router/index.js";

const app = createApp(root);
app.use(router);

app.mount("#app");

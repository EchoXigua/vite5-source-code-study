import { createRouter, createWebHistory } from "vue-router";

const routes = [
  {
    path: "/", //登录页
    name: "dashboard",
    redirect: "/home",
    children: [
      {
        path: "home", //首页
        name: "home",
        component: () => import("../views/Home.vue"),
      },
      {
        path: "about",
        name: "about",
        component: () => import("../views/About.vue"),
      },
    ],
  },
];

const router = createRouter({
  routes,
  history: createWebHistory(),
});

export default router;

<template>
  <div>App.vue</div>
  <router-link to="/about">about</router-link>
  &nbsp;
  <router-link to="/home">home</router-link>
  <div style="border: 2px solid pink; margin: 20px auto">
    <router-view></router-view>
  </div>
  <!-- <div>
    <span>{{ sum }}</span>
    <button @click="add">+</button>
    <button @click="minus">-</button>
  </div> -->
</template>

<script setup lang="ts">
import { ref } from "vue";
const sum = ref(0);

const add = () => {
  sum.value++;
};

const minus = () => {
  sum.value--;
};
</script>

<style scoped></style>

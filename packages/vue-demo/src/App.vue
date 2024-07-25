<template>
  <div>App.vue</div>
  <div>
    <span>{{ sum }}</span>
    <button @click="add">+</button>
    <button @click="minus">-</button>
  </div>
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

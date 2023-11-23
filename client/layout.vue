<template>
  <k-layout>
    <div class="container">
      <div class="search">
        <el-input v-model="keyword" placeholder="Type keywords..." #suffix>
          <k-icon name="search"></k-icon>
        </el-input>
      </div>

      <el-scrollbar class="fonts-list" ref="root">
        <el-collapse>
          <template v-for="font in fonts">
            <el-collapse-item>
              <template #title>
                {{ font.name }} / {{ font.size }}
              </template>

              <!-- TODO: add more operations -->
              <div>{{ font.paths }}</div>
            </el-collapse-item>
          </template>
        </el-collapse>
      </el-scrollbar>
    </div>
  </k-layout>
</template>

<script lang="ts" setup>
import { store } from '@koishijs/client'
import { ref } from 'vue'

const keyword = ref('')

const fonts = store.fonts.filter((font) => {
  return font.name.includes(keyword.value)
})
</script>

<style lang="scss" scoped>
.container {
  max-width: 768px;
  height: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

.search {
  width: 100%;
  padding: 20px;
}
.fonts-list {
  width: 100%;
  height: 100%;
  padding: 0 20px 20px 20px;
  overflow: auto;
}
</style>

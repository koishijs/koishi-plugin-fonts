<template>
  <k-layout>
    <div class="container">
      <div class="flex items-center px-4">
        <el-input class="flex-1" v-model="keyword" placeholder="输入关键词搜索…" #suffix>
          <k-icon name="search"></k-icon>
        </el-input>

        <el-button>新建下载</el-button>
      </div>

      <!-- Download -->
      <template v-if="Object.keys(downloads).length">
        <el-card class="mb-4">
          <template #header>
            <div class="text-bold">下载中</div>
          </template>
          <el-scrollbar class="fonts-list" ref="downloadsRef">
            <template v-for="download in downloads">
              <div class="mb-4">
                <span class="mr-4">{{ download.name }}</span>
                <!-- TODO: implement cancel feature -->
                <!-- <el-button @click="cancel(download)">取消</el-button> -->
              </div>
              <template v-for="file in download.files">
                <div>
                  <el-progress
                    :percentage="file.contentLength ? (file.downloaded / file.contentLength) * 100 : 0"
                  />
                </div>
              </template>
            </template>
          </el-scrollbar>
        </el-card>
      </template>

      <el-scrollbar class="fonts-list" ref="rootRef">
        <el-collapse>
          <template v-for="font in fonts">
            <el-collapse-item v-show="font.name.includes(keyword)">
              <template #title> {{ font.name }} / {{ font.size }} </template>

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
import { store, send } from '@koishijs/client'
import { ref } from 'vue'

import type { } from '..'

const keyword = ref('')

const fonts = store.fonts.fonts

const downloads = store.fonts.downloads

type Download = typeof store.fonts.downloads[0]

function cancel(download: Download) {
  send('fonts/cancel', download.name)
}
</script>

<style lang="scss" scoped>
.container {
  max-width: 768px;
  height: 100%;
  margin: 0 auto;
}

.container * {
  box-sizing: border-box;
}

.fonts-list {
  width: 100%;
  height: 100%;
  overflow: auto;
}
</style>

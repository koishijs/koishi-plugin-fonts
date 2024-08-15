<template>
  <k-layout>
    <div class="container">
      <div class="my-4 flex items-center px-4">
        <el-input class="flex-1" v-model="keyword" placeholder="输入关键词搜索…" #suffix>
          <k-icon name="search"></k-icon>
        </el-input>

        <el-button class="ml-4" @click="showDialog = true">新建下载</el-button>
      </div>

      <el-dialog v-model="showDialog">
        <template #title>新建下载</template>
        <template #default>
          <el-input class="my-2" v-model="newDownload.name" placeholder="输入字体名称" />
          <el-input class="my-2" v-model="newDownload.urls" placeholder="输入下载链接，以空行分隔不同路径" type="textarea" :autosize="{ minRows: 4, maxRows: 16 }" />
        </template>
        <template #footer>
          <el-button @click="resetNewDownload">取消</el-button>
          <el-button type="primary" @click="createDownload">确定</el-button>
        </template>
      </el-dialog>

      <!-- Download -->
      <template v-if="Object.keys(store.fonts.downloads).length">
        <el-card class="mb-4">
          <template #header>
            <div class="text-bold">下载中</div>
          </template>
          <el-scrollbar class="fonts-list" ref="downloadsRef">
            <template v-for="download in store.fonts.downloads">
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
        <template v-if="store.fonts.fonts.length === 0">
          <el-empty description="暂无字体" />
        </template>
        <el-collapse>
          <template v-for="font in store.fonts.fonts">
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
import { send, store } from '@koishijs/client'
import { reactive, ref } from 'vue'

import type { ElDialog } from 'element-plus'
import type { } from '..'

const keyword = ref('')

const showDialog = ref(false)

const newDownload = reactive({
  name: '',
  urls: '',
})

function resetNewDownload() {
  newDownload.name = ''
  newDownload.urls = ''
  showDialog.value = false
}

function createDownload() {
  send('fonts/download', newDownload.name, newDownload.urls.split('\n'))
  resetNewDownload()
}

type Download = typeof store.fonts.downloads[0]

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

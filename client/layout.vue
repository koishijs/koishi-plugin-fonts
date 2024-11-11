<script lang="ts" setup>
import { send, store } from '@koishijs/client'
import { reactive, ref } from 'vue'

import type {} from 'element-plus'
import type {} from '../lib'

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

const disable = (download: Download) =>
  download.files.some((file) => file.contentLength > 0 && file.downloaded === file.contentLength)

async function cancel(download: Download) {
  send('fonts/cancel', download.name, [])
}

async function deleteFonts(name, paths) {
  send('fonts/delete', name, paths)
}
</script>

<template>
  <k-layout>
    <div class="container">
      <div class="my-4 flex items-center px-4">
        <el-input class="flex-1" v-model="keyword" placeholder="输入关键词搜索…" #suffix>
          <k-icon name="search" />
        </el-input>

        <el-button class="ml-4" @click="showDialog = true">新建下载</el-button>
      </div>

      <el-dialog v-model="showDialog">
        <template #title>新建下载</template>
        <template #default>
          <el-input class="my-2" v-model="newDownload.name" placeholder="输入字体名称" />
          <el-input class="my-2"
                    v-model="newDownload.urls"
                    placeholder="输入下载链接，以空行分隔不同路径"
                    type="textarea"
                    :autosize="{ minRows: 4, maxRows: 16 }" />
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
                <!-- TODO: implement a fine-grained cancel feature -->
                <el-button :disabled="disable(download)" :plain="disable(download)" @click="cancel(download)">
                  取消
                </el-button>
              </div>
              <template v-for="file in download.files">
                <div>
                  <el-progress
                    :percentage="file.contentLength ? Math.floor((file.downloaded / file.contentLength) * 100) : 0" />
                </div>
              </template>
            </template>
          </el-scrollbar>
        </el-card>
      </template>

      <!-- TODO: use a better table -->
      <el-scrollbar class="fonts-list" ref="rootRef">
        <template v-if="store.fonts.fonts.length === 0">
          <el-empty description="暂无字体" />
        </template>
        <el-collapse>
          <template v-for="font in store.fonts.fonts">
            <el-collapse-item v-show="font.name.includes(keyword)">
              <template #title>
                {{ font.name }} / {{ font.size }}
                <el-button @click="deleteFonts(font.name, [])" plain>删除</el-button>
              </template>
              <div v-for="path in font.paths">
                {{ path }}
                <el-button @click="deleteFonts(font.name, [path])" plain>删除</el-button>
              </div>
            </el-collapse-item>
          </template>
        </el-collapse>

        <!-- <el-table :data="store.fonts.fonts" class="fonts-list" ref="rootRef">
          <el-table-column type="expand">
            <template #default="scope">
              <ul m="4">
                <li v-for="(path, index) in scope.row.paths" :key="index">
                  <div>{{ path }}</div>
                  <el-button @click="" plain>删除</el-button>
                </li>
              </ul>
            </template>
          </el-table-column>
          <el-table-column label="Name" prop="name" />
          <el-table-column label="size" prop="size" />
          <el-table-column label="options">
            <template #default>
              <el-button @click="" plain>删除</el-button>
            </template>
          </el-table-column>
        </el-table> -->
      </el-scrollbar>
    </div>
  </k-layout>
</template>

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

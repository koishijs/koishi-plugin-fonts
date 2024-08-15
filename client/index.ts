import { Context } from '@koishijs/client'
import layout from './layout.vue'
import 'uno.css'

export default (ctx: Context) => {
  ctx.page({
    name: '字体管理',
    path: '/fonts',
    component: layout,
    fields: ['fonts'],
  })
}

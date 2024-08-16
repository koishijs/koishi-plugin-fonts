import haixee from '@haixee/eslint-config'

export default [
  ...[
    ...[
      ...haixee.configs.base,
      ...haixee.configs.typescript,
    ]
      .filter((config) => {
        if (!config.rules) return true
        return !Object.keys(config.rules).some(c => c.includes('@typescript-eslint/no-namespace'))
      })
      .map((config) => ({
        ...config,
        files: [...(config.files || []), "src/*.ts", "client/*.ts"],
      })),
    ...haixee.configs.vue
      .filter((config) => {
        if (!config.rules) return true
        return !Object.keys(config.rules)
          .some(
            c => c.includes('unocss')
              || c.includes('vue/valid-v-for')
              || c.includes('vue/require-v-for-key')
              || c.includes('vue/multi-word-component-names')
          )
      })
  ]
    .map((config) => ({
      ...config,
      files: [...(config.files || []), "client/*.vue"],
      ignores: [...(config.ignores || []), "external/**", "temp/**", "dist/**", "lib/**", "**/*.mjs"],
    })),
]

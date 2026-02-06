import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'http://localhost:4321',
  output: 'static',
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },
  },
});

import { cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import type { PluginOption, UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(async ({ mode }): Promise<UserConfig> => {
  const plugins: PluginOption[] = [react(), tailwindcss()];
  // The Student Portal is a standalone static page in the subfolder. Copy it beside the built Teacher
  // App so `/student-hub/` works on GitHub Pages, Vercel and `vite preview` with relative asset paths.
  plugins.push({
    name: 'copy-student-hub',
    apply: 'build',
    async closeBundle() {
      await cp(resolve(process.cwd(), 'student-hub'), resolve(process.cwd(), 'dist/student-hub'), { recursive: true, force: true });
    },
  });
  try {
    // Optional local tooling (git-ignored, absent in a clean checkout): adds data-source
    // attributes to DOM nodes for the visual editor. Never required to build or deploy.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- the file does not exist in a clean checkout
    const m = await import('./.vite-source-tags.js');
    plugins.push(m.sourceTags());
  } catch {
    // not present — nothing to do
  }

  const env = loadEnv(mode, process.cwd(), ['VITE_', 'NEXT_PUBLIC_']);
  const processEnvDefines: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    processEnvDefines[`process.env.${key}`] = JSON.stringify(value);
  }

  return {
    base: './',
    plugins,
    // Bind on all interfaces and accept proxied preview hosts (e.g. *.e2b.app).
    server: {
      host: true,
      port: 5173,
      allowedHosts: true,
    },
    preview: {
      host: true,
      port: 4173,
      allowedHosts: true,
    },
    build: {
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        output: {
          // Separate, long-cached vendor files: an app update re-downloads only the small app chunk.
          manualChunks(id: string) {
            if (id.includes('node_modules/framer-motion') || id.includes('node_modules/motion-')) return 'motion'
            if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react'
            if (id.includes('node_modules/lucide-react')) return 'icons'
          },
        },
      },
    },
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: processEnvDefines,
  };
})

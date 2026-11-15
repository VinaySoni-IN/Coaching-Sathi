/// <reference types="vite/client" />

/* Only the public (anon) values belong here; the service-role key must never reach the browser. */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

/** Langue d'un bloc Markdown → grammaire shiki ; une langue absente reste en texte brut. */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  json: "json",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  python: "python",
  py: "python",
  rust: "rust",
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  html: "html",
  css: "css",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  markdown: "markdown",
  md: "markdown",
  diff: "diff",
}

let instance: Promise<HighlighterCore> | null = null

function highlighter(): Promise<HighlighterCore> {
  instance ??= createHighlighterCore({
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/tsx.mjs"),
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/jsx.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/bash.mjs"),
      import("shiki/langs/python.mjs"),
      import("shiki/langs/rust.mjs"),
      import("shiki/langs/go.mjs"),
      import("shiki/langs/c.mjs"),
      import("shiki/langs/cpp.mjs"),
      import("shiki/langs/html.mjs"),
      import("shiki/langs/css.mjs"),
      import("shiki/langs/sql.mjs"),
      import("shiki/langs/yaml.mjs"),
      import("shiki/langs/toml.mjs"),
      import("shiki/langs/markdown.mjs"),
      import("shiki/langs/diff.mjs"),
    ],
    engine: createJavaScriptRegexEngine(),
  })
  return instance
}

/**
 * HTML coloré (thèmes clair et sombre en variables CSS, choisis par index.css selon la classe .dark), ou null pour une
 * langue inconnue.
 */
export async function highlight(code: string, lang: string | undefined): Promise<string | null> {
  const id = lang ? ALIASES[lang.toLowerCase()] : undefined
  if (!id) return null
  const h = await highlighter()
  return h.codeToHtml(code, { lang: id, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false })
}

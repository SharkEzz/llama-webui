# llama-webui

To install dependencies:

```bash
bun install
```

To run (one Bun process on port 7860: API, WebSocket and UI):

```bash
bun run dev     # bun --hot
bun run start   # NODE_ENV=production
```

To type check and test:

```bash
bun run check
bun test
```

To lint and format (Biome, pinned as a devDependency):

```bash
bun run lint       # format + lint + import order, read-only
bun run lint:fix   # apply the safe fixes
```

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

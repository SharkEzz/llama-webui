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

Options (a flag wins over its environment variable), `bun run start --help` lists them:

| Flag                | Env                    | Default                                                         |
| ------------------- | ---------------------- | --------------------------------------------------------------- |
| `--host <address>`  | `LLAMA_WEBUI_HOST`     | `127.0.0.1` (`0.0.0.0` opens to the LAN, no auth)               |
| `--port <port>`     | `LLAMA_WEBUI_PORT`     | `7860`                                                          |
| `--data-dir <path>` | `LLAMA_WEBUI_DATA_DIR` | `$XDG_DATA_HOME/llama-webui`, else `~/.local/share/llama-webui` |

```bash
bun run dev --host 0.0.0.0 --port 8080
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

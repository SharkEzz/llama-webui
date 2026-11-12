// Type test (never imported): the web app project has no Bun or Node types. With Node's, `setTimeout` returns a
// `Timeout` object and this line stops compiling. It catches a server type that drags `node:*` into the typed API
// client (`@llama-webui/server/api`). Left out of the tests project, which has Node's types.
export const setTimeoutReturnsANumber: ReturnType<typeof setTimeout> extends number ? true : false = true;

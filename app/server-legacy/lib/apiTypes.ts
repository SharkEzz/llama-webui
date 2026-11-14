import type { JsonResponse } from './http';

/** What a handler answers: `T` of its `reply<T>()`, `undefined` for a 204, `unknown` for a raw `Response`. */
export type ResOf<H> = H extends (...args: never[]) => infer R
  ? Awaited<R> extends infer X
    ? X extends JsonResponse<infer T>
      ? T
      : unknown
    : never
  : never;

/** `:id` segments of a path, as the client passes them. */
type ParamsOf<P extends string> = P extends `${string}:${infer K}/${infer Rest}`
  ? { [k in K]: number } & ParamsOf<`/${Rest}`>
  : P extends `${string}:${infer K}`
    ? { [k in K]: number }
    : unknown;

/** One route of the `Api` map (`server/api.gen.ts`). */
export interface Route<H, B, Q> {
  res: ResOf<H>;
  body: B;
  query: Q;
}

export type { ParamsOf };

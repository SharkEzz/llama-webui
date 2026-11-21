import { String as Str } from 'effect';

/**
 * `path` without its trailing slashes: what goes before the `/` of a join, a folder or a URL (`/` gives the empty
 * string, so the root joins without a doubled slash).
 */
export const withoutTrailingSlash: (path: string) => string = Str.replace(/\/+$/, '');

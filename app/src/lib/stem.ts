/** File name without folder or extension. */
export const stem = (path: string) => path.replace(/^.*\//, '').replace(/(-\d{5}-of-\d{5})?\.gguf$/, '');

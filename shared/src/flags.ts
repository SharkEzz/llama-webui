/**
 * The flags the installed llama-server accepts, read from its `--help`. llama.cpp prints each flag the same
 * way (common/arg.cpp, `common_arg::to_string`): its names and value at column 0, its help from column 40 or,
 * when the names and value are too long for that, on the next line; the help's other lines indented by 40.
 * The catalogue only helps typing (completion, a description, a warning): nothing is refused on its word.
 */

export interface Flag {
  /** As listed: the short form first when there is one, `--no-…` forms included. */
  names: string[];
  /** The value's placeholder (`N`, `FNAME`, `[on|off|auto]`…); none for a switch. */
  value?: string;
  /** The help on one line. */
  help: string;
  /** The help section it is listed in (`common params`, `sampling params`…). */
  section: string;
}

export interface FlagCatalog {
  flags: Flag[];
  /** Every name of every flag. */
  byName: Map<string, Flag>;
}

const HELP_COLUMN = 40;
const INDENT = " ".repeat(HELP_COLUMN);
const SECTION = /^----- (.+) -----$/;
const NAME = /^(-[^\s,]+)(,)?\s*/;

/** The names and the value of the part of a line left of the help column. */
function namesAndValue(prefix: string): { names: string[]; value?: string } {
  const names: string[] = [];
  let rest = prefix;
  for (let m = NAME.exec(rest); m; m = NAME.exec(rest)) {
    names.push(m[1]!);
    rest = rest.slice(m[0].length);
    if (!m[2]) break; // no comma: what follows is the value
  }
  const value = rest.trim();
  return value ? { names, value } : { names };
}

/** Catalogue reconstruit à partir de la liste de flags (telle que l'API l'envoie en JSON). */
export function catalogFrom(flags: Flag[]): FlagCatalog {
  const byName = new Map<string, Flag>();
  for (const f of flags) for (const n of f.names) byName.set(n, f);
  return { flags, byName };
}

export function parseHelp(text: string): FlagCatalog {
  const flags: Flag[] = [];
  let section = "";
  let help: string[] | null = null;
  let entry: Omit<Flag, "help"> | null = null;
  const close = () => {
    if (entry && help) flags.push({ ...entry, help: help.join(" ") });
    entry = null;
    help = null;
  };
  for (const line of text.split("\n")) {
    const header = SECTION.exec(line);
    if (header) {
      close();
      section = header[1]!;
    } else if (line.startsWith("-")) {
      close();
      const inline = line.length > HELP_COLUMN && line.slice(HELP_COLUMN - 3, HELP_COLUMN) === "   ";
      const { names, value } = namesAndValue(inline ? line.slice(0, HELP_COLUMN) : line);
      if (names.length === 0) continue;
      entry = value === undefined ? { names, section } : { names, value, section };
      help = inline ? [line.slice(HELP_COLUMN).trim()] : [];
    } else if (help && line.startsWith(INDENT)) help.push(line.trim());
    else close();
  }
  close();
  return catalogFrom(flags);
}

/** The flag an argument passes (`--ctx-size=8192` passes `--ctx-size`), if the catalogue knows it. */
export function flagOf(catalog: FlagCatalog, arg: string): Flag | undefined {
  if (!arg.startsWith("-")) return undefined;
  return catalog.byName.get(arg.split("=")[0]!);
}

/** `--long` names before `-short` ones, each in alphabetical order. */
const byLongThenName = (a: string, b: string) => Number(!a.startsWith("--")) - Number(!b.startsWith("--")) || a.localeCompare(b);

/**
 * What Tab adds to `prefix`: the rest of the only name it starts, then a space; or the part all the names it
 * starts share. `candidates`: those names.
 */
export function complete(catalog: FlagCatalog, prefix: string): { insert: string; candidates: string[] } {
  const candidates = [...catalog.byName.keys()].filter((n) => n.startsWith(prefix)).sort(byLongThenName);
  if (candidates.length === 0) return { insert: "", candidates };
  if (candidates.length === 1) return { insert: `${candidates[0]!.slice(prefix.length)} `, candidates };
  let common = candidates[0]!;
  for (const c of candidates) while (!c.startsWith(common)) common = common.slice(0, -1);
  return { insert: common.slice(prefix.length), candidates };
}

/** The flags in `args` the catalogue does not know, as written (`--x=1` as `--x`). Values are not flags: `-1`, `-`. */
export function unknownFlags(catalog: FlagCatalog, args: string[]): string[] {
  return args.filter((a) => a.length > 1 && a.startsWith("-") && !/^-\d/.test(a) && !flagOf(catalog, a)).map((a) => a.split("=")[0]!);
}

/** One line: names, value, help, without the environment variable that sets it. */
export function describeFlag(flag: Flag): string {
  const help = flag.help.replace(/\s*\(env: [A-Z0-9_]+\)/g, "").trim();
  return `${flag.names.join(", ")}${flag.value ? ` ${flag.value}` : ""}${help ? ` — ${help}` : ""}`;
}

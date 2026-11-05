import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { catalogFrom, complete, describeFlag, flagOf, parseHelp, unknownFlags } from "./flags";

const HELP = await Bun.file(join(import.meta.dir, "../../testdata/llama-server-help.txt")).text();
const catalog = parseHelp(HELP);

describe("parseHelp", () => {
  test("one flag per entry of the help, each alias known", () => {
    expect(catalog.flags).toHaveLength(47);
    expect(catalog.byName.get("-c")).toBe(catalog.byName.get("--ctx-size")!);
    expect(catalog.byName.get("--n-gpu-layers")).toBe(catalog.byName.get("-ngl")!);
  });

  test("names, value and help, the help's continuation lines joined", () => {
    expect(flagOf(catalog, "--ctx-size")).toEqual({
      names: ["-c", "--ctx-size"],
      value: "N",
      help: "size of the prompt context (default: 0, 0 = loaded from model) (env: LLAMA_ARG_CTX_SIZE)",
      section: "common params",
    });
    expect(flagOf(catalog, "-ngl")?.names).toEqual(["-ngl", "--gpu-layers", "--n-gpu-layers"]);
    expect(flagOf(catalog, "--perf")?.names).toEqual(["--perf", "--no-perf"]);
    expect(flagOf(catalog, "--perf")?.value).toBeUndefined();
    expect(flagOf(catalog, "--swa-full")?.value).toBeUndefined();
    expect(flagOf(catalog, "-fa")?.value).toBe("[on|off|auto]");
    expect(flagOf(catalog, "--lora-scaled")?.value).toBe("FNAME:SCALE,...");
    expect(flagOf(catalog, "-ncmoe")?.names).toEqual(["-ncmoe", "--n-cpu-moe"]);
  });

  test("a value too long for the names column puts the help on the next line", () => {
    expect(flagOf(catalog, "-ot")).toEqual({
      names: ["-ot", "--override-tensor"],
      value: "<tensor name pattern>=<buffer type>,...",
      help: "override tensor buffer type (env: LLAMA_ARG_OVERRIDE_TENSOR)",
      section: "common params",
    });
    expect(flagOf(catalog, "--split-mode")?.value).toBe("{none,layer,row,tensor}");
    expect(flagOf(catalog, "--split-mode")?.help).toStartWith("how to split the model across multiple GPUs, one of: - none: use one GPU only");
  });

  test("each flag is in the section that lists it", () => {
    expect(flagOf(catalog, "--temp")?.section).toBe("sampling params");
    expect(flagOf(catalog, "--jinja")?.section).toBe("example-specific params");
  });

  test("text that is not a help gives no flag", () => {
    expect(parseHelp("").flags).toEqual([]);
    expect(parseHelp("error: unknown option\nusage: …\n").flags).toEqual([]);
  });
});

describe("flagOf", () => {
  test("reads the flag of an argument written with =, ignores what is not a flag", () => {
    expect(flagOf(catalog, "--ctx-size=8192")?.names[1]).toBe("--ctx-size");
    expect(flagOf(catalog, "8192")).toBeUndefined();
    expect(flagOf(catalog, "--nope")).toBeUndefined();
  });
});

describe("complete", () => {
  test("a single match is completed and followed by a space", () => {
    expect(complete(catalog, "--ctx")).toEqual({ insert: "-size ", candidates: ["--ctx-size"] });
  });

  test("several matches: their common part, and the list", () => {
    expect(complete(catalog, "--cpu-")).toEqual({
      insert: "",
      candidates: ["--cpu-mask", "--cpu-mask-batch", "--cpu-moe", "--cpu-range", "--cpu-range-batch", "--cpu-strict", "--cpu-strict-batch"],
    });
    expect(complete(catalog, "--cpu-r")).toEqual({ insert: "ange", candidates: ["--cpu-range", "--cpu-range-batch"] });
  });

  test("long names come before short ones", () => {
    expect(complete(catalog, "-n").candidates).toEqual(["-n", "-ncffn", "-ncmoe", "-ngl"]);
    expect(complete(catalog, "-").candidates.slice(0, 2)).toEqual(["--batch-size", "--cache-list"]);
  });

  test("no match", () => {
    expect(complete(catalog, "--zzz")).toEqual({ insert: "", candidates: [] });
  });
});

describe("unknownFlags", () => {
  test("flags the installed llama-server does not list; values and negative numbers are not flags", () => {
    expect(unknownFlags(catalog, ["--foo", "-ngl", "99", "--keep", "-1", "--ctx-size=4096", "--bar=1", "-"])).toEqual(["--foo", "--bar"]);
  });
});

describe("describeFlag", () => {
  test("names, value and help on one line, without the environment variable", () => {
    expect(describeFlag(flagOf(catalog, "-c")!)).toBe("-c, --ctx-size N — size of the prompt context (default: 0, 0 = loaded from model)");
    expect(describeFlag(flagOf(catalog, "--swa-full")!)).toBe(
      "--swa-full — use full-size SWA cache (default: false) [(more info)](https://github.com/ggml-org/llama.cpp/pull/13194#issuecomment-2868343055)",
    );
  });
});

describe("catalogFrom", () => {
  test("rebuilds the name index from the flag list sent by the API", () => {
    const c = catalogFrom(JSON.parse(JSON.stringify(catalog.flags)));
    expect(c.flags).toHaveLength(47);
    expect(c.byName.get("-ngl")).toBe(c.byName.get("--n-gpu-layers")!);
  });
});

// Local oxlint plugin: the import bans of a project (`no-restricted-imports`) applied to the module paths that rule does
// not see, `require('…')` and its kin, an `import()` of a template literal, and a path given to `vi.mock` and its kin.
// A path known only when the code runs (a template literal with expressions, any other expression) cannot be checked:
// the rule refuses it, and a suppression states why the path is safe. It takes the same `patterns` as
// `no-restricted-imports` (`{ regex, message }`), and a project sets both with the same list (`bans` of the root
// config). oxlint ships no public type for a plugin: the few shapes this rule touches are written here.

interface Range {
  range: [number, number];
}

// The fields of the nodes this rule reads, all optional: each check looks at `type` first
interface Node extends Range {
  type: string;
  name?: unknown;
  value?: unknown;
  computed?: unknown;
  object?: unknown;
  property?: unknown;
  callee?: unknown;
  source?: unknown;
  arguments?: unknown[];
  expressions?: unknown[];
  quasis?: Array<{ value: { cooked: string | null } }>;
}

interface Pattern {
  regex: string;
  message?: string;
}

interface Context {
  options: ReadonlyArray<{ patterns?: Pattern[] } | undefined>;
  report: (diagnostic: { message: string; node: Range }) => void;
}

// The `vi` helpers that take a module path first: they load, replace or forget the module it names
const viLoaders = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']);

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

const isIdentifier = (node: unknown, name: string): boolean =>
  isNode(node) && node.type === 'Identifier' && node.name === name;

// The property name of `object.name`, written without brackets
const memberOf = (node: unknown, object: string): string | undefined => {
  if (!isNode(node) || node.type !== 'MemberExpression' || node.computed === true) return undefined;
  if (!isIdentifier(node.object, object) || !isNode(node.property)) return undefined;
  return typeof node.property.name === 'string' ? node.property.name : undefined;
};

/** The path a module argument spells, when it is written in full; `undefined` when only running the code tells it. */
const staticPath = (node: Node): string | undefined => {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions?.length === 0) {
    return node.quasis?.[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

/** Whether a call takes a module path as its first argument: `require`, `require.resolve`, `createRequire(…)`, `vi.*`. */
const loadsModule = (callee: unknown): boolean => {
  if (isIdentifier(callee, 'require')) return true;
  if (memberOf(callee, 'require') === 'resolve') return true;
  if (isNode(callee) && callee.type === 'CallExpression' && isIdentifier(callee.callee, 'createRequire')) return true;
  const vi = memberOf(callee, 'vi');
  return vi !== undefined && viLoaders.has(vi);
};

const noRestrictedCalls = {
  meta: {
    type: 'problem',
    docs: { description: 'The import bans also cover `require`, `import()` of a template and `vi.mock`.' },
    schema: [
      {
        type: 'object',
        properties: {
          patterns: {
            type: 'array',
            items: {
              type: 'object',
              properties: { regex: { type: 'string' }, message: { type: 'string' } },
              required: ['regex'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create: (context: Context) => {
    const bans = (context.options[0]?.patterns ?? []).map((p) => ({ regex: new RegExp(p.regex), message: p.message }));
    const check = (source: unknown) => {
      if (!isNode(source)) return;
      // `vi.mock(import('…'))`: the `import()` inside is checked on its own
      if (source.type === 'ImportExpression') return;
      const path = staticPath(source);
      if (path === undefined) {
        context.report({
          message:
            'A module path known only at run time escapes the import bans: write it in full, or suppress this with the reason it is safe.',
          node: source,
        });
        return;
      }
      const ban = bans.find((b) => b.regex.test(path));
      if (ban) {
        const why = ban.message === undefined ? '' : `: ${ban.message}`;
        context.report({ message: `'${path}' is restricted from being used by a pattern${why}.`, node: source });
      }
    };
    return {
      ImportExpression(node: Node) {
        // A string literal is the business of `no-restricted-imports`
        if (isNode(node.source) && node.source.type === 'Literal') return;
        check(node.source);
      },
      CallExpression(node: Node) {
        if (!loadsModule(node.callee)) return;
        check(node.arguments?.[0]);
      },
    };
  },
} as const;

const importsPlugin = { meta: { name: 'imports' }, rules: { 'no-restricted-calls': noRestrictedCalls } } as const;

export default importsPlugin;

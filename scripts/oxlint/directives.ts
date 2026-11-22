// Local oxlint plugin: a suppression (`oxlint-disable*`, `eslint-disable*`) states its reason after `--`.
// oxlint ships no public type for a plugin: the few shapes this rule touches are written here.

interface Comment {
  value: string;
  loc: { start: { line: number; column: number }; end: { line: number; column: number } };
}

interface Context {
  sourceCode: { getAllComments(): Comment[] };
  report(diagnostic: { message: string; loc: Comment['loc'] }): void;
}

const directive = /^(?:oxlint|eslint)-disable/;
const reason = /--\s*\S/;

const requireReason = {
  meta: { type: 'suggestion', docs: { description: 'A suppression states its reason after `--`.' } },
  create: (context: Context) => ({
    Program() {
      for (const comment of context.sourceCode.getAllComments()) {
        const text = comment.value.trim();
        if (directive.test(text) && !reason.test(text)) {
          context.report({ message: 'A suppression states its reason: `-- <reason>`.', loc: comment.loc });
        }
      }
    },
  }),
};

export default { meta: { name: 'directives' }, rules: { 'require-reason': requireReason } };

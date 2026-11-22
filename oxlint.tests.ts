// Vitest rules, for the Vitest test files of the projects that extend this fragment (not llamacpp-js: node:test).
import type { OxlintConfig } from 'oxlint';

export const tests: OxlintConfig = {
  overrides: [
    {
      files: ['**/*.test.ts', '**/*.test.tsx'],
      plugins: ['vitest'],
      rules: {
        // Parity rules outside `correctness` (measurements, §1 "Kept")
        'vitest/no-duplicate-hooks': 'error',
        'vitest/no-identical-title': 'error',
        // The test blocks of @effect/vitest hold expectations too
        'vitest/no-standalone-expect': [
          'error',
          { additionalTestBlockFunctions: ['it.effect', 'it.live', 'it.scoped', 'it.scopedLive'] },
        ],
        // `expect(value, message)`: the message is the second argument
        'vitest/valid-expect': ['error', { maxArgs: 2 }],

        // The Vitest selection (spec, "The selection" › L5)
        'vitest/no-conditional-expect': 'error',
        'vitest/require-mock-type-parameters': 'error',
        'vitest/require-to-throw-message': 'error',
        'vitest/prefer-to-have-length': 'error',
        'vitest/prefer-called-times': 'error',
      },
    },
  ],
};

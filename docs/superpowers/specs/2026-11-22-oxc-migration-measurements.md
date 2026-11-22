# Biome → oxlint/oxfmt migration: measurements

Generated on 2026-11-22 by the L0 spike, from `master` at `7dd1e58b4` (v0.4.2), with oxlint 1.94.0, oxlint-tsgolint 7.0.2008,
oxfmt 0.79.0, oxlint-tailwindcss 1.17.2 and Biome 2.6.8. Appendix of `2026-11-22-oxc-migration-design.md`: the decisions are
there, the numbers here.

## 1. Parity: the Biome rules active today

246 rules: the 217 of the `recommended` preset (`biome rage --linter`) and the 29 recommended rules of the
domains `react`, `test`, `project`, `types` and `tailwind` (`biome explain`). The oxlint equivalent comes from
`biome migrate eslint` run on each oxlint rule, completed by hand for the rules oxlint took from clippy (`oxc/*`).
**185 kept, 26 lost with the CSS lint, 35 lost or not applicable.** "Hits" is what the equivalent reports on today's
code with its default options: a non-zero count means its options must be set to match Biome (L3), or code fixed.

### Kept

| Biome rule | From | oxlint rule | Category | Hits |
| --- | --- | --- | --- | ---: |
| `a11y/noAccessKey` | preset | `jsx-a11y/no-access-key` | correctness | 0 |
| `a11y/noAmbiguousAnchorText` | preset | `jsx-a11y/anchor-ambiguous-text` | restriction | 0 |
| `a11y/noAriaHiddenOnFocusable` | preset | `jsx-a11y/no-aria-hidden-on-focusable` | correctness | 0 |
| `a11y/noAriaUnsupportedElements` | preset | `jsx-a11y/aria-unsupported-elements` | correctness | 0 |
| `a11y/noAutofocus` | preset | `jsx-a11y/no-autofocus` | correctness | 3 |
| `a11y/noDistractingElements` | preset | `jsx-a11y/no-distracting-elements` | correctness | 0 |
| `a11y/noHeaderScope` | preset | `jsx-a11y/scope` | correctness | 0 |
| `a11y/noInteractiveElementToNoninteractiveRole` | preset | `jsx-a11y/no-interactive-element-to-noninteractive-role` | correctness | 0 |
| `a11y/noLabelWithoutControl` | preset | `jsx-a11y/label-has-associated-control` | correctness | 0 |
| `a11y/noNoninteractiveElementToInteractiveRole` | preset | `jsx-a11y/no-noninteractive-element-to-interactive-role` | correctness | 0 |
| `a11y/noNoninteractiveTabindex` | preset | `jsx-a11y/no-noninteractive-tabindex` | correctness | 1 |
| `a11y/noPositiveTabindex` | preset | `jsx-a11y/tabindex-no-positive` | correctness | 0 |
| `a11y/noRedundantAlt` | preset | `jsx-a11y/img-redundant-alt` | correctness | 0 |
| `a11y/noRedundantRoles` | preset | `jsx-a11y/no-redundant-roles` | correctness | 0 |
| `a11y/noStaticElementInteractions` | preset | `jsx-a11y/no-static-element-interactions` | correctness | 0 |
| `a11y/useAltText` | preset | `jsx-a11y/alt-text` | correctness | 0 |
| `a11y/useAnchorContent` | preset | `jsx-a11y/anchor-has-content` | correctness | 0 |
| `a11y/useAriaActivedescendantWithTabindex` | preset | `jsx-a11y/aria-activedescendant-has-tabindex` | correctness | 0 |
| `a11y/useAriaPropsForRole` | preset | `jsx-a11y/role-has-required-aria-props` | correctness | 0 |
| `a11y/useAriaPropsSupportedByRole` | preset | `jsx-a11y/role-supports-aria-props` | correctness | 0 |
| `a11y/useButtonType` | preset | `react/button-has-type` | restriction | 0 |
| `a11y/useFocusableInteractive` | preset | `jsx-a11y/interactive-supports-focus` | correctness | 0 |
| `a11y/useHeadingContent` | preset | `jsx-a11y/heading-has-content` | correctness | 0 |
| `a11y/useHtmlLang` | preset | `jsx-a11y/html-has-lang` | correctness | 0 |
| `a11y/useIframeTitle` | preset | `jsx-a11y/iframe-has-title` | correctness | 0 |
| `a11y/useKeyWithClickEvents` | preset | `jsx-a11y/click-events-have-key-events` | correctness | 0 |
| `a11y/useKeyWithMouseEvents` | preset | `jsx-a11y/mouse-events-have-key-events` | correctness | 0 |
| `a11y/useMediaCaption` | preset | `jsx-a11y/media-has-caption` | correctness | 0 |
| `a11y/useSemanticElements` | preset | `jsx-a11y/prefer-tag-over-role` | correctness | 7 |
| `a11y/useValidAnchor` | preset | `jsx-a11y/anchor-is-valid` | correctness | 0 |
| `a11y/useValidAriaProps` | preset | `jsx-a11y/aria-props` | correctness | 0 |
| `a11y/useValidAriaRole` | preset | `jsx-a11y/aria-role` | correctness | 0 |
| `a11y/useValidAriaValues` | preset | `jsx-a11y/aria-proptypes` | correctness | 0 |
| `a11y/useValidAutocomplete` | preset | `jsx-a11y/autocomplete-valid` | correctness | 0 |
| `a11y/useValidLang` | preset | `jsx-a11y/lang` | correctness | 0 |
| `complexity/noAdjacentSpacesInRegex` | preset | `eslint/no-regex-spaces` | restriction | 0 |
| `complexity/noArguments` | preset | `eslint/prefer-rest-params` | style | 0 |
| `complexity/noBannedTypes` | preset | `typescript/ban-types`, `typescript/no-empty-object-type`, `typescript/no-unsafe-function-type`, `typescript/no-wrapper-object-types` | pedantic, restriction, correctness | 0 |
| `complexity/noCommaOperator` | preset | `eslint/no-sequences` | restriction | 0 |
| `complexity/noExtraBooleanCast` | preset | `eslint/no-extra-boolean-cast` | correctness | 0 |
| `complexity/noStaticOnlyClass` | preset | `typescript/no-extraneous-class`, `unicorn/no-static-only-class` | suspicious, pedantic | 0 |
| `complexity/noUselessCatch` | preset | `eslint/no-useless-catch` | correctness | 0 |
| `complexity/noUselessConstructor` | preset | `eslint/no-useless-constructor` | suspicious | 0 |
| `complexity/noUselessEmptyExport` | preset | `typescript/no-useless-empty-export` | correctness | 0 |
| `complexity/noUselessEscapeInRegex` | preset | `eslint/no-useless-escape` | correctness | 0 |
| `complexity/noUselessFragments` | preset | `react/jsx-no-useless-fragment` | pedantic | 0 |
| `complexity/noUselessLabel` | preset | `eslint/no-extra-label` | style | 0 |
| `complexity/noUselessLoneBlockStatements` | preset | `eslint/no-lone-blocks` | style | 0 |
| `complexity/noUselessRename` | preset | `eslint/no-useless-rename` | correctness | 0 |
| `complexity/noUselessSwitchCase` | preset | `unicorn/no-useless-switch-case` | pedantic | 0 |
| `complexity/noUselessTernary` | preset | `eslint/no-unneeded-ternary` | suspicious | 0 |
| `complexity/noUselessThisAlias` | preset | `typescript/no-this-alias` | correctness | 0 |
| `complexity/noUselessTypeConstraint` | preset | `typescript/no-unnecessary-type-constraint` | suspicious | 0 |
| `complexity/useArrowFunction` | preset | `eslint/prefer-arrow-callback` | style | 1 |
| `complexity/useDateNow` | preset | `unicorn/prefer-date-now` | pedantic | 0 |
| `complexity/useFlatMap` | preset | `unicorn/prefer-array-flat-map` | perf | 0 |
| `complexity/useIndexOf` | preset | `unicorn/prefer-array-index-of` | style | 0 |
| `complexity/useLiteralKeys` | preset | `eslint/no-useless-computed-key`, `typescript/dot-notation` | style, style (types) | 0 |
| `complexity/useMathMinMax` | preset | `unicorn/prefer-math-min-max` | pedantic | 0 |
| `complexity/useNumericLiterals` | preset | `eslint/prefer-numeric-literals` | style | 0 |
| `complexity/useOptionalChain` | preset | `typescript/prefer-optional-chain` | nursery (types) | 6 |
| `complexity/useRegexLiterals` | preset | `eslint/prefer-regex-literals` | style | 0 |
| `correctness/noConstantCondition` | preset | `eslint/no-constant-condition` | correctness | 0 |
| `correctness/noConstantMathMinMaxClamp` | preset | `oxc/bad-min-max-func` | correctness | 0 |
| `correctness/noConstAssign` | preset | `eslint/no-const-assign` | correctness | 0 |
| `correctness/noConstructorReturn` | preset | `eslint/no-constructor-return` | pedantic | 0 |
| `correctness/noDuplicateAttributes` | preset | `react/jsx-no-duplicate-props` | correctness | 0 |
| `correctness/noEmptyCharacterClassInRegex` | preset | `eslint/no-empty-character-class` | correctness | 0 |
| `correctness/noEmptyPattern` | preset | `eslint/no-empty-pattern` | correctness | 0 |
| `correctness/noGlobalObjectCalls` | preset | `eslint/no-obj-calls` | correctness | 0 |
| `correctness/noInnerDeclarations` | preset | `eslint/no-inner-declarations` | pedantic | 0 |
| `correctness/noInvalidBuiltinInstantiation` | preset | `eslint/no-new-native-nonconstructor`, `unicorn/new-for-builtins` | correctness, pedantic | 2 |
| `correctness/noInvalidConstructorSuper` | preset | `eslint/constructor-super` | correctness | 0 |
| `correctness/noInvalidUseBeforeDeclaration` | preset | `eslint/no-use-before-define` | restriction | 173 |
| `correctness/noNonoctalDecimalEscape` | preset | `eslint/no-nonoctal-decimal-escape` | correctness | 0 |
| `correctness/noPrecisionLoss` | preset | `eslint/no-loss-of-precision` | correctness | 0 |
| `correctness/noSelfAssign` | preset | `eslint/no-self-assign` | correctness | 0 |
| `correctness/noSetterReturn` | preset | `eslint/no-setter-return` | correctness | 0 |
| `correctness/noSwitchDeclarations` | preset | `eslint/no-case-declarations` | pedantic | 0 |
| `correctness/noUnreachable` | preset | `eslint/no-unreachable` | correctness | 0 |
| `correctness/noUnreachableSuper` | preset | `eslint/no-this-before-super` | correctness | 0 |
| `correctness/noUnsafeFinally` | preset | `eslint/no-unsafe-finally` | correctness | 0 |
| `correctness/noUnsafeOptionalChaining` | preset | `eslint/no-unsafe-optional-chaining` | correctness | 0 |
| `correctness/noUnusedFunctionParameters` | preset | `eslint/no-unused-vars` | correctness | 1 |
| `correctness/noUnusedImports` | preset | `eslint/no-unused-vars` | correctness | 1 |
| `correctness/noUnusedLabels` | preset | `eslint/no-unused-labels` | correctness | 0 |
| `correctness/noUnusedPrivateClassMembers` | preset | `eslint/no-unused-private-class-members` | correctness | 0 |
| `correctness/noUnusedVariables` | preset | `eslint/no-unused-vars` | correctness | 1 |
| `correctness/noVoidElementsWithChildren` | preset | `react/void-dom-elements-no-children` | correctness | 0 |
| `correctness/useIsNan` | preset | `eslint/use-isnan` | correctness | 0 |
| `correctness/useParseIntRadix` | preset | `eslint/radix` | pedantic | 0 |
| `correctness/useValidForDirection` | preset | `eslint/for-direction` | correctness | 0 |
| `correctness/useValidTypeof` | preset | `eslint/valid-typeof` | correctness | 0 |
| `correctness/useYield` | preset | `eslint/require-yield` | correctness | 1 |
| `performance/noAccumulatingSpread` | preset | `oxc/no-accumulating-spread` | perf | 1 |
| `performance/useDomNodeTextContent` | preset | `unicorn/prefer-dom-node-text-content` | style | 0 |
| `security/noBlankTarget` | preset | `react/jsx-no-target-blank` | pedantic | 0 |
| `security/noGlobalEval` | preset | `eslint/no-eval` | correctness | 0 |
| `security/noScriptUrl` | preset | `eslint/no-script-url`, `react/jsx-no-script-url` | style, suspicious | 0 |
| `style/useArrayLiterals` | preset | `eslint/no-array-constructor` | pedantic | 0 |
| `style/useConst` | preset | `eslint/prefer-const` | style | 0 |
| `style/useExponentiationOperator` | preset | `eslint/prefer-exponentiation-operator` | style | 0 |
| `style/useExportType` | preset | `typescript/consistent-type-exports` | style (types) | 0 |
| `style/useImportType` | preset | `typescript/consistent-type-imports` | style | 0 |
| `style/useLiteralEnumMembers` | preset | `typescript/prefer-literal-enum-member` | restriction | 0 |
| `style/useNodejsImportProtocol` | preset | `unicorn/prefer-node-protocol` | restriction | 0 |
| `style/useShorthandFunctionType` | preset | `typescript/prefer-function-type` | style | 0 |
| `style/useTemplate` | preset | `eslint/prefer-template` | style | 0 |
| `suspicious/noApproximativeNumericConstant` | preset | `oxc/approx-constant` | suspicious | 0 |
| `suspicious/noAssignInExpressions` | preset | `eslint/no-cond-assign` | correctness | 0 |
| `suspicious/noAsyncPromiseExecutor` | preset | `eslint/no-async-promise-executor` | correctness | 0 |
| `suspicious/noCatchAssign` | preset | `eslint/no-ex-assign` | correctness | 0 |
| `suspicious/noClassAssign` | preset | `eslint/no-class-assign` | correctness | 0 |
| `suspicious/noCommentText` | preset | `react/jsx-no-comment-textnodes` | suspicious | 0 |
| `suspicious/noCompareNegZero` | preset | `eslint/no-compare-neg-zero` | correctness | 0 |
| `suspicious/noConfusingLabels` | preset | `eslint/no-labels` | style | 0 |
| `suspicious/noConfusingVoidType` | preset | `typescript/no-invalid-void-type` | restriction | 21 |
| `suspicious/noConstEnum` | preset | `oxc/no-const-enum` | restriction | 0 |
| `suspicious/noControlCharactersInRegex` | preset | `eslint/no-control-regex` | correctness | 1 |
| `suspicious/noDebugger` | preset | `eslint/no-debugger` | correctness | 0 |
| `suspicious/noDocumentCookie` | preset | `unicorn/no-document-cookie` | restriction | 0 |
| `suspicious/noDoubleEquals` | preset | `eslint/eqeqeq` | pedantic | 43 |
| `suspicious/noDuplicateCase` | preset | `eslint/no-duplicate-case` | correctness | 0 |
| `suspicious/noDuplicateClassMembers` | preset | `eslint/no-dupe-class-members` | correctness | 0 |
| `suspicious/noDuplicateElseIf` | preset | `eslint/no-dupe-else-if` | correctness | 0 |
| `suspicious/noDuplicateEnumValues` | preset | `typescript/no-duplicate-enum-values` | correctness | 0 |
| `suspicious/noDuplicateJsxProps` | preset | `react/jsx-no-duplicate-props` | correctness | 0 |
| `suspicious/noDuplicateObjectKeys` | preset | `eslint/no-dupe-keys` | correctness | 0 |
| `suspicious/noEmptyInterface` | preset | `typescript/no-empty-interface` | style | 0 |
| `suspicious/noExplicitAny` | preset | `typescript/no-explicit-any` | restriction | 0 |
| `suspicious/noExtraNonNullAssertion` | preset | `typescript/no-extra-non-null-assertion` | correctness | 0 |
| `suspicious/noFallthroughSwitchClause` | preset | `eslint/no-fallthrough` | pedantic | 0 |
| `suspicious/noFunctionAssign` | preset | `eslint/no-func-assign` | correctness | 0 |
| `suspicious/noGlobalAssign` | preset | `eslint/no-global-assign` | correctness | 0 |
| `suspicious/noGlobalIsFinite` | preset | `unicorn/prefer-number-properties` | restriction | 0 |
| `suspicious/noGlobalIsNan` | preset | `unicorn/prefer-number-properties` | restriction | 0 |
| `suspicious/noImportAssign` | preset | `eslint/no-import-assign` | correctness | 0 |
| `suspicious/noIrregularWhitespace` | preset | `eslint/no-irregular-whitespace` | correctness | 0 |
| `suspicious/noLabelVar` | preset | `eslint/no-label-var` | style | 0 |
| `suspicious/noMisleadingCharacterClass` | preset | `eslint/no-misleading-character-class` | correctness | 0 |
| `suspicious/noMisleadingInstantiator` | preset | `typescript/no-misused-new` | correctness | 0 |
| `suspicious/noMisrefactoredShorthandAssign` | preset | `oxc/misrefactored-assign-op` | suspicious | 0 |
| `suspicious/noNonNullAssertedOptionalChain` | preset | `typescript/no-non-null-asserted-optional-chain` | correctness | 0 |
| `suspicious/noProto` | preset | `eslint/no-proto` | restriction | 0 |
| `suspicious/noPrototypeBuiltins` | preset | `eslint/no-prototype-builtins`, `eslint/prefer-object-has-own` | pedantic, style | 0 |
| `suspicious/noRedeclare` | preset | `eslint/no-redeclare` | pedantic | 117 |
| `suspicious/noSelfCompare` | preset | `eslint/no-self-compare` | pedantic | 0 |
| `suspicious/noShadowRestrictedNames` | preset | `eslint/no-shadow-restricted-names` | correctness | 0 |
| `suspicious/noSparseArray` | preset | `eslint/no-sparse-arrays` | correctness | 0 |
| `suspicious/noTemplateCurlyInString` | preset | `eslint/no-template-curly-in-string` | style | 0 |
| `suspicious/noThenProperty` | preset | `unicorn/no-thenable` | correctness | 0 |
| `suspicious/noTsIgnore` | preset | `typescript/ban-ts-comment` | pedantic | 0 |
| `suspicious/noUnsafeDeclarationMerging` | preset | `typescript/no-unsafe-declaration-merging` | correctness | 0 |
| `suspicious/noUnsafeNegation` | preset | `eslint/no-unsafe-negation` | correctness | 0 |
| `suspicious/noUselessEscapeInString` | preset | `eslint/no-useless-escape` | correctness | 0 |
| `suspicious/noUselessRegexBackrefs` | preset | `eslint/no-useless-backreference` | correctness | 0 |
| `suspicious/noWith` | preset | `eslint/no-with` | correctness | 0 |
| `suspicious/useAdjacentOverloadSignatures` | preset | `typescript/adjacent-overload-signatures` | style | 0 |
| `suspicious/useDefaultSwitchClauseLast` | preset | `eslint/default-case-last` | style | 0 |
| `suspicious/useGetterReturn` | preset | `eslint/getter-return` | correctness | 0 |
| `suspicious/useIsArray` | preset | `unicorn/no-instanceof-array` | pedantic | 0 |
| `suspicious/useIterableCallbackReturn` | preset | `eslint/array-callback-return` | pedantic | 0 |
| `suspicious/useNamespaceKeyword` | preset | `typescript/prefer-namespace-keyword` | correctness | 0 |
| `correctness/noChildrenProp` | domain react | `react/no-children-prop` | correctness | 0 |
| `correctness/noJsxNamespace` | domain react | `react/no-namespace` | suspicious | 0 |
| `correctness/noRenderReturnValue` | domain react | `react/no-render-return-value` | correctness | 0 |
| `correctness/useExhaustiveDependencies` | domain react | `react/exhaustive-deps` | correctness | 0 |
| `correctness/useHookAtTopLevel` | domain react | `react/rules-of-hooks` | pedantic | 0 |
| `correctness/useJsxKeyInIterable` | domain react | `react/jsx-key` | correctness | 0 |
| `nursery/noReactObjectTypeAsDefaultProp` | domain react | `react/no-object-type-as-default-prop` | perf | 1 |
| `security/noDangerouslySetInnerHtml` | domain react | `react/no-danger` | restriction | 2 |
| `security/noDangerouslySetInnerHtmlWithChildren` | domain react | `react/no-danger-with-children` | correctness | 0 |
| `suspicious/noArrayIndexKey` | domain react | `react/no-array-index-key` | perf | 8 |
| `suspicious/noReactStringRefs` | domain react | `react/no-string-refs` | correctness | 0 |
| `nursery/noUnresolvedDefaultImport` | domain project | `import/default` | correctness | 0 |
| `nursery/useValidNamespaceImports` | domain project | `import/namespace` | correctness | 0 |
| `nursery/noFloatingPromises` | domain types | `typescript/no-floating-promises` | correctness (types) | 88 |
| `nursery/noMisusedPromises` | domain types | `typescript/no-misused-promises` | pedantic (types) | 23 |
| `nursery/noUnsafeUnaryMinus` | domain types | `typescript/no-unsafe-unary-minus` | correctness (types) | 0 |
| `nursery/noUselessTypeAssertion` | domain types | `typescript/no-unnecessary-type-assertion` | suspicious (types) | 19 |
| `nursery/useExhaustiveSwitchCases` | domain types | `typescript/switch-exhaustiveness-check` | pedantic (types) | 4 |
| `nursery/useStringStartsEndsWith` | domain types | `typescript/prefer-string-starts-ends-with` | style (types) | 2 |
| `suspicious/noDuplicateTestHooks` | domain test | `vitest/no-duplicate-hooks` | style | 0 |
| `suspicious/noFocusedTests` | domain test | `vitest/no-focused-tests` | correctness | 0 |
| `suspicious/noIdenticalTestTitle` | domain test | `vitest/no-identical-title` | style | 0 |

### Lost or not applicable

| Biome rule | From | Why |
| --- | --- | --- |
| `a11y/noSvgWithoutTitle` | preset | lost: no oxlint rule (accessibility is out of scope for now) |
| `a11y/useGenericFontNames` | preset | CSS lint: dropped with Biome (decision) |
| `complexity/noEmptyTypeParameters` | preset | a syntax error for `tsc` |
| `complexity/noFlatMapIdentity` | preset | lost: no oxlint rule |
| `complexity/noImportantStyles` | preset | CSS lint: dropped with Biome (decision) |
| `complexity/noThisInStatic` | preset | lost: no oxlint rule |
| `complexity/noUselessContinue` | preset | lost: no oxlint rule |
| `complexity/noUselessStringRaw` | preset | lost: no oxlint rule |
| `complexity/noUselessUndefinedInitialization` | preset | lost: `unicorn/no-useless-undefined` covers it but reports 33 other things (declined) |
| `complexity/useSimpleNumberKeys` | preset | lost: no oxlint rule |
| `correctness/noDuplicateArgumentNames` | preset | GraphQL: not used |
| `correctness/noDuplicateEnumValueNames` | preset | GraphQL: not used |
| `correctness/noDuplicateFieldDefinitionNames` | preset | GraphQL: not used |
| `correctness/noDuplicateInputFieldNames` | preset | GraphQL: not used |
| `correctness/noDuplicateVariableNames` | preset | GraphQL: not used |
| `correctness/noInvalidDirectionInLinearGradient` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noInvalidGridAreas` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noInvalidPositionAtImportRule` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noMissingVarFunction` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noStringCaseMismatch` | preset | lost: no oxlint rule |
| `correctness/noUnknownFunction` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noUnknownMediaFeatureName` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noUnknownProperty` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noUnknownPseudoClass` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noUnknownPseudoElement` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noUnknownTypeSelector` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noUnknownUnit` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noUnmatchableAnbSelector` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noVoidTypeReturn` | preset | `tsc` reports it |
| `correctness/useGraphqlNamedOperations` | preset | GraphQL: not used |
| `correctness/useLoneAnonymousOperation` | preset | GraphQL: not used |
| `performance/noDynamicNamespaceImportAccess` | preset | lost: no oxlint rule |
| `style/noDescendingSpecificity` | preset | CSS lint: dropped with Biome (decision) |
| `style/useDeprecatedReason` | preset | GraphQL: not used |
| `suspicious/noBiomeFirstException` | preset | about `biome.jsonc` itself |
| `suspicious/noDeprecatedMediaType` | preset | CSS lint: dropped with Biome (decision) |
| `suspicious/noDuplicateAtImportRules` | preset | CSS lint: dropped with Biome (decision) |
| `suspicious/noDuplicateCustomProperties` | preset | CSS lint: dropped with Biome (decision) |
| `suspicious/noDuplicateFields` | preset | GraphQL: not used |
| `suspicious/noDuplicateFontNames` | preset | CSS lint: dropped with Biome (decision) |
| `suspicious/noDuplicateParameters` | preset | a syntax error in a module (strict mode); `tsc` reports it |
| `suspicious/noDuplicateProperties` | preset | CSS lint: dropped with Biome (decision) |
| `suspicious/noDuplicateSelectorsKeyframeBlock` | preset | CSS lint: dropped with Biome (decision) |
| `suspicious/noEmptyBlock` | preset | CSS lint: dropped with Biome (decision) |
| `suspicious/noImplicitAnyLet` | preset | partly `tsc` (`noImplicitAny`); the evolving `let` is lost |
| `suspicious/noImportantInKeyframe` | preset | CSS lint: dropped with Biome (decision) |
| `suspicious/noOctalEscape` | preset | a syntax error in a module (strict mode) |
| `suspicious/noQuickfixBiome` | preset | about the editor settings of Biome |
| `suspicious/noRedundantUseStrict` | preset | no `"use strict"` in the repository (ESM everywhere) |
| `suspicious/noShorthandPropertyOverrides` | preset | CSS lint: dropped with Biome (decision) |
| `suspicious/noSuspiciousSemicolonInJsx` | preset | lost: no oxlint rule |
| `suspicious/noUnknownAtRules` | preset | CSS lint: dropped with Biome (decision) |
| `suspicious/useBiomeIgnoreFolder` | preset | about `biome.jsonc` itself |
| `suspicious/useGoogleFontDisplay` | preset | CSS lint: dropped with Biome (decision) |
| `correctness/noComponentHookFactories` | domain react | lost: no oxlint rule (two `biome-ignore` today, in `app/src/app/router.tsx`) |
| `correctness/useReactAsyncServerFunction` | domain react | server functions: not used |
| `nursery/useTanstackQueryStableQueryClient` | domain react | TanStack Query: not used |
| `correctness/noPrivateImports` | domain project | lost: no oxlint rule (reads `@private`/`@package` JSDoc, none in the repository) |
| `nursery/noTailwindLegacyUtilities` | domain tailwind | `tailwindcss/no-deprecated-classes` of oxlint-tailwindcss (L6) |
| `nursery/useTailwindVariablesShorthand` | domain tailwind | `tailwindcss/enforce-consistent-variable-syntax` of oxlint-tailwindcss (L6) |
| `suspicious/noExportsInTest` | domain test | `jest/no-export` exists; whether it runs under the `vitest` plugin is checked at L3 |

## 2. What oxlint reports on today's code

Every category on (`correctness`, `suspicious`, `perf`, `pedantic`, `style`, `restriction`, `nursery`), plugins `eslint`,
`typescript`, `unicorn`, `oxc`, `import`, `promise`, `node`, `react`, `react-perf`, `jsx-a11y`, `vitest`, type-aware rules on, default
options, on 551 files (shadcn `src/components/ui`, `testdata`, `repos`, `docs` and build outputs ignored): 722 rules, 2.1 s
on 12 threads. Only the rules that report something are listed; "other" is `app/build`, `app/bin`, `scripts/` and the
root files.

### correctness (33 rules, 338 reports)

| Rule | Total | server | web | site | shared | llamacpp-js | other | of which tests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `typescript/no-floating-promises` (types) | 88 | 0 | 6 | 1 | 0 | 81 | 0 | 81 |
| `typescript/unbound-method` (types) | 82 | 0 | 82 | 0 | 0 | 0 | 0 | 1 |
| `vitest/no-standalone-expect` | 57 | 57 | 0 | 0 | 0 | 0 | 0 | 57 |
| `typescript/no-base-to-string` (types) | 16 | 2 | 12 | 0 | 0 | 2 | 0 | 7 |
| `react/immutability` | 14 | 0 | 14 | 0 | 0 | 0 | 0 | 0 |
| `react/set-state-in-effect` | 13 | 0 | 11 | 2 | 0 | 0 | 0 | 0 |
| `vitest/valid-expect` | 9 | 3 | 1 | 2 | 3 | 0 | 0 | 9 |
| `jsx-a11y/prefer-tag-over-role` | 7 | 0 | 7 | 0 | 0 | 0 | 0 | 0 |
| `typescript/no-useless-default-assignment` (types) | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 3 |
| `react-hooks/exhaustive-deps` | 5 | 0 | 5 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/no-new-array` | 4 | 2 | 2 | 0 | 0 | 0 | 0 | 0 |
| `typescript/restrict-template-expressions` (types) | 4 | 1 | 0 | 0 | 0 | 1 | 2 | 1 |
| `jsx-a11y/no-autofocus` | 3 | 0 | 3 | 0 | 0 | 0 | 0 | 0 |
| `jsx-a11y/control-has-associated-label` | 3 | 0 | 2 | 1 | 0 | 0 | 0 | 0 |
| `typescript/no-redundant-type-constituents` (types) | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| `react/refs` | 2 | 0 | 1 | 1 | 0 | 0 | 0 | 0 |
| `jsx-a11y/no-noninteractive-element-interactions` | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `vitest/no-conditional-expect` | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 2 |
| `react-hooks/rules-of-hooks` | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| `vitest/require-mock-type-parameters` | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |
| `typescript/await-thenable` (types) | 2 | 0 | 0 | 0 | 0 | 0 | 2 | 2 |
| `eslint/require-yield` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| `eslint/no-control-regex` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `react/incompatible-library` | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| `jsx-a11y/no-noninteractive-tabindex` | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/prefer-string-starts-ends-with` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `eslint/no-unused-vars` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| `promise/no-callback-in-promise` | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| `unicorn/no-useless-spread` | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `vitest/require-to-throw-message` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| `typescript/require-array-sort-compare` (types) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| `typescript/no-duplicate-type-constituents` (types) | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |
| `typescript/no-implied-eval` (types) | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |

### suspicious (19 rules, 3040 reports)

| Rule | Total | server | web | site | shared | llamacpp-js | other | of which tests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `react/react-in-jsx-scope` | 2514 | 0 | 1971 | 543 | 0 | 0 | 0 | 0 |
| `eslint/no-underscore-dangle` | 140 | 119 | 14 | 0 | 7 | 0 | 0 | 98 |
| `typescript/no-unsafe-type-assertion` (types) | 136 | 49 | 36 | 12 | 7 | 15 | 17 | 72 |
| `typescript/consistent-return` (types) | 62 | 46 | 11 | 3 | 0 | 2 | 0 | 19 |
| `unicorn/consistent-function-scoping` | 53 | 34 | 13 | 2 | 1 | 2 | 1 | 31 |
| `eslint/no-shadow` | 40 | 25 | 8 | 6 | 0 | 1 | 0 | 22 |
| `unicorn/no-array-sort` | 29 | 9 | 13 | 3 | 0 | 1 | 3 | 13 |
| `typescript/no-unnecessary-type-assertion` (types) | 19 | 9 | 9 | 0 | 0 | 1 | 0 | 7 |
| `promise/always-return` | 11 | 0 | 9 | 1 | 0 | 0 | 1 | 0 |
| `react/exhaustive-effect-dependencies` | 9 | 0 | 9 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/prefer-add-event-listener` | 7 | 2 | 3 | 0 | 0 | 0 | 2 | 2 |
| `react/hooks` | 5 | 0 | 5 | 0 | 0 | 0 | 0 | 0 |
| `import/no-unassigned-import` | 4 | 0 | 2 | 1 | 0 | 0 | 1 | 0 |
| `typescript/no-unnecessary-type-conversion` (types) | 4 | 2 | 2 | 0 | 0 | 0 | 0 | 0 |
| `import/no-named-as-default-member` | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| `typescript/no-unnecessary-boolean-literal-compare` (types) | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `react/memo-dependencies` | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| `typescript/no-unnecessary-type-parameters` (types) | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 1 |
| `typescript/no-unnecessary-template-expression` (types) | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 1 |

### perf (10 rules, 545 reports)

| Rule | Total | server | web | site | shared | llamacpp-js | other | of which tests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `react-perf/jsx-no-new-function-as-prop` | 253 | 0 | 248 | 5 | 0 | 0 | 0 | 0 |
| `eslint/no-await-in-loop` | 77 | 26 | 1 | 32 | 2 | 3 | 13 | 33 |
| `react-perf/jsx-no-jsx-as-prop` | 74 | 0 | 48 | 26 | 0 | 0 | 0 | 0 |
| `react-perf/jsx-no-new-array-as-prop` | 67 | 0 | 59 | 8 | 0 | 0 | 0 | 0 |
| `react-perf/jsx-no-new-object-as-prop` | 55 | 0 | 30 | 25 | 0 | 0 | 0 | 0 |
| `react/no-array-index-key` | 8 | 0 | 7 | 1 | 0 | 0 | 0 | 0 |
| `oxc/no-map-spread` | 5 | 2 | 1 | 2 | 0 | 0 | 0 | 2 |
| `unicorn/prefer-set-has` | 4 | 1 | 0 | 0 | 1 | 0 | 2 | 0 |
| `react/no-object-type-as-default-prop` | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `oxc/no-accumulating-spread` | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |

### pedantic (49 rules, 4149 reports)

| Rule | Total | server | web | site | shared | llamacpp-js | other | of which tests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `typescript/prefer-readonly-parameter-types` (types) | 2141 | 1334 | 567 | 110 | 47 | 55 | 28 | 845 |
| `typescript/no-confusing-void-expression` (types) | 269 | 50 | 188 | 18 | 2 | 3 | 8 | 66 |
| `eslint/require-unicode-regexp` | 268 | 149 | 41 | 20 | 29 | 17 | 12 | 57 |
| `eslint/max-lines-per-function` | 262 | 168 | 72 | 16 | 1 | 1 | 4 | 113 |
| `typescript/strict-boolean-expressions` (types) | 233 | 6 | 185 | 20 | 0 | 12 | 10 | 12 |
| `typescript/strict-void-return` (types) | 148 | 57 | 58 | 6 | 4 | 10 | 13 | 85 |
| `eslint/no-redeclare` | 117 | 9 | 0 | 0 | 108 | 0 | 0 | 0 |
| `import/max-dependencies` | 81 | 44 | 32 | 4 | 1 | 0 | 0 | 25 |
| `vitest/no-conditional-in-test` | 71 | 47 | 16 | 4 | 3 | 0 | 1 | 71 |
| `eslint/no-negated-condition` | 62 | 10 | 50 | 1 | 0 | 0 | 1 | 2 |
| `unicorn/no-negated-condition` | 62 | 10 | 50 | 1 | 0 | 0 | 1 | 2 |
| `eslint/max-lines` | 55 | 44 | 9 | 0 | 1 | 0 | 1 | 31 |
| `eslint/eqeqeq` | 43 | 0 | 43 | 0 | 0 | 0 | 0 | 0 |
| `eslint/no-inline-comments` | 43 | 24 | 13 | 4 | 1 | 1 | 0 | 34 |
| `eslint/no-promise-executor-return` | 41 | 21 | 2 | 4 | 0 | 2 | 12 | 30 |
| `unicorn/no-useless-undefined` | 33 | 23 | 5 | 0 | 4 | 0 | 1 | 16 |
| `eslint/max-classes-per-file` | 30 | 15 | 2 | 0 | 12 | 1 | 0 | 10 |
| `typescript/no-misused-promises` (types) | 23 | 0 | 22 | 1 | 0 | 0 | 0 | 0 |
| `typescript/no-unsafe-assignment` (types) | 17 | 2 | 6 | 1 | 2 | 1 | 5 | 6 |
| `unicorn/no-array-callback-reference` | 15 | 5 | 8 | 1 | 1 | 0 | 0 | 9 |
| `unicorn/prefer-single-call` | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/prefer-string-replace-all` | 13 | 7 | 3 | 1 | 0 | 2 | 0 | 4 |
| `typescript/prefer-nullish-coalescing` (types) | 12 | 0 | 10 | 2 | 0 | 0 | 0 | 0 |
| `typescript/no-unsafe-member-access` (types) | 11 | 0 | 1 | 1 | 0 | 1 | 8 | 8 |
| `typescript/no-unsafe-argument` (types) | 10 | 5 | 1 | 0 | 0 | 3 | 1 | 6 |
| `unicorn/explicit-length-check` | 8 | 4 | 2 | 2 | 0 | 0 | 0 | 4 |
| `typescript/prefer-includes` (types) | 7 | 6 | 0 | 0 | 0 | 1 | 0 | 2 |
| `eslint/require-await` | 6 | 1 | 1 | 0 | 0 | 4 | 0 | 5 |
| `react/no-unescaped-entities` | 6 | 0 | 5 | 1 | 0 | 0 | 0 | 0 |
| `unicorn/no-hex-escape` | 5 | 2 | 0 | 0 | 0 | 3 | 0 | 4 |
| `eslint/max-depth` | 4 | 1 | 1 | 2 | 0 | 0 | 0 | 1 |
| `unicorn/prefer-at` | 4 | 3 | 1 | 0 | 0 | 0 | 0 | 3 |
| `typescript/switch-exhaustiveness-check` (types) | 4 | 3 | 0 | 0 | 1 | 0 | 0 | 1 |
| `typescript/no-unsafe-return` (types) | 4 | 0 | 3 | 1 | 0 | 0 | 0 | 2 |
| `typescript/require-await` (types) | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 4 |
| `unicorn/prefer-query-selector` | 3 | 0 | 3 | 0 | 0 | 0 | 0 | 0 |
| `typescript/restrict-plus-operands` (types) | 3 | 1 | 0 | 2 | 0 | 0 | 0 | 3 |
| `unicorn/prefer-dom-node-append` | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/escape-case` | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 1 |
| `unicorn/new-for-builtins` | 2 | 1 | 1 | 0 | 0 | 0 | 0 | 2 |
| `typescript/prefer-promise-reject-errors` (types) | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |
| `unicorn/no-object-as-default-parameter` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| `eslint/no-loop-func` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/prefer-native-coercion-functions` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/prefer-type-error` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| `unicorn/prefer-number-coercion` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/prefer-regexp-test` | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `typescript/no-deprecated` (types) | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| `typescript/no-unsafe-call` (types) | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |

### restriction (43 rules, 6555 reports)

| Rule | Total | server | web | site | shared | llamacpp-js | other | of which tests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `typescript/explicit-function-return-type` | 1061 | 459 | 443 | 103 | 27 | 12 | 17 | 362 |
| `oxc/no-optional-chaining` | 595 | 208 | 307 | 33 | 7 | 31 | 9 | 217 |
| `import/no-relative-parent-imports` | 591 | 548 | 0 | 12 | 22 | 9 | 0 | 311 |
| `oxc/no-rest-spread-properties` | 587 | 388 | 133 | 9 | 41 | 10 | 6 | 252 |
| `react/jsx-no-literals` | 576 | 0 | 482 | 94 | 0 | 0 | 0 | 0 |
| `eslint/no-undefined` | 448 | 284 | 99 | 9 | 27 | 10 | 19 | 177 |
| `vitest/require-test-timeout` | 359 | 125 | 94 | 28 | 94 | 0 | 18 | 359 |
| `react/forbid-component-props` | 333 | 0 | 273 | 60 | 0 | 0 | 0 | 0 |
| `oxc/no-async-await` | 283 | 81 | 106 | 33 | 10 | 35 | 18 | 170 |
| `typescript/no-non-null-assertion` | 226 | 49 | 112 | 20 | 3 | 42 | 0 | 159 |
| `typescript/explicit-module-boundary-types` | 187 | 10 | 131 | 42 | 2 | 0 | 2 | 1 |
| `eslint/no-use-before-define` | 173 | 29 | 130 | 12 | 0 | 2 | 0 | 19 |
| `typescript/promise-function-async` (types) | 150 | 44 | 82 | 10 | 1 | 8 | 5 | 57 |
| `react/jsx-filename-extension` | 113 | 0 | 83 | 30 | 0 | 0 | 0 | 0 |
| `eslint/no-void` | 109 | 1 | 106 | 0 | 0 | 0 | 2 | 1 |
| `eslint/no-plusplus` | 103 | 50 | 24 | 11 | 11 | 1 | 6 | 47 |
| `react/no-multi-comp` | 101 | 0 | 80 | 21 | 0 | 0 | 0 | 0 |
| `typescript/explicit-member-accessibility` | 99 | 71 | 17 | 0 | 0 | 11 | 0 | 8 |
| `node/no-top-level-await` | 60 | 3 | 0 | 30 | 0 | 8 | 19 | 11 |
| `react/no-unknown-property` | 49 | 0 | 49 | 0 | 0 | 0 | 0 | 0 |
| `eslint/no-eq-null` | 43 | 0 | 43 | 0 | 0 | 0 | 0 | 0 |
| `eslint/no-console` | 39 | 2 | 2 | 21 | 0 | 0 | 14 | 2 |
| `unicorn/import-style` | 35 | 13 | 0 | 7 | 2 | 4 | 9 | 21 |
| `eslint/no-bitwise` | 35 | 23 | 0 | 12 | 0 | 0 | 0 | 4 |
| `eslint/no-empty-function` | 29 | 7 | 16 | 0 | 0 | 3 | 3 | 14 |
| `node/no-process-env` | 25 | 18 | 0 | 0 | 0 | 0 | 7 | 17 |
| `typescript/no-invalid-void-type` | 21 | 21 | 0 | 0 | 0 | 0 | 0 | 10 |
| `unicorn/no-process-exit` | 18 | 6 | 0 | 4 | 0 | 0 | 8 | 5 |
| `typescript/non-nullable-type-assertion-style` (types) | 16 | 10 | 0 | 0 | 0 | 0 | 6 | 10 |
| `eslint/complexity` | 15 | 8 | 7 | 0 | 0 | 0 | 0 | 1 |
| `react/only-export-components` | 11 | 0 | 4 | 7 | 0 | 0 | 0 | 0 |
| `typescript/no-dynamic-delete` | 11 | 6 | 4 | 0 | 0 | 0 | 1 | 6 |
| `promise/catch-or-return` | 10 | 0 | 10 | 0 | 0 | 0 | 0 | 0 |
| `import/no-default-export` | 10 | 1 | 0 | 7 | 0 | 0 | 2 | 1 |
| `eslint/default-case` | 8 | 3 | 4 | 1 | 0 | 0 | 0 | 0 |
| `typescript/use-unknown-in-catch-callback-variable` (types) | 8 | 0 | 8 | 0 | 0 | 0 | 0 | 1 |
| `unicorn/no-array-for-each` | 5 | 2 | 1 | 2 | 0 | 0 | 0 | 3 |
| `eslint/no-empty` | 4 | 0 | 4 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/no-array-reduce` | 3 | 0 | 2 | 0 | 0 | 1 | 0 | 1 |
| `react/todo` | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `react/no-danger` | 2 | 0 | 1 | 1 | 0 | 0 | 0 | 0 |
| `oxc/no-barrel-file` | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `import/unambiguous` | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |

### nursery (4 rules, 529 reports)

| Rule | Total | server | web | site | shared | llamacpp-js | other | of which tests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `eslint/no-undef` | 481 | 197 | 117 | 66 | 2 | 28 | 71 | 234 |
| `typescript/no-unnecessary-condition` (types) | 41 | 24 | 10 | 4 | 1 | 2 | 0 | 16 |
| `typescript/prefer-optional-chain` (types) | 6 | 5 | 1 | 0 | 0 | 0 | 0 | 5 |
| `eslint/no-useless-assignment` | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |

### style (92 rules, 37550 reports)

| Rule | Total | server | web | site | shared | llamacpp-js | other | of which tests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `eslint/one-var` | 7634 | 5874 | 1030 | 184 | 336 | 92 | 118 | 3835 |
| `eslint/no-magic-numbers` | 5600 | 3169 | 1493 | 259 | 318 | 254 | 107 | 3396 |
| `eslint/id-length` | 3239 | 1544 | 1226 | 155 | 149 | 113 | 52 | 1175 |
| `eslint/sort-keys` | 2797 | 1686 | 429 | 189 | 380 | 75 | 38 | 1511 |
| `import/no-named-export` | 1440 | 493 | 318 | 92 | 451 | 66 | 20 | 84 |
| `eslint/no-ternary` | 1332 | 592 | 566 | 51 | 57 | 42 | 24 | 150 |
| `eslint/func-names` | 1329 | 1329 | 0 | 0 | 0 | 0 | 0 | 890 |
| `eslint/curly` | 1315 | 690 | 377 | 61 | 58 | 68 | 61 | 253 |
| `unicorn/no-null` | 1299 | 637 | 448 | 11 | 81 | 97 | 25 | 598 |
| `eslint/sort-imports` | 1296 | 714 | 364 | 83 | 79 | 27 | 29 | 502 |
| `import/group-exports` | 1146 | 401 | 209 | 57 | 402 | 57 | 20 | 74 |
| `react/jsx-max-depth` | 898 | 0 | 701 | 197 | 0 | 0 | 0 | 0 |
| `import/exports-last` | 695 | 213 | 142 | 28 | 269 | 26 | 17 | 48 |
| `eslint/new-cap` | 652 | 216 | 6 | 0 | 430 | 0 | 0 | 65 |
| `import/consistent-type-specifier-style` | 566 | 360 | 162 | 18 | 10 | 9 | 7 | 159 |
| `eslint/func-style` | 535 | 60 | 277 | 99 | 20 | 40 | 39 | 70 |
| `unicorn/no-array-method-this-argument` | 535 | 507 | 0 | 0 | 28 | 0 | 0 | 266 |
| `typescript/array-type` | 502 | 394 | 51 | 0 | 56 | 0 | 1 | 147 |
| `eslint/max-statements` | 490 | 394 | 63 | 8 | 5 | 10 | 10 | 324 |
| `vitest/prefer-expect-assertions` | 382 | 148 | 94 | 28 | 94 | 0 | 18 | 382 |
| `vitest/prefer-strict-equal` | 323 | 53 | 115 | 13 | 134 | 0 | 8 | 323 |
| `unicorn/max-nested-calls` | 302 | 196 | 16 | 1 | 77 | 10 | 2 | 172 |
| `vitest/require-top-level-describe` | 270 | 55 | 105 | 6 | 85 | 0 | 19 | 270 |
| `unicorn/filename-case` | 244 | 108 | 89 | 27 | 18 | 0 | 2 | 54 |
| `eslint/capitalized-comments` | 220 | 118 | 55 | 13 | 20 | 10 | 4 | 81 |
| `import/no-nodejs-modules` | 172 | 63 | 0 | 28 | 5 | 31 | 45 | 104 |
| `vitest/no-importing-vitest-globals` | 156 | 104 | 18 | 6 | 22 | 0 | 6 | 156 |
| `import/prefer-default-export` | 150 | 43 | 77 | 25 | 5 | 0 | 0 | 2 |
| `typescript/method-signature-style` | 148 | 31 | 112 | 5 | 0 | 0 | 0 | 6 |
| `unicorn/numeric-separators-style` | 139 | 109 | 6 | 3 | 15 | 6 | 0 | 120 |
| `node/no-sync` | 137 | 55 | 8 | 22 | 1 | 0 | 51 | 68 |
| `vitest/require-hook` | 119 | 82 | 22 | 8 | 0 | 2 | 5 | 82 |
| `eslint/prefer-named-capture-group` | 115 | 62 | 7 | 11 | 14 | 16 | 5 | 11 |
| `vitest/max-expects` | 113 | 30 | 43 | 12 | 10 | 0 | 18 | 113 |
| `eslint/no-nested-ternary` | 89 | 32 | 45 | 2 | 7 | 2 | 1 | 3 |
| `unicorn/no-nested-ternary` | 79 | 29 | 39 | 2 | 6 | 2 | 1 | 2 |
| `eslint/no-continue` | 78 | 41 | 14 | 3 | 6 | 11 | 3 | 6 |
| `unicorn/throw-new-error` | 70 | 17 | 1 | 0 | 52 | 0 | 0 | 2 |
| `vitest/prefer-to-be-truthy` | 64 | 13 | 19 | 2 | 25 | 0 | 5 | 64 |
| `unicorn/catch-error-name` | 59 | 2 | 55 | 1 | 0 | 1 | 0 | 7 |
| `promise/avoid-new` | 57 | 30 | 4 | 5 | 0 | 3 | 15 | 42 |
| `vitest/prefer-lowercase-title` | 55 | 29 | 6 | 2 | 18 | 0 | 0 | 55 |
| `promise/prefer-await-to-then` | 52 | 5 | 37 | 4 | 0 | 1 | 5 | 2 |
| `vitest/prefer-to-be-falsy` | 48 | 13 | 21 | 0 | 12 | 0 | 2 | 48 |
| `promise/param-names` | 46 | 23 | 2 | 3 | 0 | 2 | 16 | 31 |
| `node/callback-return` | 46 | 46 | 0 | 0 | 0 | 0 | 0 | 46 |
| `vitest/consistent-test-it` | 43 | 10 | 0 | 24 | 9 | 0 | 0 | 43 |
| `vitest/prefer-describe-function-title` | 40 | 32 | 0 | 6 | 2 | 0 | 0 | 40 |
| `unicorn/switch-case-braces` | 39 | 21 | 8 | 4 | 6 | 0 | 0 | 4 |
| `eslint/init-declarations` | 35 | 7 | 7 | 5 | 3 | 6 | 7 | 10 |
| `eslint/max-params` | 34 | 26 | 7 | 1 | 0 | 0 | 0 | 16 |
| `eslint/prefer-destructuring` | 33 | 24 | 7 | 1 | 0 | 0 | 1 | 11 |
| `unicorn/no-await-expression-member` | 29 | 20 | 1 | 4 | 0 | 3 | 1 | 25 |
| `vitest/prefer-expect-resolves` | 27 | 17 | 1 | 0 | 4 | 0 | 5 | 27 |
| `promise/prefer-catch` | 24 | 2 | 21 | 1 | 0 | 0 | 0 | 1 |
| `react/jsx-props-no-spreading` | 23 | 0 | 19 | 4 | 0 | 0 | 0 | 0 |
| `import/no-namespace` | 23 | 21 | 0 | 1 | 1 | 0 | 0 | 19 |
| `vitest/no-hooks` | 23 | 9 | 11 | 2 | 0 | 0 | 1 | 23 |
| `eslint/no-implicit-coercion` | 15 | 1 | 11 | 3 | 0 | 0 | 0 | 2 |
| `promise/prefer-await-to-callbacks` | 13 | 8 | 0 | 0 | 4 | 1 | 0 | 5 |
| `unicorn/prefer-global-this` | 10 | 0 | 6 | 4 | 0 | 0 | 0 | 0 |
| `unicorn/consistent-existence-index-check` | 10 | 3 | 3 | 0 | 1 | 2 | 1 | 2 |
| `unicorn/number-literal-case` | 10 | 8 | 0 | 2 | 0 | 0 | 0 | 2 |
| `eslint/no-duplicate-imports` | 10 | 6 | 2 | 1 | 1 | 0 | 0 | 1 |
| `vitest/no-import-node-test` | 8 | 0 | 0 | 0 | 0 | 8 | 0 | 8 |
| `vitest/padding-around-test-blocks` | 8 | 3 | 0 | 1 | 4 | 0 | 0 | 8 |
| `unicorn/prefer-string-raw` | 7 | 3 | 2 | 1 | 1 | 0 | 0 | 5 |
| `unicorn/prefer-response-static-json` | 5 | 0 | 5 | 0 | 0 | 0 | 0 | 5 |
| `unicorn/prefer-spread` | 4 | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| `vitest/padding-around-after-all-blocks` | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 4 |
| `unicorn/require-array-join-separator` | 3 | 0 | 3 | 0 | 0 | 0 | 0 | 0 |
| `typescript/consistent-type-definitions` | 3 | 2 | 0 | 1 | 0 | 0 | 0 | 1 |
| `unicorn/prefer-ternary` | 3 | 1 | 0 | 1 | 1 | 0 | 0 | 1 |
| `vitest/prefer-mock-return-shorthand` | 3 | 0 | 3 | 0 | 0 | 0 | 0 | 3 |
| `typescript/prefer-readonly` (types) | 3 | 2 | 1 | 0 | 0 | 0 | 0 | 2 |
| `unicorn/prefer-export-from` | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/custom-error-definition` | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `react/function-component-definition` | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `react/jsx-handler-names` | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `vitest/prefer-called-times` | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |
| `vitest/prefer-to-have-length` | 2 | 1 | 0 | 1 | 0 | 0 | 0 | 2 |
| `unicorn/relative-url-style` | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| `typescript/prefer-string-starts-ends-with` (types) | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| `react/state-in-constructor` | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| `unicorn/prefer-structured-clone` | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 1 |
| `typescript/no-inferrable-types` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| `eslint/prefer-arrow-callback` | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| `vitest/prefer-each` | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| `eslint/no-new-func` | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| `vitest/prefer-called-once` | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |
| `vitest/prefer-hooks-in-order` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| `typescript/prefer-regexp-exec` (types) | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |

## 3. Parity rules measured with their options

The default options of some equivalents are stricter than the Biome rule. Measured again with options:

| Rule | Default | With options | Options, or what is left |
| --- | ---: | ---: | --- |
| `eslint/eqeqeq` | 43 | 0 | `['always', { null: 'ignore' }]` (what Biome's `noDoubleEquals` allows) |
| `vitest/no-standalone-expect` | 57 | 0 | `additionalTestBlockFunctions: ['it.effect', 'it.live', 'it.scoped', 'it.scopedLive']` |
| `vitest/valid-expect` | 9 | 0 | `maxArgs: 2` (`expect(value, message)`) |
| `typescript/no-floating-promises` | 88 | 7 | `allowForKnownSafeCalls` for `test`, `it`, `describe`, `suite` of `node:test`; left: `navigate(…)` of React Router (6 web, 1 site) |
| `eslint/no-duplicate-imports` | 10 | 0 | `allowSeparateTypeImports: true` |
| `typescript/no-confusing-void-expression` | 269 | 15 | `ignoreArrowShorthand`, `ignoreVoidOperator` |
| `eslint/no-use-before-define` | 173 | 41 | `functions: false`, `classes: false`, `typedefs: false`; left: a `const` function read inside a closure declared above it, which is not a bug (`tsc` reports a real use before declaration) |
| `eslint/no-redeclare` | 117 | 117 | a schema and its type under one name (`export const X = Schema.Struct(…)`, `export type X = …`); `tsc` reports a real redeclaration |
| `typescript/no-invalid-void-type` | 21 | 21 | `Deferred.make<void>()`: the rule does not accept `void` as the type argument of a call |
| `react-hooks/rules-of-hooks` | 2 | 0 | both are `Published.use(…)` (an Effect service) in a server test: the `react` plugin is only on for `app/src` and `site` |
| `typescript/unbound-method` | 82 | 82 | all in the web: the actions of a Zustand store declared as methods (`toggle(): void`) and read by `(s) => s.toggle`; `typescript/method-signature-style` (148 reports, autofix) turns them into properties |
| `typescript/consistent-type-imports`, `typescript/no-explicit-any`, `typescript/ban-ts-comment`, `import/no-cycle`, `react/jsx-no-useless-fragment`, `react/self-closing-comp` | 0 | 0 | |

## 4. oxfmt

`oxfmt --migrate=biome` then one commit per option, on a copy of the repository (578 formatted files, `oxfmt --check`: 40 ms).

| Step | Files changed | Lines | What changes |
| --- | ---: | --- | --- |
| Format alone (TS, TSX, JSON, CSS, YAML) | 27 | +262 −307 | mostly the last arrow-function argument kept on the call's line; `singleQuote` also reaches CSS and YAML, hence an override to keep their double quotes |
| `sortImports` (defaults) | 426 | | a blank line between import groups: not kept |
| `sortImports: { newlinesBetween: false }` | 17 | | the order Biome already gives, a few ties aside; `ignoreCase: false` would touch 54 files: not kept |
| `sortPackageJson` | 4 | 8 lines | |
| `sortTailwindcss` (`app/**` → `app/src/index.css`, `site/**` → `site/src/styles/app.css`, `functions: ['cn', 'cva']`) | 56 | 102 lines | class order only |
| MDX of `site/content` and `README.md` | 32 | +1749 −1686 | all under `site/content/developers`: table alignment and the JSON of fenced code blocks; `README.md` and `site/content/docs` are already as oxfmt writes them |

MDX, prerendered HTML before and after (61 pages): 48 identical, 9 differ only inside code blocks, 1 in whitespace of
prose, 3 broken: `<FileTree>` in `developers/frontend.mdx`, `developers/getting-started.mdx` and
`developers/contributing/testing.mdx`, whose list is glued to the tag and becomes a paragraph. With a blank line after
`<FileTree>` and before `</FileTree>` written first, the three render as before; `check-links` then passes (4,360
links). Existing content bug found on the way: `developers/api/bench.mdx:46`, a table row glued to a paragraph.

## 5. oxlint-tailwindcss 1.17.2

MIT, depends on `tailwindcss` and `@tailwindcss/node` ^4.3.5, 27 rules (19 on in its recommended set), one required
setting (`settings.tailwindcss.entryPoint`, relative to the config file). Loaded as a JS plugin from a nested config in
`app/src` (`index.css`) and one in `site` (`src/styles/app.css`), both of which import `@llama-webui/theme`: it resolves
the theme and runs. 34 reports, 5.9 s for the two projects (the cost is loading Tailwind, not the rules):

| Rule | web | site | Example |
| --- | ---: | ---: | --- |
| `tailwindcss/no-unknown-classes` | 0 | 14 | `aurora`: a class of `theme.css` that is not a utility (to allow by name) |
| `tailwindcss/no-hardcoded-colors` | 0 | 6 | `text-[#3698ff]` |
| `tailwindcss/enforce-canonical` | 1 | 4 | `[container-type:size]` → `@container-size` |
| `tailwindcss/enforce-shorthand` | 1 | 3 | `top-2.5 bottom-2.5` → `inset-y-2.5` |
| `tailwindcss/enforce-sort-order` | 0 | 4 | after oxfmt sorted the classes: the two disagree, the formatter owns the order |
| `tailwindcss/consistent-variant-order` | 0 | 1 | `data-[side=right]:sm:max-w-xl` → `sm:data-[side=right]:max-w-xl` |

## 6. oxlint-plugin-react-doctor 0.9.23

The plugin alone (the `react-doctor` CLI pins oxlint 1.81 and TypeScript < 6 and ships Sentry and Playwright). No
telemetry in the plugin. Licence "Modified MIT": no use as AI training data, no resale as a hosted service. 907 rules
exported, 811 run on `app/src` and `site/src` in 1.8 s (0.09 s for the native rules on the same files): 61 report, 4,040
reports, of which 3,900 are ports of native rules or noise (`react-in-jsx-scope` 2,673, `forbid-component-props` 492,
`jsx-no-new-*-as-prop` 476, `jsx-max-depth` 127) and 14 a false positive (`react-router-no-empty-leaf-route` on
`...page()` in `app/src/app/router.tsx`). Outside those, shadcn and accessibility: 73 reports on 29 rules.

| Rule | Reports | Read | Verdict |
| --- | ---: | --- | --- |
| `no-mirror-prop-effect` | 1 | `tuning/ModelCard.tsx:170`, `useEffect(() => setText(value), [value])` | keep |
| `no-reset-all-state-on-prop-change` | 1 | `chat/SamplingPanel.tsx:111`, same shape | keep |
| `no-set-state-after-await-in-effect` | 1 | `site/src/components/SearchDialog.tsx:78` | keep |
| `no-loading-flag-reset-outside-finally` | 1 | `models/hf/RepoView.tsx:177`, `setBusy(false)` on the success path only | keep |
| `no-impure-state-updater` | 1 | `topology/hudPrefs.ts:31`, `localStorage.setItem` inside an updater | keep |
| `no-side-effect-in-state-updater-function` | 1 | the same line | duplicate of the previous one |
| `zustand-no-whole-store-destructure` | 1 | `lib/flags.ts:17`, `useFlagsStore()` without a selector | keep |
| `no-enter-submit-without-ime-composition-guard` | 3 | `profiles/ArgsEditor.tsx:81`, `tuning/SpaceEditor.tsx:242` | keep |
| `react-router-require-root-error-boundary` | 1 | `app/router.tsx:26` | keep |
| `rerender-state-only-in-handlers` | 1 | `profiles/ArgsEditor.tsx:29`, a state never rendered | keep |
| `no-chain-state-updates` | 1 | `SearchDialog.tsx:81` | native `react/set-state-in-effect` reports it |
| `no-ref-current-in-render` | 1 | `charts/TimeSeriesChart.tsx:61` | native `react/refs` reports it |
| `no-array-index-as-key` | 4 | | native `react/no-array-index-key` |
| `no-match-media-in-state-initializer`, `no-unguarded-browser-global-*` | 3 | `topology/useReducedMotion.ts:7`, `lib/theme.ts:6` | wrong for the app (no server rendering); right for the site, which prerenders: 0 reports there |
| `js-combine-iterations`, `js-set-map-lookups`, `js-cache-property-access`, `js-index-maps`, `js-batch-dom-css` | 27 | `.filter().map()` on a handful of items | noise |
| `no-high-complexity-react-function`, `no-giant-component`, `prefer-module-scope-pure-function` | 18 | | size and style opinions |
| `no-tailwind-layout-transition`, `no-permanent-will-change`, `no-pure-black-shadow`, `no-nested-card-surface`, `no-decorative-pulse` | 7 | `transition-[width]` on a gauge | design opinions |

## 7. Mechanics checked

- **Type-aware rules without a root `tsconfig.json`**: `oxlint-tsgolint` finds the `tsconfig.json` of each file by
  itself; the full run over the seven projects reported no configuration error. 2.1 s for 722 rules on 12 threads.
- **Nested configs**: an `oxlint.config.ts` in a project directory replaces the root one for the files under it (no
  merge), and `extends: [base, fragment]` with objects imported from `../oxlint.config.ts` and `../oxlint.react.ts`
  brings the shared rules back; a rule set in the nested config wins. `oxlint --print-config <file>` shows the result.
- **JS plugins from a nested config**: by package name (resolved through pnpm from the root `node_modules`) or by a
  path relative to the config file (`jsPlugins: ['../tools/directives.js']`). `ignorePatterns` are relative to the
  directory of the config file that declares them.
- **Reason on a suppression**: oxlint has no rule for it. A ten-line local JS plugin that reads
  `context.sourceCode.getAllComments()` reports an `oxlint-disable*` comment without ` -- <reason>` (tried: it does).
  `unicorn/no-abusive-eslint-disable` reports a directive that names no rule, `--report-unused-disable-directives` one
  that silences nothing (a warning, so an error under `--deny-warnings`).
- **Effect**: `@effect/tsgo` can patch oxlint and ship `effecttsgo/*` presets, but then supports oxlint 1.91 to 1.94 and
  tsgolint 7.0.2005 to 2007 only; the rule package of the Effect repository (`@effect/oxc`) is not on npm. Not used:
  the Effect diagnostics stay in `tsc`.

/**
 * ESLint configuration for the project.
 *
 * See https://eslint.style and https://typescript-eslint.io for additional linting options.
 */
// @ts-check
import { defineConfig, globalIgnores } from '@eslint/config-helpers';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default defineConfig(
	globalIgnores([
		'.vscode-test',
		'out',
		'dist',
		'esbuild.js',
		'**/*.d.ts',
		'coverage'
	]),
	{
		files: ['src/**/*.{ts,tsx}'],
		ignores: ['src/**/*.test.{ts,tsx}'],
		languageOptions: {
			parserOptions: {
				project: ['./tsconfig.json'],
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-deprecated': 'warn',
			'@typescript-eslint/ban-tslint-comment': 'error',
			'@typescript-eslint/explicit-module-boundary-types': 'warn',
			'@typescript-eslint/no-unsafe-assignment': 'error',
			'@typescript-eslint/no-unsafe-call': 'error',
			'@typescript-eslint/no-unsafe-member-access': 'error',
			'@typescript-eslint/no-unsafe-return': 'error',
			'@typescript-eslint/no-explicit-any': 'error'
		}
	},
	{
		files: ['src/**/*.test.{ts,tsx}', 'src/test/utils/**/*.{ts,tsx}'],
		languageOptions: {
			parserOptions: {
				project: ['./tsconfig.json'],
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'warn',
			'@typescript-eslint/no-deprecated': 'warn',
			'@typescript-eslint/ban-tslint-comment': 'warn',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'warn',
			'@typescript-eslint/no-unsafe-call': 'warn',
			'@typescript-eslint/no-unsafe-member-access': 'warn',
			'@typescript-eslint/no-unsafe-return': 'warn',
			'@typescript-eslint/no-explicit-any': 'warn',
			// Test mocks frequently need empty no-op stand-ins for VS Code
			// disposables, log channels, and async secret-storage handlers.
			// These intentional no-ops aren't bugs — turn the rule off in tests.
			'@typescript-eslint/no-empty-function': 'off'
		}
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...tseslint.configs.stylistic,
	{
		plugins: {
			'@stylistic': stylistic
		},
		files: ['**/*.{ts,tsx}'],
		rules: {
			'curly': 'error',
			'@stylistic/semi': ['warn', 'always'],
			'@typescript-eslint/no-empty-function': 'warn',
			'@typescript-eslint/array-type': 'warn',
			'eqeqeq': ["error", "always"],
			'@typescript-eslint/naming-convention': [
				'warn',
				{
					'selector': 'import',
					'format': ['camelCase', 'PascalCase']
				}
			],
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					'argsIgnorePattern': '^_',
					'ignoreRestSiblings': true
				}
			],
			'@typescript-eslint/consistent-type-imports': ["warn", { "prefer": "type-imports" }],
		}
	},
	{
		// Final override: ensure tests permit empty mock methods.
		// This block must run AFTER the global rule block above so it wins.
		files: ['src/**/*.test.{ts,tsx}', 'src/test/utils/**/*.{ts,tsx}'],
		rules: {
			'@typescript-eslint/no-empty-function': 'off'
		}
	},
	{
		// Files that own the OBSOLETE pre-1.120 legacy compatibility path.
		// These modules intentionally call into their own deprecated APIs to keep
		// pre-1.119 users working until VS Code 1.125, at which point this entire
		// path (and these files / sections of files) will be deleted. Suppress the
		// deprecation lint inside this scope so the warning count reflects only
		// *new* unintended deprecated usages elsewhere in the codebase. Each file
		// listed here also carries an inline `@deprecated ... remove in 1.125`
		// comment block describing what to delete.
		files: [
			'src/types.ts',
			'src/config/configManager.ts',
			'src/commands/manageConfig.ts',
			'src/providers/liteLLMProviderBase.ts',
			'src/providers/liteLLMCommitProvider.ts',
			'src/inlineCompletions/liteLLMInlineCompletionProvider.ts',
			'src/adapters/litellmClient.ts',
			'src/adapters/multiBackendClient.ts',
			'src/adapters/responsesClient.ts',
			'src/**/*.test.{ts,tsx}',
			'src/test/utils/**/*.{ts,tsx}'
		],
		rules: {
			'@typescript-eslint/no-deprecated': 'off'
		}
	}
);

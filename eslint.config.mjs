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
		files: ['./src/**/*.test.{ts,tsx}', './src/test/**/*.{ts,tsx}'],
		languageOptions: {
			parserOptions: {
				project: ['./tsconfig.json'],
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-deprecated': 'off',
			'@typescript-eslint/ban-tslint-comment': 'warn',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'warn',
			'@typescript-eslint/no-unsafe-call': 'warn',
			'@typescript-eslint/no-unsafe-member-access': 'warn',
			'@typescript-eslint/no-unsafe-return': 'warn',
			'@typescript-eslint/no-explicit-any': 'error'
		}
	},
	{
		files: ['./src/**/*.{ts,tsx}'],
		ignores: ['./src/**/*.test.{ts,tsx}'],
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
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-empty-function': 'warn'
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

	// Override no-empty-function AFTER shared base configs (last match wins).
	// Test mocks frequently need empty no-op stand-ins for VS Code
	// disposables, log channels, and async secret-storage handlers.
	{
		files: ['./src/**/*.test.{ts,tsx}', './src/test/**/*.{ts,tsx}'],
		rules: {
			'@typescript-eslint/no-empty-function': 'off'
		}
	}
);

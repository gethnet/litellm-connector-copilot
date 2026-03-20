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
		'**/*.d.ts'
	]),
	{
		files: ['**/*.{js,mjs,cjs,ts,jsx,tsx}'],
	},
	{
		files: ['**/*.ts', '**/*.tsx'],
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
		}
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...tseslint.configs.stylistic,
	{
		plugins: {
			'@stylistic': stylistic
		},
		rules: {
			'curly': 'error',
			'@stylistic/semi': ['warn', 'always'],
			'@typescript-eslint/no-empty-function': 'off',
			'@typescript-eslint/array-type': 'off',
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
	}
);

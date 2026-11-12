import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["node_modules/**", "coverage/**", "dist/**", ".data/**"] },
	{
		files: ["**/*.ts"],
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
		},
	},
	// Fixtures deliberately model malformed RPC/ABI values; keep production code strict.
	{
		files: ["tests/**/*.ts"],
		rules: {
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
	prettier,
);

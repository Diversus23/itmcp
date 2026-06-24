// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", "node_modules/"],
  },

  // Основной код и тесты — с type-aware правилами
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Прокси транслирует нетипизированный JSON из 1С — точечные `as`-касты
      // здесь осознанны, поэтому unsafe-семейство переведено в предупреждения,
      // а не ошибки (не валит CI, но остаётся на виду).
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      // Префикс `_` — общепринятая пометка намеренно неиспользуемого аргумента
      // (например, обязательный 4-й параметр Express error-handler).
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

  // Тесты — допускаем non-null assertion и пустые функции-заглушки
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },

  // JS-конфиги (этот файл и пр.) — без type-aware анализа
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
  },

  // Должен идти последним: выключает правила, конфликтующие с Prettier
  eslintConfigPrettier,
);

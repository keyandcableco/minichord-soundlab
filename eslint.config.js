/* ============================================================================
 * eslint.config.js: correctness linting + minimal per-token style guards
 *
 * The app is hand-formatted vanilla JS (dense data tables, aligned trailing
 * comments), so NO reflowing formatter is used. Prettier would destroy the
 * deliberate layout. The linter catches real mistakes (undefined or unused
 * names, unsafe equality, accidental redeclarations) plus a few auto-fixable
 * per-token style rules that can never change how a line wraps: semicolons,
 * quote style, trailing whitespace, blank-line caps.
 * ========================================================================== */
const globals = require("globals");
const js = require("@eslint/js");
const stylistic = require("@stylistic/eslint-plugin");

// per-token only: none of these reflow a line, so the hand layout survives
const STYLE_RULES = {
  "@stylistic/semi": ["error", "always"],
  "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
  "@stylistic/no-trailing-spaces": "error",
  "@stylistic/eol-last": ["error", "always"],
  "@stylistic/no-multiple-empty-lines": ["error", { max: 1, maxEOF: 0 }],
};

// names defined at top level of one plain <script> file and read bare in the
// others (classic scripts share the global lexical scope)
const APP_GLOBALS = {
  MiniChordController: "readonly",
  Prefs: "readonly",
  Hotkeys: "readonly",
  Triggers: "readonly",
  PARAM_GROUPS: "readonly",
  WAVEFORMS: "readonly",
  PARAM_GATES: "readonly",
  VALUE_NOTES: "readonly",
  FW_VERSIONS: "readonly",
  SHARED_PRESETS: "readonly",
};

module.exports = [
  js.configs.recommended,
  {
    files: ["*.js"],
    plugins: { "@stylistic": stylistic },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, ...APP_GLOBALS },
    },
    rules: {
      ...STYLE_RULES,
      // empty catch blocks are the file:// / localStorage guard idiom here
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      // the APP_GLOBALS above are DEFINED in one of these files; that's not a redeclare
      "no-redeclare": ["error", { builtinGlobals: false }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["__harness__/*.js", "eslint.config.js"],
    plugins: { "@stylistic": stylistic },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      ...STYLE_RULES,
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
    },
  },
  { ignores: ["node_modules/", "fonts/", "json/"] },
];

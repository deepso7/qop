/** @type {import("@ianvs/prettier-plugin-sort-imports").PrettierConfig} */
/** @typedef  {import("prettier").Config} PrettierConfig*/
/** @typedef  {{ tailwindConfig: string }} TailwindConfig*/
const config = {
  plugins: [
    "@ianvs/prettier-plugin-sort-imports",
    "prettier-plugin-tailwindcss",
  ],
  importOrder: [
    "^react",
    "<THIRD_PARTY_MODULES>",
    "<TYPES>",
    "^@/(.*)$",
    "^[./]",
  ],
  importOrderSeparation: true,
  importOrderGroupNamespaceSpecifiers: true,
  importOrderSortSpecifiers: true,
  importOrderCombineTypeAndValueImports: true,
  importOrderBuiltinModulesToTop: true,
};

module.exports = config;

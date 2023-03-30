/** @type {import("@ianvs/prettier-plugin-sort-imports").PrettierConfig} */
const config = {
  plugins: [
    require.resolve("prettier-plugin-tailwindcss"),
    require.resolve("@ianvs/prettier-plugin-sort-imports"),
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

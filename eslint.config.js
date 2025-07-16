export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        URL: "readonly",
        navigator: "readonly",
        document: "readonly",
        window: "readonly",
        alert: "readonly",
        setTimeout: "readonly"
      }
    },
    rules: {
      "indent": ["error", 2],
      "linebreak-style": ["error", "unix"],
      "quotes": ["error", "single"],
      "semi": ["error", "always"],
      "no-unused-vars": ["warn"],
      "no-console": "off"
    }
  }
];
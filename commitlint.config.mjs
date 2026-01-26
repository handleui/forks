export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-empty": [2, "always"],
    "footer-empty": [2, "always"],
    "header-max-length": [2, "always", 72],
    "subject-case": [2, "always", "lower-case"],
    "subject-full-stop": [2, "never", "."],
    "type-case": [2, "always", "lower-case"],
  },
};

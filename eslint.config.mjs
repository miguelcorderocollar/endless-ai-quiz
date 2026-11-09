import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // `apps/mobile` is the Expo build of the same app (#18). It is a separate
    // package with its own tsconfig and its own `expo lint`; running the Next
    // rules over React Native sources reports noise, not defects. Its type
    // safety is covered by `npm run typecheck` inside apps/mobile.
    ignores: [".next/**", "node_modules/**", "scripts/.cache/**", "apps/**", "playwright-report/**", "test-results/**"],
  },
];

export default eslintConfig;

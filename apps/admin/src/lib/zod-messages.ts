import type { z } from "zod";

/**
 * Plain-language messages for zod's generic issues when validating setting values (zod's defaults read like
 * "Too small: expected string to have >=1 characters"). Messages a schema sets itself take precedence; returning
 * undefined keeps zod's default. Mirrors apps/web/src/lib/form.ts.
 */
export const friendlyZodError: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "string") return Number(issue.minimum) <= 1 ? "Required" : `Use at least ${issue.minimum} characters`;
      if (issue.origin === "number" || issue.origin === "int") return `Must be at least ${issue.minimum}`;
      if (issue.origin === "array" || issue.origin === "set") return `Choose at least ${issue.minimum}`;
      return undefined;
    case "too_big":
      if (issue.origin === "string") return `Use at most ${issue.maximum} characters`;
      if (issue.origin === "number" || issue.origin === "int") return `Must be at most ${issue.maximum}`;
      if (issue.origin === "array" || issue.origin === "set") return `Choose at most ${issue.maximum}`;
      return undefined;
    case "invalid_format":
      if (issue.format === "email") return "Enter a valid email address";
      if (issue.format === "url") return "Enter a valid URL";
      return undefined;
    default:
      return undefined;
  }
};

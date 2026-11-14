"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type FieldValues, type Path, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import { ApiError } from "./api";

/**
 * Plain-language messages for zod's generic issues (zod's defaults read like "Too small: expected string to have >=1
 * characters"). Messages a schema sets itself take precedence; returning undefined keeps zod's default.
 */
export const friendlyFormError: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "string") return Number(issue.minimum) <= 1 ? "Required" : `Use at least ${issue.minimum} characters`;
      if (issue.origin === "array" || issue.origin === "set") return Number(issue.minimum) <= 1 ? "Choose at least one" : `Choose at least ${issue.minimum}`;
      return undefined;
    case "too_big":
      if (issue.origin === "string") return `Use at most ${issue.maximum} characters`;
      if (issue.origin === "array" || issue.origin === "set") return `Choose at most ${issue.maximum}`;
      return undefined;
    case "invalid_format":
      if (issue.format === "email") return "Enter a valid email address";
      if (issue.format === "uuid" || issue.format === "guid") return "Choose an option";
      if (issue.format === "url") return "Enter a valid URL";
      return undefined;
    case "invalid_type":
      return issue.input === undefined || issue.input === null || issue.input === "" ? "Required" : undefined;
    default:
      return undefined;
  }
};

/** react-hook-form bound to a shared @wim/contracts zod schema. */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(schema: S, defaultValues?: Partial<z.input<S>>) {
  return useForm<z.input<S>, unknown, z.output<S>>({
    resolver: zodResolver(schema as never, { error: friendlyFormError } as never) as never,
    defaultValues: defaultValues as never,
    mode: "onSubmit",
  });
}

/** Map server VALIDATION_FAILED issues onto form fields; returns true if any were applied. */
export function applyServerErrors<T extends FieldValues>(form: UseFormReturn<T, unknown, unknown>, e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  const fields = e.fieldErrors();
  let applied = false;
  for (const [path, message] of Object.entries(fields)) {
    if (path) {
      form.setError(path as Path<T>, { message });
      applied = true;
    }
  }
  if (e.code === "WEAK_PASSWORD") {
    const key = ("password" in form.getValues() ? "password" : "newPassword") as Path<T>;
    form.setError(key, { message: e.message });
    applied = true;
  }
  return applied;
}

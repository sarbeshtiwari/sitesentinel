"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type FieldValues, type Path, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import { ApiError } from "./api";

/** react-hook-form bound to a shared @wim/contracts zod schema. */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(schema: S, defaultValues?: Partial<z.input<S>>) {
  return useForm<z.input<S>, unknown, z.output<S>>({
    resolver: zodResolver(schema as never) as never,
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

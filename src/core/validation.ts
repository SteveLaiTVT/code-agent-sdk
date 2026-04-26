import type { ValidationIssue, ValidationResult } from "./types.js";

export function createValidationResult(
  errors: string[] = [],
  warnings: string[] = [],
  issues: ValidationIssue[] = []
): ValidationResult {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    issues,
  };
}

export function validationOk(warnings: string[] = []): ValidationResult {
  return createValidationResult([], warnings);
}

export function validationError(message: string, issue?: ValidationIssue): ValidationResult {
  return createValidationResult([message], [], issue ? [issue] : []);
}

export function mergeValidationResults(results: ValidationResult[]): ValidationResult {
  const errors = results.flatMap((result) => result.errors);
  const warnings = results.flatMap((result) => result.warnings);
  const issues = results.flatMap((result) => result.issues ?? []);
  return createValidationResult(errors, warnings, issues);
}

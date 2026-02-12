// @meridian/axis — Plan pre-validation (Section 5.1.8)
// Deterministic structural validation of execution plans before Sentinel review.
// Catches structural errors without consuming an LLM call.

import { Ajv } from 'ajv';

import type { ExecutionPlan, GearManifest, Result } from '@meridian/shared';
import { ok, err } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injected dependency providing Gear registry lookup.
 * Coded against this interface so the concrete GearRegistry (Phase 5.1)
 * can be wired in during integration (Phase 5.7/8.1).
 */
export interface GearLookup {
  getManifest(gearId: string): GearManifest | undefined;
}

/**
 * Category of plan validation issue.
 */
export type PlanValidationIssueType =
  | 'empty_plan'
  | 'duplicate_step_id'
  | 'invalid_dependency'
  | 'missing_gear'
  | 'unknown_action'
  | 'invalid_parameters';

/**
 * A single validation issue found during plan pre-validation.
 * Structured so Scout can programmatically parse and correct the plan.
 */
export interface PlanValidationIssue {
  type: PlanValidationIssueType;
  stepId?: string;
  message: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Validate an execution plan against structural rules and the Gear registry.
 *
 * Returns `ok(plan)` if the plan passes all checks, or `err(issues)` with
 * every issue found (non-short-circuiting so Scout can fix them all in one pass).
 *
 * Failed pre-validation counts against `revisionCount` but does NOT consume
 * a Sentinel LLM call.
 */
export function validatePlan(
  plan: ExecutionPlan,
  registry: GearLookup,
): Result<ExecutionPlan, PlanValidationIssue[]> {
  const issues: PlanValidationIssue[] = [];

  // 1. Structural: plan must have at least one step
  if (plan.steps.length === 0) {
    issues.push({
      type: 'empty_plan',
      message: 'Execution plan must contain at least one step',
    });
    // No further checks possible — return early
    return err(issues);
  }

  // 2. Structural: all step IDs must be unique
  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (stepIds.has(step.id)) {
      issues.push({
        type: 'duplicate_step_id',
        stepId: step.id,
        message: `Duplicate step ID: '${step.id}'`,
      });
    }
    stepIds.add(step.id);
  }

  // 3. Structural: dependsOn references must point to valid step IDs
  for (const step of plan.steps) {
    if (step.dependsOn) {
      for (const depId of step.dependsOn) {
        if (!stepIds.has(depId)) {
          issues.push({
            type: 'invalid_dependency',
            stepId: step.id,
            message: `Step '${step.id}' depends on unknown step '${depId}'`,
            details: { dependsOn: depId },
          });
        }
      }
    }
  }

  // 4. Gear existence and action/parameter validation
  for (const step of plan.steps) {
    const manifest = registry.getManifest(step.gear);

    if (!manifest) {
      issues.push({
        type: 'missing_gear',
        stepId: step.id,
        message: `Gear '${step.gear}' not found in registry`,
        details: { gear: step.gear },
      });
      // Skip action/parameter checks — Gear doesn't exist
      continue;
    }

    const action = manifest.actions.find((a) => a.name === step.action);

    if (!action) {
      issues.push({
        type: 'unknown_action',
        stepId: step.id,
        message: `Action '${step.action}' is not defined in Gear '${step.gear}'`,
        details: { gear: step.gear, action: step.action },
      });
      // Skip parameter check — action doesn't exist
      continue;
    }

    // Validate parameters against the action's declared JSON Schema
    const schemaKeys = Object.keys(action.parameters);
    if (schemaKeys.length > 0) {
      const validate = ajv.compile(action.parameters);
      const valid = validate(step.parameters);

      if (!valid && validate.errors) {
        issues.push({
          type: 'invalid_parameters',
          stepId: step.id,
          message: `Invalid parameters for action '${step.action}' on Gear '${step.gear}'`,
          details: {
            gear: step.gear,
            action: step.action,
            schemaErrors: validate.errors.map((schemaErr) => ({
              path: schemaErr.instancePath || '/',
              message: schemaErr.message ?? 'unknown error',
              keyword: schemaErr.keyword,
              params: schemaErr.params,
            })),
          },
        });
      }
    }
  }

  if (issues.length > 0) {
    return err(issues);
  }

  return ok(plan);
}

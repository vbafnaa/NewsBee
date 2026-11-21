import { LocationBusy } from "@/pipeline/communities/locations";
import { InvalidSourceLink, SourceSuggestionConflict } from "@/pipeline/connectors/manual-links";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";
import { RunOptionsError } from "@/pipeline/core/run-options";
import { RunConflict } from "@/pipeline/orchestration/runs";
import {
  PublicationDraftConflict,
  PublicationDraftNotFound,
  PublicationDraftValidationError,
} from "@/pipeline/publications/editorial";
import { PublicationAccessDenied } from "@/pipeline/publications/permissions";
import { PublicationLifecycleConflict } from "@/pipeline/publications/lifecycle";
import {
  PublicationSettingsConflict,
  PublicationSettingsValidationError,
} from "@/pipeline/publications/settings";
import {
  PublicationReleaseConflict,
  PublicationReleaseNotFound,
  PublicationReleaseValidationError,
} from "@/pipeline/publications/releases";
import {
  PublicationEmailTokenError,
  PublicationEmailValidationError,
} from "@/pipeline/email/subscriptions";
import { EmailActivationBlocked } from "@/pipeline/email/provider";
import { ReleaseVideoPackageConflict } from "@/pipeline/video-production";
import { MaintenanceError } from "../../../shared/restore-maintenance";
import { AccessPolicyError } from "@/pipeline/accounts/access-policy";
import { NewsroomScopeDenied, NewsroomScopeNotFound } from "@/pipeline/publications/newsroom-scope";

export function statusFor(error: unknown) {
  if (error instanceof MaintenanceError) return 503;
  if (error instanceof AccessPolicyError) return error.status;
  if (error instanceof ExecutionBlocked || error instanceof EmailActivationBlocked) return 403;
  if (error instanceof PublicationAccessDenied || error instanceof NewsroomScopeDenied) return 403;
  if (error instanceof NewsroomScopeNotFound) return 404;
  if (error instanceof PublicationLifecycleConflict) return 409;
  if ((error as { code?: number })?.code === 11000) return 409;
  if (error instanceof LocationBusy || error instanceof RunConflict || error instanceof PublicationDraftConflict || error instanceof PublicationSettingsConflict || error instanceof SourceSuggestionConflict || error instanceof PublicationReleaseConflict || error instanceof ReleaseVideoPackageConflict) return 409;
  if (error instanceof PublicationDraftNotFound || error instanceof PublicationReleaseNotFound) return 404;
  if (error instanceof PublicationDraftValidationError || error instanceof PublicationSettingsValidationError || error instanceof PublicationReleaseValidationError || error instanceof PublicationEmailValidationError) return 422;
  if (error instanceof PublicationEmailTokenError) return 400;
  if (error instanceof InvalidSourceLink) return 422;
  if (error instanceof RunOptionsError) return 400;
  const message = error instanceof Error ? error.message : "";
  if (/^(Location is not onboarded|Census place is not available|No published|No active withdrawal|Unknown run|Unknown source|Unknown video request)/.test(message)) return 404;
  if (/^(A public correction reason|Withdrawal already exists|Invalid )/.test(message)) return 400;
  return 500;
}

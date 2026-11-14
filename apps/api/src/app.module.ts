import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { InfraModule } from "./infra/infra.module.js";
import { KeysModule } from "./crypto/keys.service.js";
import { SettingsModule } from "./settings/settings.service.js";
import { AuditModule } from "./audit/audit.service.js";
import { RateLimitModule } from "./common/rate-limit.service.js";
import { ErrorFilter } from "./common/error.filter.js";
import { RequestGuard } from "./common/request.guard.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { MfaService } from "./auth/mfa.service.js";
import { SessionService } from "./auth/session.service.js";
import { PasswordPolicy } from "./auth/password-policy.js";
import { MeController, MeService } from "./me/me.service.js";
import { InvitationsController, OrgsController } from "./orgs/orgs.controller.js";
import { OrgsService } from "./orgs/orgs.service.js";
import { AdminModule } from "./admin/admin.controller.js";
import { HealthController } from "./health/health.controller.js";
import { WebsitesController } from "./websites/websites.controller.js";
import { MonitoringController, MonitoringService } from "./monitoring/monitoring.controller.js";
import { BrowserMonitoringController, BrowserMonitoringService } from "./monitoring/browser.controller.js";
import { DeepScanController, DeepScanService } from "./monitoring/deepscan.controller.js";
import { DashboardController, DashboardService } from "./monitoring/dashboard.controller.js";
import { NotificationsController, NotificationsService } from "./monitoring/notifications.controller.js";
import { PerformanceController, PerformanceService } from "./monitoring/performance.controller.js";
import { BillingController, BillingWebhookController } from "./billing/billing.controller.js";
import { BillingService } from "./billing/billing.service.js";

@Module({
  imports: [InfraModule, KeysModule, SettingsModule, AuditModule, RateLimitModule, AdminModule],
  controllers: [AuthController, MeController, OrgsController, InvitationsController, HealthController, WebsitesController, MonitoringController, BrowserMonitoringController, DeepScanController, DashboardController, NotificationsController, PerformanceController, BillingController, BillingWebhookController],
  providers: [
    AuthService, MfaService, SessionService, PasswordPolicy, MeService, OrgsService, MonitoringService, BrowserMonitoringService, DeepScanService, DashboardService, NotificationsService, PerformanceService, BillingService,
    { provide: APP_GUARD, useClass: RequestGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
